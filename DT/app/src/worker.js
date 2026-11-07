import fs from "node:fs";
import config from "./config.js";
import log from "./logger.js";
import pool, { initDb, isNetworkOnline } from "./db/database.js";

/*
 * Synchronizačný worker (samostatný kontajner, rovnaký obraz ako API).
 * V cykle číta neodoslané operácie z outboxu a posiela ich susedom na POST /api/sync/ops.
 * Pri neúspechu ostávajú v outboxe (trvalo v DB) a pokus sa zopakuje s exponenciálnym backoffom.
 */

const HEARTBEAT_FILE = "/tmp/worker-heartbeat";
const backoff = Object.fromEntries(config.peers.map((p) => [p.id, { failures: 0, nextTry: 0 }]));
let wasOffline = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncPeer(peer) {
  const state = backoff[peer.id];
  if (Date.now() < state.nextTry) return;

  const { rows: ops } = await pool.query(
    `SELECT o.op_id, o.origin_node, o.type, o.ticket_id, o.payload, o.lamport, o.created_at
       FROM outbox x JOIN operations o ON o.op_id = x.op_id
      WHERE x.target_node = $1 AND x.sent_at IS NULL
      ORDER BY o.seq
      LIMIT $2`,
    [peer.id, config.syncBatchSize],
  );

  try {
    // Aj prázdna dávka slúži ako "ping" – zistíme, či je sused dostupný.
    const res = await fetch(`${peer.url}/api/sync/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: config.nodeId, ops }),
      signal: AbortSignal.timeout(config.peerTimeoutMs * 2),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();

    if (ops.length) {
      await pool.query(
        `UPDATE outbox SET sent_at = now(), attempts = attempts + 1, last_error = NULL
          WHERE target_node = $1 AND op_id = ANY($2::uuid[])`,
        [peer.id, body.ackOpIds],
      );
      log.info("sync sent", { peer: peer.id, count: ops.length, applied: body.applied, duplicates: body.duplicates });
    }
    if (state.failures > 0) log.info("sused opäť dostupný", { peer: peer.id });

    await pool.query(
      `UPDATE peer_status SET reachable = true, last_ok_at = now(), last_batch = $2::int,
              total_sent = total_sent + $2::int WHERE peer_id = $1`,
      [peer.id, ops.length],
    );
    state.failures = 0;
    state.nextTry = 0;
  } catch (err) {
    state.failures++;
    // Exponenciálny backoff: 1×, 2×, 4×, 8× interval, max. 10 s.
    const delay = Math.min(10000, config.syncIntervalMs * 2 ** Math.min(state.failures - 1, 3));
    state.nextTry = Date.now() + delay;

    if (ops.length) {
      await pool.query(
        `UPDATE outbox SET attempts = attempts + 1, last_error = $3
          WHERE target_node = $1 AND op_id = ANY($2::uuid[])`,
        [peer.id, ops.map((o) => o.op_id), err.message],
      );
    }
    await pool.query(
      `UPDATE peer_status SET reachable = false, last_error = $2, last_error_at = now() WHERE peer_id = $1`,
      [peer.id, err.message],
    );
    if (state.failures === 1 || state.failures % 10 === 0) {
      log.warn("sused nedostupný, operácie ostávajú v outboxe", {
        peer: peer.id,
        pending: ops.length,
        failures: state.failures,
        retry_in_ms: delay,
        error: err.message,
      });
    }
  }
}

async function loop() {
  await initDb();
  log.info("sync worker spustený", { peers: config.peers.map((p) => p.id), interval_ms: config.syncIntervalMs });

  for (;;) {
    try {
      // Heartbeat pre Docker healthcheck (unix čas v sekundách).
      fs.writeFileSync(HEARTBEAT_FILE, String(Math.floor(Date.now() / 1000)));

      if (!(await isNetworkOnline())) {
        if (!wasOffline) log.warn("uzol je odpojený – synchronizácia pozastavená");
        wasOffline = true;
        await pool.query(`UPDATE peer_status SET reachable = false, last_error = 'tento uzol je odpojený'`);
      } else {
        if (wasOffline) {
          log.info("uzol znovu pripojený – spúšťam synchronizáciu");
          for (const s of Object.values(backoff)) Object.assign(s, { failures: 0, nextTry: 0 });
        }
        wasOffline = false;
        await Promise.all(config.peers.map(syncPeer));
      }
    } catch (err) {
      log.error("chyba sync cyklu", { error: err.message });
    }
    await sleep(config.syncIntervalMs);
  }
}

process.env.COMPONENT = "worker";
loop();
