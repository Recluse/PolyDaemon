#!/usr/bin/env node
// PreToolUse hook for `ExitPlanMode`: routes the "apply plan?" decision to
// Telegram via the tg-bridge channel plugin.
// Part of PolyDaemon; registered by hooks/install.py.
//
// Decision mapping:
//   apply   → permissionDecision="allow"  (Claude exits plan mode and proceeds)
//   decline → permissionDecision="deny"   (Claude stays in plan mode)
//   timeout → permissionDecision="deny"   (keep planning; nobody answered)
const fs = require("fs");
const http = require("http");
const { findOwnPlugin } = require("./tg-bridge-locate.js");

// Keep in lockstep with the plugin's APPROVAL_TIMEOUT_MS (channel-plugin/src/
// config.ts). 24h ≈ "no timer" for async phone-driven plan decisions; the HTTP
// wait below adds a margin so the plugin's own timeout resolves first, and
// Claude's hook `timeout` in settings.json (24h+5m) must exceed both.
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

// Engage only when a tg-bridge channel plugin is attached to THIS claude.
// Standalone claude (no `--dangerously-load-development-channels` flag) has no
// plugin to route to — let the IDE/native picker handle the plan decision.
// Gated after stdin parse: the lookup needs input.cwd (claude spawns hooks
// via a shell shim, so parent_pid alone misses; cwd walk-up does the work).
const ownPlugin = findOwnPlugin(input.cwd);
if (!ownPlugin) {
  process.exit(0);
}

const plan = (input.tool_input && typeof input.tool_input.plan === "string") ? input.tool_input.plan : "";
if (!plan.trim()) {
  // Nothing to show — let Claude's own pipeline handle (or surface) the issue.
  reply("ask", "tg-exit-plan: empty plan — IDE picker handles it");
  return;
}

const target = ownPlugin;

postJson(
  target.host,
  target.port,
  "/exit-plan",
  { plan, cwd: input.cwd },
  target.auth_token || "",
  APPROVAL_TIMEOUT_MS + 60000,
)
  .then(({ status, body }) => {
    if (status !== 200) {
      reply("ask", `tg-exit-plan: HTTP ${status} — IDE picker handles it`);
      return;
    }
    if (body.status === "answered" && body.decision === "apply") {
      reply("allow", "User applied the plan via Telegram.");
      return;
    }
    if (body.status === "answered" && body.decision === "decline") {
      reply("deny", "User declined the plan via Telegram. Refine the plan and call ExitPlanMode again when ready, or keep planning.");
      return;
    }
    if (body.status === "fallback") {
      reply("ask", `tg-exit-plan: ${body.reason || "fallback"} — IDE picker handles it`);
      return;
    }
    if (body.status === "timeout") {
      reply("deny", "tg-exit-plan: user did not respond in Telegram in time. Treat the plan as not approved and continue planning instead of exiting plan mode.");
      return;
    }
    reply("ask", `tg-exit-plan: unexpected response (${body.status || "?"}) — IDE picker handles it`);
  })
  .catch((e) => reply("ask", `tg-exit-plan: ${e.message} — IDE picker handles it`));
