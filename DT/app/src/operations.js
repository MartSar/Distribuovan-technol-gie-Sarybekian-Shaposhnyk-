import crypto from "node:crypto";
import config from "./config.js";

/*
 * Replikácia je založená na operáciách (operation-based):
 *  - každá zmena = nemenná operácia s globálne unikátnym op_id (UUID),
 *  - lokálna operácia sa v JEDNEJ transakcii zapíše do žurnálu, aplikuje a pridá do outboxu,
 *  - prijatá operácia sa vloží s ON CONFLICT DO NOTHING → opakované doručenie nič nezmení,
 *  - stav lístka sa vždy prepočíta zo všetkých SCAN operácií deterministickým pravidlom,
 *    takže všetky uzly konvergujú k rovnakému stavu bez ohľadu na poradie doručenia.
 */

// --- Lamportove hodiny (perzistentné v node_state) ---------------------------

async function tickLocal(client) {
  const { rows } = await client.query(
    `UPDATE node_state SET value = (value::bigint + 1)::text WHERE key = 'lamport' RETURNING value::bigint AS v`,
  );
  return Number(rows[0].v);
}

async function tickReceive(client, remoteLamport) {
  await client.query(
    `UPDATE node_state SET value = (GREATEST(value::bigint, $1::bigint) + 1)::text WHERE key = 'lamport'`,
    [remoteLamport],
  );
}

// --- Deterministický prepočet stavu lístka -----------------------------------

// Víťazom je sken s najmenším (lamport, origin_node, op_id). Viac skenov = konflikt
// (lístok bol použitý na dvoch bránach počas výpadku siete).
export async function recomputeTicket(client, ticketId) {
  const { rows: scans } = await client.query(
    `SELECT op_id, origin_node, lamport, created_at
       FROM operations
      WHERE type = 'SCAN' AND ticket_id = $1
      ORDER BY lamport, origin_node, op_id`,
    [ticketId],
  );
  const winner = scans[0];
  const status = scans.length === 0 ? "valid" : scans.length === 1 ? "used" : "conflict";
  await client.query(
    `UPDATE tickets
        SET status = $2, scan_count = $3,
            activated_op = $4, activated_node = $5, activated_at = $6, activated_lamport = $7
      WHERE id = $1`,
    [
      ticketId,
      status,
      scans.length,
      winner?.op_id ?? null,
      winner?.origin_node ?? null,
      winner?.created_at ?? null,
      winner?.lamport ?? null,
    ],
  );
  return status;
}

// Aplikovanie operácie na lokálny stav (spoločné pre lokálne aj prijaté operácie).
async function applyOperation(client, op) {
  if (op.type === "ISSUE") {
    await client.query(
      `INSERT INTO tickets (id, holder, category, issued_by, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [op.ticket_id, op.payload.holder, op.payload.category || "Standard", op.origin_node, op.created_at],
    );
  }
  // Pri ISSUE aj SCAN prepočítame stav – SCAN mohol prísť skôr než ISSUE.
  await recomputeTicket(client, op.ticket_id);
}

async function insertOperation(client, op) {
  const { rowCount } = await client.query(
    `INSERT INTO operations (op_id, origin_node, type, ticket_id, payload, lamport, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (op_id) DO NOTHING`,
    [op.op_id, op.origin_node, op.type, op.ticket_id, op.payload, op.lamport, op.created_at],
  );
  return rowCount === 1;
}

// --- Lokálne operácie --------------------------------------------------------

export async function createLocalOperation(client, type, ticketId, payload = {}) {
  const op = {
    op_id: crypto.randomUUID(),
    origin_node: config.nodeId,
    type,
    ticket_id: ticketId,
    payload,
    lamport: await tickLocal(client),
    created_at: new Date().toISOString(),
  };
  await insertOperation(client, op);
  // Outbox pre každého suseda – trvalo uložené, prežije reštart aj výpadok.
  for (const peer of config.peers) {
    await client.query(`INSERT INTO outbox (op_id, target_node) VALUES ($1, $2)`, [op.op_id, peer.id]);
  }
  await applyOperation(client, op);
  return op;
}

// Simulované skenovanie lístka na bráne tohto uzla.
export async function scanTicket(client, ticketId) {
  const { rows } = await client.query(`SELECT * FROM tickets WHERE id = $1 FOR UPDATE`, [ticketId]);
  const ticket = rows[0];

  if (!ticket) {
    await client.query(`INSERT INTO scan_log (ticket_id, result) VALUES ($1, 'UNKNOWN')`, [ticketId]);
    return { result: "UNKNOWN", ticketId };
  }
  if (ticket.status !== "valid") {
    const detail = `už aktivovaný na bráne ${ticket.activated_node}`;
    await client.query(`INSERT INTO scan_log (ticket_id, result, detail) VALUES ($1, 'ALREADY_USED', $2)`, [
      ticketId,
      detail,
    ]);
    return { result: "ALREADY_USED", ticketId, ticket };
  }

  const op = await createLocalOperation(client, "SCAN", ticketId, { gate: config.nodeId });
  await client.query(`INSERT INTO scan_log (ticket_id, result, op_id) VALUES ($1, 'ACCEPTED', $2)`, [
    ticketId,
    op.op_id,
  ]);
  const { rows: after } = await client.query(`SELECT * FROM tickets WHERE id = $1`, [ticketId]);
  return { result: "ACCEPTED", ticketId, ticket: after[0], op };
}

// Predaj nového lístka na tomto uzle (replikuje sa ako ISSUE).
export async function issueTicket(client, holder, category) {
  const id = `${config.nodeId}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const op = await createLocalOperation(client, "ISSUE", id, { holder, category });
  return { id, op };
}

// --- Prijaté operácie od suseda ---------------------------------------------

export async function receiveOperation(client, op) {
  const inserted = await insertOperation(client, op);
  if (!inserted) return false; // duplicita → idempotentne ignorujeme
  await tickReceive(client, op.lamport);
  await applyOperation(client, op);
  return true;
}
