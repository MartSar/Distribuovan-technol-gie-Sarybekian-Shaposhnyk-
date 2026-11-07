import pool, { isNetworkOnline } from "./db/database.js";
import config from "./config.js";

// Súhrnný stav tohto uzla – zobrazuje sa na stavovom paneli a číta ho aj sused.
export async function getNodeStatus() {
  const [counts, lamport, outbox, peers, ops, digest] = await Promise.all([
    pool.query(`SELECT status, count(*)::int AS n FROM tickets GROUP BY status`),
    pool.query(`SELECT value::bigint AS v FROM node_state WHERE key = 'lamport'`),
    pool.query(
      `SELECT target_node, count(*) FILTER (WHERE sent_at IS NULL)::int AS pending,
              max(sent_at) AS last_sent_at
         FROM outbox GROUP BY target_node`,
    ),
    pool.query(`SELECT * FROM peer_status ORDER BY peer_id`),
    pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE origin_node = $1)::int AS local FROM operations`,
      [config.nodeId],
    ),
    // Odtlačok stavu – ak je na všetkých uzloch rovnaký, databázy sú zosynchronizované.
    pool.query(
      `SELECT left(md5(coalesce(string_agg(id || ':' || status || ':' || coalesce(activated_op::text, ''), ',' ORDER BY id), '')), 8) AS h
         FROM tickets`,
    ),
  ]);

  const byStatus = { valid: 0, used: 0, conflict: 0 };
  for (const r of counts.rows) byStatus[r.status] = r.n;

  const outboxByPeer = Object.fromEntries(outbox.rows.map((r) => [r.target_node, r]));

  return {
    nodeId: config.nodeId,
    nodeName: config.nodeName,
    publicUrl: config.publicUrl,
    network: (await isNetworkOnline()) ? "online" : "offline",
    lamport: Number(lamport.rows[0]?.v ?? 0),
    tickets: { ...byStatus, total: byStatus.valid + byStatus.used + byStatus.conflict },
    operations: ops.rows[0],
    digest: digest.rows[0].h,
    peers: peers.rows.map((p) => ({
      id: p.peer_id,
      reachable: p.reachable,
      lastOkAt: p.last_ok_at,
      lastError: p.last_error,
      totalSent: Number(p.total_sent),
      pending: outboxByPeer[p.peer_id]?.pending ?? 0,
    })),
    outboxPending: outbox.rows.reduce((s, r) => s + r.pending, 0),
    time: new Date().toISOString(),
  };
}
