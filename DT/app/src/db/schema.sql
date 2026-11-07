-- Schéma jedného uzla. Každý uzol má vlastnú databázu s rovnakou štruktúrou.

-- Lokálny stav uzla: Lamportove hodiny a simulované odpojenie od siete.
CREATE TABLE IF NOT EXISTS node_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO node_state (key, value) VALUES ('lamport', '0')  ON CONFLICT DO NOTHING;
INSERT INTO node_state (key, value) VALUES ('network', 'online') ON CONFLICT DO NOTHING;

-- Aktuálny stav vstupeniek (materializovaný z operácií).
CREATE TABLE IF NOT EXISTS tickets (
  id              TEXT PRIMARY KEY,
  holder          TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'Standard',
  issued_by       TEXT,                      -- NULL = predpredaný lístok (seed)
  status          TEXT NOT NULL DEFAULT 'valid'
                  CHECK (status IN ('valid', 'used', 'conflict')),
  scan_count      INT  NOT NULL DEFAULT 0,
  activated_op    UUID,
  activated_node  TEXT,
  activated_at    TIMESTAMPTZ,
  activated_lamport BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Žurnál všetkých operácií (lokálnych aj prijatých). op_id zaručuje idempotenciu.
CREATE TABLE IF NOT EXISTS operations (
  seq          BIGSERIAL UNIQUE,
  op_id        UUID PRIMARY KEY,
  origin_node  TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('ISSUE', 'SCAN')),
  ticket_id    TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  lamport      BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,          -- čas vzniku na pôvodnom uzle
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operations_ticket_idx ON operations (ticket_id, type);

-- Trvalá fronta neodoslaných operácií – jeden riadok na operáciu a cieľový uzol.
CREATE TABLE IF NOT EXISTS outbox (
  op_id        UUID NOT NULL REFERENCES operations(op_id),
  target_node  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  PRIMARY KEY (op_id, target_node)
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (target_node) WHERE sent_at IS NULL;

-- Lokálny záznam pokusov o skenovanie (aj odmietnutých) – nereplikuje sa.
CREATE TABLE IF NOT EXISTS scan_log (
  id          BIGSERIAL PRIMARY KEY,
  ticket_id   TEXT NOT NULL,
  result      TEXT NOT NULL,                 -- ACCEPTED | ALREADY_USED | UNKNOWN
  op_id       UUID,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stav spojenia so susednými uzlami (zapisuje sync worker).
CREATE TABLE IF NOT EXISTS peer_status (
  peer_id        TEXT PRIMARY KEY,
  reachable      BOOLEAN NOT NULL DEFAULT false,
  last_ok_at     TIMESTAMPTZ,
  last_error     TEXT,
  last_error_at  TIMESTAMPTZ,
  last_batch     INT NOT NULL DEFAULT 0,
  total_sent     BIGINT NOT NULL DEFAULT 0
);
