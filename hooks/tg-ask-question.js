#!/usr/bin/env node
// PreToolUse hook for `AskUserQuestion`: routes the picker to Telegram via the
// tg-bridge channel plugin's /ask-question endpoint.
// Part of PolyDaemon; registered by hooks/install.py.
//
// Supports single- and multi-question prompts, multiSelect, and the implicit
// "Other / Свой ответ" free-text reply. We block the IDE picker by emitting
// permissionDecision="deny" and feed Claude the user's answer in the reason
// field. If we can't reach the plugin (or the prompt shape is too odd) we
// emit "ask" so the IDE's native picker takes over.
const fs = require("fs");
const path = require("path");
const http = require("http");
const { findOwnPlugin } = require("./tg-bridge-locate.js");

// Keep in lockstep with the plugin's APPROVAL_TIMEOUT_MS (channel-plugin/src/
// config.ts). 24h ≈ "no timer" for async phone-driven answers; the HTTP wait
// below adds a margin so the plugin's own timeout resolves first, and Claude's
// hook `timeout` in settings.json (24h+5m) must exceed both.
const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function reply(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
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
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (e) {
            reject(new Error(`bad JSON: ${e.message}`));
          }
        });
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
} catch (e) {
  reply("ask", `hook input parse failed: ${e.message}`);
  return;
}

// Engage only when a tg-bridge channel plugin is attached to THIS claude (i.e.
// claude was launched with `--dangerously-load-development-channels server:
// tg-bridge`). For a standalone claude that flag was never passed — there is
// no plugin to route to and the IDE/native picker should handle the question.
// Gated AFTER stdin parse because the lookup needs input.cwd: claude spawns
// hooks through a shell shim, so the parent_pid match alone misses and the
// cwd walk-up inside findOwnPlugin is what actually identifies our window.
const ownPlugin = findOwnPlugin(input.cwd);
if (!ownPlugin) {
  process.exit(0);
}

const toolInput = input.tool_input || {};
const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];

const questions = [];
for (const q of rawQuestions) {
  if (!q || typeof q.question !== "string" || !q.question.trim()) continue;
  const options = Array.isArray(q.options)
    ? q.options
        .filter((o) => o && typeof o.label === "string" && o.label.length > 0)
        .map((o) => ({
          label: String(o.label),
          description: typeof o.description === "string" ? o.description : "",
        }))
    : [];
  // Claude Code adds an implicit "Other" choice on every question. We surface
  // that to Telegram as a "✍️ Свой ответ" button so the user can type a free
  // reply even when the model didn't expect one.
  questions.push({
    question: String(q.question),
    header: typeof q.header === "string" ? q.header : "",
    multiSelect: q.multiSelect === true,
    allowCustom: true,
    options,
  });
}

if (questions.length === 0) {
  reply("ask", "tg-ask-question: no parsable questions — IDE picker handles it");
  return;
}

const target = ownPlugin;

// Pretty-print one answered question for Claude's consumption. The model
// sees this as the tool's effective result, so we explicitly spell out which
// question/answer is which when there are several.
function formatAnswer(idx, total, answer) {
  const qLine = `Q${total > 1 ? idx + 1 : ""}: ${String(answer.question || "").slice(0, 400)}`;
  if (answer.kind === "custom") {
    return `${qLine}\nCustom answer (free text from user): ${String(answer.customText || "").slice(0, 2000)}`;
  }
  if (answer.kind === "multi") {
    const labels = Array.isArray(answer.selectedLabels) ? answer.selectedLabels : [];
    const body = labels.length ? labels.map((l) => `  - ${l}`).join("\n") : "  (no options selected)";
    return `${qLine}\nSelected (multiple):\n${body}`;
  }
  const labels = Array.isArray(answer.selectedLabels) ? answer.selectedLabels : [];
  const picked = labels[0] || "(unknown)";
  return `${qLine}\nSelected: ${picked}`;
}

postJson(
  target.host,
  target.port,
  "/ask-question",
  { questions, cwd: input.cwd },
  target.auth_token || "",
  APPROVAL_TIMEOUT_MS + 60000,
)
  .then(({ status, body }) => {
    if (status !== 200) {
      reply("ask", `tg-ask-question: HTTP ${status} — falling back to IDE picker`);
      return;
    }
    if (body.status === "answered" && Array.isArray(body.answers)) {
      const total = body.answers.length;
      const formatted = body.answers.map((a, i) => formatAnswer(i, total, a)).join("\n\n");
      const header = total > 1
        ? `User answered ${total} question(s) via Telegram instead of the IDE picker.`
        : "User answered via Telegram instead of the IDE picker.";
      reply(
        "deny",
        `${header}\n\n${formatted}\n\n` +
          "Proceed using these answers — do not call AskUserQuestion again for the same questions.",
      );
      return;
    }
    if (body.status === "fallback") {
      reply("ask", `tg-ask-question: ${body.reason || "fallback"} — IDE picker handles it`);
      return;
    }
    if (body.status === "timeout") {
      const partial = Array.isArray(body.answers) && body.answers.length > 0
        ? `\n\nPartial answers received before timeout:\n${body.answers.map((a, i) => formatAnswer(i, body.answers.length, a)).join("\n\n")}`
        : "";
      reply(
        "deny",
        `tg-ask-question: user did not finish answering in Telegram in time.${partial}\nTreat the unanswered questions as undecided and choose a safe default or ask again later.`,
      );
      return;
    }
    if (body.status === "invalid") {
      reply("ask", `tg-ask-question: ${body.reason || "invalid input"} — IDE picker handles it`);
      return;
    }
    reply("ask", `tg-ask-question: unexpected response (${body.status || "?"}) — IDE picker handles it`);
  })
  .catch((e) => reply("ask", `tg-ask-question: ${e.message} — IDE picker handles it`));
