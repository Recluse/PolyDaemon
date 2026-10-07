#!/usr/bin/env node
// Stop hook: safety net so a Telegram-originated turn always reaches the user.
// Part of PolyDaemon; registered by hooks/install.py.
//
// Why: the tg-bridge routing rule says a prompt that arrived from Telegram must
// be answered via the `reply` MCP tool — but the model sometimes writes the
// answer to the terminal (or only reacts) and forgets to call reply, so the
// user sees nothing in Telegram. This hook fires when the turn ends; if the
// last human prompt came from Telegram AND no reply tool was called this turn,
// it posts the final assistant text to the window's plugin (`/auto-reply`),
// which delivers it exactly like a normal reply. If reply WAS called, it does
// nothing (no double-post).
//
// Registered in ~/.claude/settings.json by hooks/install.py — do not
// hand-edit that entry; re-run the installer instead.
//
// stdin: Stop JSON { session_id, cwd, transcript_path, stop_hook_active, ... }
// stdout: ignored. Always exit 0 so a bridge hiccup never blocks Claude.
const fs = require("fs");
const http = require("http");
const { findOwnPlugin } = require("./tg-bridge-locate.js");

const TIMEOUT_MS = 5000;
const DEBUG = !!process.env.TG_STOP_MIRROR_DEBUG;

// Always exit 0 — a Stop hook must never block Claude. `reason` is logged only
// when TG_STOP_MIRROR_DEBUG is set (these hooks fire invisibly between turns,
// so a debug switch is the only practical way to see why one did nothing).
function done(reason) {
  if (DEBUG && reason) process.stderr.write(`tg-stop-mirror: ${reason}\n`);
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

// Text of a message's content: a plain string, or the concatenation of its
// text blocks. tool_result / tool_use / thinking blocks contribute nothing.
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

// A real human prompt boundary — a `user` record carrying actual text, not a
// tool_result echo (those are also role=user but have no text block).
function isHumanPrompt(rec) {
  if (!rec || rec.type !== "user" || !rec.message) return false;
  const c = rec.message.content;
  if (typeof c === "string") return true;
  if (Array.isArray(c)) return c.some((b) => b && b.type === "text");
  return false;
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  done("bad stdin json");
}

const transcriptPath = input && input.transcript_path;
if (!transcriptPath) done("no transcript_path");

let records = [];
try {
  for (const line of fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
} catch {
  done("transcript unreadable");
}

// Find the last human prompt; everything after it is "this turn".
let lastIdx = -1;
for (let i = records.length - 1; i >= 0; i--) {
  if (isHumanPrompt(records[i])) {
    lastIdx = i;
    break;
  }
}
if (lastIdx < 0) done("no human prompt found");

const promptText = textOf(records[lastIdx].message.content);
// Which prompt this answer belongs to. The dedup below is per prompt: the same
// closing text for a NEW prompt ("done", "pushed") is a new answer, and keying
// on the text alone swallowed it.
const promptId = String(records[lastIdx].uuid || (promptText.match(/message_id="(\d+)"/) || [])[1] || "");

// Only act on Telegram-originated turns. Console-origin turns answer in the
// terminal and are out of scope for this net.
if (!/source="telegram"/.test(promptText)) done("not a telegram turn");
const chatMatch = promptText.match(/chat_id="(-?\d+)"/);
const chatId = chatMatch ? chatMatch[1] : null;

// Walk this turn's assistant blocks in order: did the model call the reply tool
// (→ already delivered, stop), and what is its closing text?
const blocks = [];
for (let i = lastIdx + 1; i < records.length; i++) {
  const rec = records[i];
  if (!rec || rec.type !== "assistant" || !rec.message) continue;
  const c = rec.message.content;
  if (!Array.isArray(c)) continue;
  for (const b of c) {
    if (b && b.type === "tool_use" && typeof b.name === "string") {
      blocks.push({ kind: "tool", name: b.name });
    } else if (b && b.type === "text" && typeof b.text === "string") {
      blocks.push({ kind: "text", text: b.text });
    }
  }
}

const replied = blocks.some(
  (b) => b.kind === "tool" && (b.name === "mcp__tg-bridge__reply" || b.name.endsWith("__reply")),
);
if (replied) done("reply tool already called — no double-post"); // already answered in Telegram

// The "answer" is the trailing run of text blocks (the closing message after
// the last tool call), which is what a reply would have carried. Earlier text
// is mid-turn narration and not mirrored.
const tail = [];
for (let i = blocks.length - 1; i >= 0; i--) {
  if (blocks[i].kind === "text") tail.unshift(blocks[i].text);
  else break;
}
const answer = tail.join("\n\n").trim();
if (!answer) done("no trailing answer text"); // turn ended on a tool — nothing to send

// Frozen-transcript guard. If the transcript wasn't written in the last ~2 min,
// this turn's REAL answer never got persisted (a disk-full incident froze the
// window's transcript writes) and the "trailing answer" we computed is a STALE
// old message — mirroring it re-posts the same old text on every turn. A genuine,
// freshly-persisted answer has an mtime within seconds of now. So skip when stale.
try {
  const ageMs = Date.now() - fs.statSync(transcriptPath).mtimeMs;
  if (ageMs > 120000) done("transcript stale " + Math.round(ageMs / 1000) + "s — skip (frozen, avoid stale re-mirror)");
} catch {}

// Idempotency across Stop firings. The Stop hook re-fires for a window whenever a
// turn ends, and when the trailing answer is UNCHANGED (a stale answer re-seen on
// later stops — idle re-ends, sub-agent/workflow stops) it would re-post the SAME
// text to /auto-reply, so the user gets the identical message again and again.
// Remember the last answer we mirrored for THIS window (per-cwd state file, so
// windows don't share one file and race) and skip if it hasn't changed.
try {
  const os = require("os");
  const path = require("path");
  const key = String(input.cwd || "nocwd").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const stateFile = path.join(os.homedir(), ".tg-bridge-channel", `stop-mirror-${key}.json`);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(stateFile, "utf8")) || {}; } catch {}
  if (prev.answer === answer && (prev.prompt || "") === promptId) {
    done("answer unchanged since last mirror — skip (no dup)");
  }
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ answer, prompt: promptId, ts: Date.now() }));
  } catch {}
} catch {}

if (DEBUG) {
  process.stderr.write(
    `tg-stop-mirror: would mirror ${answer.length} chars (chat_id=${chatId}): ${JSON.stringify(answer.slice(0, 80))}\n`,
  );
}

// Engage only when a tg-bridge channel plugin is attached to THIS claude
// (launched with `--dangerously-load-development-channels server:tg-bridge`).
// Looked up here (not at the top) because it needs input.cwd: claude spawns
// hooks via a shell shim, so the parent_pid match alone misses and the cwd
// walk-up inside findOwnPlugin is what identifies our window.
// Service-context sessions (memory extractors, cron claudes) run with cwd '/'
// or $HOME and register as nameless phantoms — their final output is machine
// payload, NOT a user-facing answer; mirroring it dumps raw JSON into General
// (live case: 2026-07-20). Only real workspace windows mirror.
const cwdStr = String(input.cwd || "");
if (cwdStr === "/" || cwdStr === "" || cwdStr === process.env.HOME) {
  process.exit(0);
}
const target = findOwnPlugin(input.cwd);
if (!target) done("no tg-bridge plugin attached to this claude");

if (DEBUG) {
  process.stderr.write(
    `tg-stop-mirror: posting to ${target.host}:${target.port}/auto-reply\n`,
  );
}
postJson(
  target.host,
  target.port,
  "/auto-reply",
  { text: answer, chat_id: chatId, cwd: input.cwd, prompt_id: promptId },
  target.auth_token || "",
  TIMEOUT_MS,
)
  .then((res) => done(`posted (response: ${res})`))
  .catch((e) => done(`post failed: ${e}`));
