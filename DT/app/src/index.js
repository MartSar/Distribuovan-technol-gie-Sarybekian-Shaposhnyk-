import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import routes from "./routes/api.routes.js";
import config from "./config.js";
import log from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", routes);

// Stavový panel (statické HTML)
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api", (req, res) => {
  res.json({ message: "GateSync node is running", nodeId: config.nodeId });
});

// Centrálne spracovanie chýb
app.use((err, req, res, next) => {
  log.error("request failed", { path: req.path, error: err.message });
  res.status(500).json({ error: err.message });
});

export default app;
