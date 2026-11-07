import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import config from "../config.js";
import log from "../logger.js";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new Pool({ ...config.db, max: 10 });

pool.on("error", (error) => {
  log.error("PostgreSQL pool error", { error: error.message });
});

// Predpredané lístky – rovnaké na všetkých uzloch (deterministický seed).
const FIRST = ["Ján", "Mária", "Peter", "Zuzana", "Martin", "Lucia", "Tomáš", "Katarína", "Michal", "Eva"];
const LAST = ["Novák", "Horváth", "Kováč", "Varga", "Tóth", "Nagy", "Baláž", "Szabó", "Molnár", "Lukáč"];
const CATEGORIES = ["Standard", "Standard", "Standard", "VIP", "Backstage"];

function seedTickets(count) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 3 + 1) % LAST.length];
    return {
      id: `T-${String(n).padStart(3, "0")}`,
      holder: `${first} ${last}`,
      category: CATEGORIES[i % CATEGORIES.length],
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Počká na databázu, vytvorí schému a naplní lístky. API aj worker to volajú pri štarte,
// advisory lock zabráni súbehu migrácií.
export async function initDb() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (err) {
      if (attempt >= 60) throw err;
      log.warn("Databáza nie je dostupná, čakám…", { attempt, error: err.message });
      await sleep(1000);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(42)");
    const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await client.query(sql);

    for (const t of seedTickets(config.seedTickets)) {
      await client.query(
        `INSERT INTO tickets (id, holder, category) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [t.id, t.holder, t.category],
      );
    }
    for (const p of config.peers) {
      await client.query(`INSERT INTO peer_status (peer_id) VALUES ($1) ON CONFLICT DO NOTHING`, [p.id]);
    }
    log.info("Databáza pripravená", { db: config.db.database });
  } finally {
    await client.query("SELECT pg_advisory_unlock(42)").catch(() => {});
    client.release();
  }
}

// Pomocník na transakcie.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function isNetworkOnline() {
  const { rows } = await pool.query(`SELECT value FROM node_state WHERE key = 'network'`);
  return rows[0]?.value !== "offline";
}

export default pool;
