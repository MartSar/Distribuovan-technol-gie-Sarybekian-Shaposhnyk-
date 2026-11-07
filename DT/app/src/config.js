import dotenv from "dotenv";

// Lokálne (bez Dockeru) sa načíta .env, v kontajneri prídu premenné z docker-compose.
dotenv.config({ quiet: true });

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// PEERS formát: "B=http://api-b:3000,C=http://api-c:3000"
const peers = list(process.env.PEERS).map((entry) => {
  const [id, url] = entry.split("=");
  return { id: id.trim(), url: url.trim().replace(/\/$/, "") };
});

const config = {
  nodeId: process.env.NODE_ID || "X",
  nodeName: process.env.NODE_NAME || `Brána ${process.env.NODE_ID || "X"}`,
  port: Number(process.env.PORT || 3000),
  // Adresa panela z pohľadu prehliadača (napr. http://localhost:3002) – na prelinkovanie uzlov.
  publicUrl: process.env.PUBLIC_URL || "",
  peers,
  db: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || "gatesync",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
  },
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 2000),
  syncBatchSize: Number(process.env.SYNC_BATCH_SIZE || 100),
  peerTimeoutMs: Number(process.env.PEER_TIMEOUT_MS || 1500),
  seedTickets: Number(process.env.SEED_TICKETS || 40),
};

export default config;
