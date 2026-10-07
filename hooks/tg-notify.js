#!/usr/bin/env node
// Notification hook: mirrors Claude Code notifications to the tg-bridge channel
// plugin over HTTP, which posts them into the window's Telegram topic.
// Part of PolyDaemon; registered by hooks/install.py.
//
// Why: some prompts (folder/workspace trust, MCP server approval, settings
// access) are native TUI dialogs that `bypassPermissions` does NOT clear and
// that PreToolUse hooks never see — they only show in the console. The
// Notification hook is the one event that fires for them. It can't ANSWER them
// (Claude Code doesn't allow that), but it lets us tell the user "this window
// is blocked, go look", so a window no longer hangs silently.
//
// Registered in ~/.claude/settings.json by hooks/install.py — do not
// hand-edit that entry; re-run the installer instead.
//
// stdin: Notification JSON { session_id, cwd, hook_event_name, message }
// stdout: ignored (Notification hooks are informational). Always exit 0 so a
// bridge hiccup never blocks Claude.
const fs = require("fs");
const http = require("http");
const { findOwnPlugin } = require("./tg-bridge-locate.js");

const NOTIFY_TIMEOUT_MS = 5000;

function done() {
  process.exit(0);
}

function postJson(host, port, urlPath, body, authToken, timeoutMs) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host,
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": buf.length,
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  done();
}

const message = String((input && input.message) || "").trim();
if (!message) done();

// Drop the idle "waiting for input" notification. Claude Code fires this every
// time a turn ends and the session goes idle — but the turn's result already
// reached the user in their topic (via the reply tool / stop-mirror), so this
// just spams "🔔 Ждёт ответа в консоли" on every idle. The hook's real value is
// surfacing NATIVE dialogs (folder/workspace trust, MCP-server approval,
// settings access) that bypass PreToolUse and would otherwise hang a window
// silently — those carry different message text and still pass through.
if (/waiting for your input|waiting for input/i.test(message)) {
  done();
}

// Engage only when a tg-bridge channel plugin is attached to THIS claude (the
// session was started with `--dangerously-load-development-channels server:
// tg-bridge`). For a standalone claude there's no plugin/topic to mirror to.
// Looked up after stdin parse — needs input.cwd (claude spawns hooks via a
// shell shim, so parent_pid alone misses; the cwd walk-up does the work).
const target = findOwnPlugin(input.cwd);
if (!target) done();

postJson(
  target.host,
  target.port,
  "/notify",
  { message, cwd: input.cwd, workspace_name: target.workspace_name },
  target.auth_token || "",
  NOTIFY_TIMEOUT_MS,
)
  .catch(() => {})
  .finally(done);
