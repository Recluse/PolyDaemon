// Shared helper for tg-bridge hooks. Finds THIS claude's channel plugin and
// returns its HTTP target ({host, port, auth_token, workspace_name, cwd, pid}),
// or null if no plugin is attached (→ standalone claude, native flow).
//
// Source of truth: the LOCAL registry ~/.tg-bridge-channel/instances.json that
// every plugin writes for its co-located hooks (src/local-registry.ts). Plain
// JSON, no SQLite — works on any Node, and on a ROAMING device (where the plugin
// registers with the bot over HTTP and never writes bot.db) it's the ONLY local
// source. Falls back to the shared bot.db (~/.tg-copilot-bridge/bot.db) for
// backward-compat during rollout / older plugins that haven't written the JSON.
//
// Match order (same for both sources):
//   1. Window UID, when available, identifies the exact owner.
//   2. Deepest cwd match within the same agent; parent PID breaks ties.
//      Codex windows share an app-server PID, so PID alone is not an identity.
//   3. A unique parent match handles tools run outside their workspace.
//
// Only rows with a fresh heartbeat (< HEARTBEAT_FRESH_SECONDS) count.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const HEARTBEAT_FRESH_SECONDS = 45;
const LOCAL_REGISTRY_PATH = path.join(os.homedir(), ".tg-bridge-channel", "instances.json");
const DB_PATH = path.join(os.homedir(), ".tg-copilot-bridge", "bot.db");

// Comparison form of a path: lowercase + normalize separators so "C:/x" and
// "C:\x" (and drive-letter case) agree.
function cmpForm(p) {
  return String(p || "").replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
}

function rowToTarget(row) {
  return {
    host: String(row.host || "127.0.0.1"),
    port: Number(row.port),
    auth_token: String(row.auth_token || ""),
    workspace_name: String(row.workspace_name || ""),
    cwd: String(row.cwd || ""),
    pid: Number(row.pid),
  };
}

// Given an array of fresh rows (each with cwd/parent_pid), pick the one for THIS
// agent: window uid, deepest cwd match, then an unambiguous parent fallback.
function matchRow(rows, cwd, {
  parentPid = process.ppid,
  windowUid = process.env.TG_WINDOW_UID,
  agent = process.env.TG_BRIDGE_AGENT || (process.env.CODEX_THREAD_ID ? "codex" : "claude"),
} = {}) {
  // A plugin whose parent is gone (parent_pid re-stamped to 1) is an orphan that
  // still heartbeats; it answers for no window.
  rows = rows.filter((r) => {
    if (r.parent_pid != null && Number(r.parent_pid) <= 1) return false;
    if (!r.cwd || path.dirname(r.cwd) === r.cwd) return false;
    const name = String(r.instance_name || r.workspace_name || "");
    const kind = /-(opencode|codex|mimo)$/i.exec(name)?.[1].toLowerCase() || "claude";
    return agent === kind;
  });
  // The launcher gives each window a TG_WINDOW_UID that its hooks inherit and its
  // plugin records — exact even when two windows share a folder, where the cwd
  // match below can only guess by the freshest heartbeat.
  const uid = windowUid;
  if (uid) return rows.find((r) => r.window_uid === uid) || null;
  const byParent = rows.filter((r) => Number(r.parent_pid) === parentPid);
  // A row's cwd can be a junction/symlink (a workspace that is another folder
  // under a second name) while Claude hands the hook the RESOLVED path — so
  // compare against both, or every such window is "not found".
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
  const forms = rows.map((r) => [cmpForm(r.cwd), cmpForm(real(String(r.cwd || "")))]);
  let p = path.resolve(cwd || process.cwd());
  while (true) {
    const want = cmpForm(p);
    const hits = rows.filter((r, i) => forms[i].includes(want));
    if (hits.length) {
      return hits.find((r) => Number(r.parent_pid) === parentPid) || hits[0];
    }
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return byParent.length === 1 ? byParent[0] : null;
}

// Primary source: the local JSON registry (a map id -> row). Returns matched
// target or null.
function fromLocalJson(cwd, agent) {
  let map;
  try {
    map = JSON.parse(fs.readFileSync(LOCAL_REGISTRY_PATH, "utf8"));
  } catch {
    return null; // file missing / unparsable → fall back to bot.db
  }
  if (!map || typeof map !== "object") return null;
  const minHeartbeat = Date.now() / 1000 - HEARTBEAT_FRESH_SECONDS;
  const rows = Object.values(map)
    .filter((r) => r && Number(r.heartbeat_at) > minHeartbeat)
    .sort((a, b) => Number(b.heartbeat_at) - Number(a.heartbeat_at)); // freshest first
  const hit = matchRow(rows, cwd, { agent });
  return hit ? rowToTarget(hit) : null;
}

// Fallback source: the shared bot.db (same-machine, older plugins). node:sqlite
// needs Node 22.5+; absent → just returns null.
function fromBotDb(cwd, agent) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    const minHeartbeat = Date.now() / 1000 - HEARTBEAT_FRESH_SECONDS;
    const rows = db
      .prepare(
        "SELECT host, port, auth_token, workspace_name, cwd, pid, parent_pid " +
          "FROM instances WHERE heartbeat_at > ? ORDER BY heartbeat_at DESC",
      )
      .all(minHeartbeat);
    const hit = matchRow(rows, cwd, { agent });
    return hit ? rowToTarget(hit) : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function findOwnPlugin(cwd, agent) {
  return fromLocalJson(cwd, agent) || fromBotDb(cwd, agent);
}

module.exports = { findOwnPlugin, matchRow };
