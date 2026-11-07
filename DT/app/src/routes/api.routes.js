import express from "express";
import pool, { tx, isNetworkOnline } from "../db/database.js";
import config from "../config.js";
import log from "../logger.js";
import { scanTicket, issueTicket, receiveOperation } from "../operations.js";
import { getNodeStatus } from "../status.js";

const router = express.Router();

// Obal pre async handlery – chyby pošle do error middleware.
const h = (fn) => (req, res, next) => fn(req, res).catch(next);

// --- Health check (Docker HEALTHCHECK) ---------------------------------------
router.get(
  "/health",
  h(async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", nodeId: config.nodeId, db: "up" });
    } catch (err) {
      res.status(503).json({ status: "error", nodeId: config.nodeId, db: "down", error: err.message });
    }
  }),
);

// --- Stav uzla (číta ho aj susedný uzol) -------------------------------------
router.get(
  "/status",
  h(async (req, res) => {
    // Simulované odpojenie: susedia nás nevidia, lokálny panel áno (?local=1).
    if (!req.query.local && !(await isNetworkOnline())) {
      return res.status(503).json({ error: "node offline (simulated partition)" });
    }
    res.json(await getNodeStatus());
  }),
);

// Stav celého klastra: vlastný stav + dopyt na /status všetkých susedov.
router.get(
  "/cluster",
  h(async (req, res) => {
    const self = await getNodeStatus();
    const online = self.network === "online";

    const peers = await Promise.all(
      config.peers.map(async (peer) => {
        if (!online) return { nodeId: peer.id, url: peer.url, reachable: false, error: "tento uzol je odpojený" };
        try {
          const r = await fetch(`${peer.url}/api/status`, { signal: AbortSignal.timeout(config.peerTimeoutMs) });
          if (r.status === 503) throw new Error("uzol je odpojený od siete");
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return { ...(await r.json()), url: peer.url, reachable: true };
        } catch (err) {
          return { nodeId: peer.id, url: peer.url, reachable: false, error: err.message };
        }
      }),
    );

    res.json({ self: { ...self, reachable: true }, peers });
  }),
);

// --- Lístky ------------------------------------------------------------------
router.get(
  "/tickets",
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT t.*,
              (SELECT json_agg(json_build_object('op_id', o.op_id, 'node', o.origin_node,
                                                 'lamport', o.lamport, 'at', o.created_at)
                               ORDER BY o.lamport, o.origin_node, o.op_id)
                 FROM operations o WHERE o.type = 'SCAN' AND o.ticket_id = t.id) AS scans
         FROM tickets t
        ORDER BY t.activated_at DESC NULLS LAST, t.id`,
    );
    res.json({
      expected: rows.filter((t) => t.status === "valid"),
      activated: rows.filter((t) => t.status === "used"),
      conflicts: rows.filter((t) => t.status === "conflict"),
    });
  }),
);

router.get(
  "/tickets/:id",
  h(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM tickets WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "ticket not found" });
    res.json(rows[0]);
  }),
);

// Simulácia čítačky: POST /api/scan { ticketId }
router.post(
  "/scan",
  h(async (req, res) => {
    const ticketId = String(req.body?.ticketId || "").trim().toUpperCase();
    if (!ticketId) return res.status(400).json({ error: "ticketId is required" });

    const result = await tx((client) => scanTicket(client, ticketId));
    log.info("scan", { ticket_id: ticketId, result: result.result, op_id: result.op?.op_id });

    const code = { ACCEPTED: 201, ALREADY_USED: 409, UNKNOWN: 404 }[result.result];
    res.status(code).json(result);
  }),
);

// Predaj nového lístka: POST /api/tickets { holder, category }
router.post(
  "/tickets",
  h(async (req, res) => {
    const holder = String(req.body?.holder || "").trim();
    const category = String(req.body?.category || "Standard").trim();
    if (!holder) return res.status(400).json({ error: "holder is required" });

    const result = await tx((client) => issueTicket(client, holder, category));
    log.info("issue", { ticket_id: result.id, op_id: result.op.op_id });
    res.status(201).json(result);
  }),
);

// Posledné udalosti pre panel.
router.get(
  "/events",
  h(async (req, res) => {
    const [scans, ops] = await Promise.all([
      pool.query(`SELECT * FROM scan_log ORDER BY id DESC LIMIT 15`),
      pool.query(
        `SELECT op_id, origin_node, type, ticket_id, lamport, created_at, received_at
           FROM operations ORDER BY seq DESC LIMIT 15`,
      ),
    ]);
    res.json({ scans: scans.rows, operations: ops.rows });
  }),
);

// --- Replikácia ---------------------------------------------------------------
// Sused posiela dávku operácií. Opakované doručenie je bezpečné (idempotentné).
router.post(
  "/sync/ops",
  h(async (req, res) => {
    if (!(await isNetworkOnline())) {
      return res.status(503).json({ error: "node offline (simulated partition)" });
    }
    const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
    for (const op of ops) {
      if (!op.op_id || !op.origin_node || !op.type || !op.ticket_id || op.lamport == null || !op.created_at) {
        return res.status(400).json({ error: "invalid operation", op });
      }
    }

    let applied = 0;
    await tx(async (client) => {
      for (const op of ops) {
        if (await receiveOperation(client, op)) applied++;
      }
    });

    const duplicates = ops.length - applied;
    if (ops.length) log.info("sync received", { from: req.body.from, count: ops.length, applied, duplicates });
    res.json({ received: ops.length, applied, duplicates, ackOpIds: ops.map((o) => o.op_id) });
  }),
);

// --- Administrácia: simulované odpojenie uzla od siete --------------------------
router.post(
  "/admin/network",
  h(async (req, res) => {
    const online = Boolean(req.body?.online);
    await pool.query(`UPDATE node_state SET value = $1 WHERE key = 'network'`, [online ? "online" : "offline"]);
    log.warn(online ? "uzol pripojený k sieti" : "uzol odpojený od siete (simulácia)");
    res.json({ network: online ? "online" : "offline" });
  }),
);

export default router;
