import config from "./config.js";

// Štruktúrované JSON logy na stdout – Docker ich zbiera a Dozzle/Loki ich zobrazí centrálne.
function write(level, msg, extra = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    node_id: config.nodeId,
    component: process.env.COMPONENT || "api",
    msg,
    ...extra,
  };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(line));
}

const log = {
  info: (msg, extra) => write("info", msg, extra),
  warn: (msg, extra) => write("warn", msg, extra),
  error: (msg, extra) => write("error", msg, extra),
};

export default log;
