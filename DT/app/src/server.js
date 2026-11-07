import app from "./index.js";
import config from "./config.js";
import log from "./logger.js";
import { initDb } from "./db/database.js";

await initDb();

app.listen(config.port, () => {
  log.info("API uzla spustené", {
    port: config.port,
    peers: config.peers.map((p) => `${p.id}=${p.url}`),
  });
});
