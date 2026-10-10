#!/usr/bin/env node
// PreToolUse and PermissionRequest hook: routes Claude Code permission prompts to the tg-bridge
// channel-plugin over HTTP, which then asks the human via Telegram inline
// keyboard. Part of PolyDaemon; registered by hooks/install.py.
//
// Gate model:
//   1. MCP short-circuit and permission_mode/override bypass are checked FIRST
//      — they apply to any claude with the override file, even standalone ones
//      that don't have a tg-bridge plugin attached. Lets a Bypass-marked
//      workspace auto-allow without depending on the plugin being up.
//   2. If neither short-circuit fired, we need a plugin to route the prompt
//      to. `findOwnPlugin()` (tg-bridge-locate.js) finds the plugin attached to
//      THIS claude — local registry first, by cwd walk-up. No plugin attached →
//      exit silently and let the IDE / native flow handle the prompt. That is
//      the right marker: the launchers start claude with the channel flag, a
//      standalone claude has no plugin.
//
// stdin: PreToolUse JSON (see Claude Code docs)
// stdout: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow"|"deny"|"ask", permissionDecisionReason: "..." } }
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const { findOwnPlugin } = require("./tg-bridge-locate.js");

// 24h ≈ "no timer" for async phone-driven approvals. Must stay >= the plugin's
// APPROVAL_TIMEOUT_MS (channel-plugin/src/config.ts) — the +60s buffer at the
// postJson calls keeps the hook's HTTP wait just past the plugin's own timer so
// the plugin's resolution wins the round-trip. AND Claude's hook `timeout` in
// settings.json must exceed THIS (it's 24h+5m) or Claude kills the process and
// the tool falls through to ALLOW.
const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const OVERRIDES_PATH = path.join(os.homedir(), ".tg-copilot-bridge", "permission-overrides.json");
const EXTENSION_ENDPOINTS_DIR = path.join(os.homedir(), ".tg-copilot-bridge", "extension-endpoints");
const CODEX_AUTONOMY_PATH = path.join(os.homedir(), ".tg-copilot-bridge", "codex-autonomy.json");

function readOverrideMode(workspaceName) {
  try {
    const obj = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
    return obj[workspaceName] || null;
  } catch {
    return null;
  }
}

// Walk UP the cwd tree, returning the first override entry that matches a
// directory name in the chain. Fixes: a tool whose cwd is a SUBFOLDER of the
// workspace (e.g. Bash run in <root>/my-project/src/data) was getting
// workspaceName="data" — no override match → "ask" — even though the user
// set Bypass for "my-project". Deepest match wins, so a more-specific child
// override (rare) still takes precedence over its parent.
function findOverrideUpTree(cwd) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8")); }
  catch { return { workspaceName: path.basename(cwd || ""), mode: null }; }
  let p = path.resolve(cwd || process.cwd());
  while (true) {
    const base = path.basename(p);
    if (base && obj[base]) return { workspaceName: base, mode: obj[base] };
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return { workspaceName: path.basename(cwd || ""), mode: null };
}

// Cheap liveness test — no subprocess spawn, since this runs on every tool use.
// A reused PID can slip through, but the endpoint's port won't be listening so
// the POST just fails over to Telegram; the extension's own start-time sweep
// removes the file at next window start.
function pidAlive(pid) {
  if (typeof pid !== "number" || pid <= 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not signalable
  }
}

function findExtensionEndpointForCwd(cwd) {
  let files;
  try {
    files = fs.readdirSync(EXTENSION_ENDPOINTS_DIR);
  } catch {
    return null;
  }
  const entries = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(EXTENSION_ENDPOINTS_DIR, f), "utf8"));
      if (pidAlive(e.pid)) entries.push(e); // skip endpoints of exited hosts
    } catch {}
  }
  const target = path.resolve(cwd || process.cwd()).toLowerCase();
  // Prefer entries whose workspace_path is a prefix of cwd (most-specific wins).
  let best = null;
  for (const e of entries) {
    if (!e || !e.workspace_path || typeof e.port !== "number") continue;
    const wp = path.resolve(e.workspace_path).toLowerCase();
    if (target === wp || target.startsWith(wp + path.sep) || target.startsWith(wp + "/")) {
      if (!best || wp.length > path.resolve(best.workspace_path).toLowerCase().length) {
        best = e;
      }
    }
  }
  return best;
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
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 120)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`bad JSON: ${e.message}`));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

function reply(decision, reason) {
  // Codex PreToolUse only supports deny; a silent exit lets the call proceed.
  if ((input.model || input.turn_id) && !PERMISSION_REQUEST && decision === "allow") bail();
  if (PERMISSION_REQUEST) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: decision === "allow" ? "allow" : "deny", message: reason },
      },
    }));
    process.exit(0);
  }
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

// "No opinion" = exit silently with no output. Codex's hook schema only
// understands allow/deny (permissionDecision "ask" makes the whole hook FAIL
// there); for Claude a silent exit routes to the native picker anyway — the
// same thing "ask" used to express. Never reply("ask") from this hook.
function bail() {
  process.exit(0);
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  if (!process.argv.includes("--self-check")) bail();
  input = {};
}

// The same script is also registered for PermissionRequest: the dialog Claude
// Code shows when its OWN checks want a human even though PreToolUse said
// allow. A PreToolUse allow "only skips the user-facing permission prompt" — the
// built-in safety checks still run, and they stop, for one, an `rm -rf` outside
// the project even in bypassPermissions mode. Those dialogs never reached
// Telegram: the 🔔 notification did, but the answer could only be typed in the
// console, and a background subagent's request was simply denied. For this event
// every bypass shortcut below is skipped (the dialog exists because a person
// must decide), and "no channel" leaves the native dialog in place.
var PERMISSION_REQUEST = String(input.hook_event_name || "") === "PermissionRequest";

const toolName = String(input.tool_name || "");
// These two have their own hooks (tg-ask-question.js, tg-exit-plan.js) that put
// the real question or plan in Telegram. Matching '*' here also sent an
// "Allow AskUserQuestion?" card beside it in a window not in bypass mode, and
// the tool waited for both. No opinion: the dedicated hook decides.
if (toolName === "AskUserQuestion" || toolName === "ExitPlanMode") bail();
if (/^mcp__tg[-_]bridge__/.test(toolName)) {
  reply("allow", "tg-bridge MCP tool (auto-allowed to avoid loops)");
  return;
}

// Push/deploy and sandbox escape always ask, including in bypass mode.
// This command classifier is not a sandbox: indirect operations inside scripts
// still rely on agent instructions and the native filesystem boundary.
function isPlainReadCommand(command) {
  // ponytail: only literal, single commands; complex shell syntax stays gated.
  const word = /'[^']*'|"[^"$`\\]*"|[^\s'"$`\\;&|<>()*?\[\]{}]+/g;
  const tokens = command.match(word);
  if (!tokens || /[^ \t]/.test(command.replace(word, ""))) return false;
  const args = tokens.map((t) => /^["']/.test(t) ? t.slice(1, -1) : t);
  const name = args[0];
  if (["cat", "head", "tail"].includes(name)) return true;
  if (name === "rg") return !args.some((a) => /^--pre(?:=|$)/.test(a));
  if (name === "sed") return args[1] === "-n" && /^\d+(?:,\d+)?p$/.test(args[2] || "") &&
    args.length > 3 && args.slice(3).every((a) => !a.startsWith("-"));
  return ["bash", "sh", "zsh"].includes(name) && args[1] === "-n" && args.length === 3 && !args[2].startsWith("-");
}

function isSensitive(toolName, toolInput) {
  if (/^mcp__.*__.*(?:push|deploy|release|publish).*$/i.test(toolName)) return true;
  if (toolName !== "Bash" && toolName !== "exec_command") return false;

  if (toolInput?.dangerouslyDisableSandbox === true) return true;
  const command = String(toolInput?.command ?? toolInput?.cmd ?? "");
  // Match Git's subcommand after global options, not "push" in another command's arguments.
  if (/\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)\s+|-[^\s;&|]+\s+)*push(?=\s|$|[;&|])/i.test(command)) return true;
  if (!isPlainReadCommand(command) && /\b(ansible-playbook|terraform\s+(?:apply|destroy)|kubectl\s+(?:apply|delete|replace|rollout)|helm\s+(?:upgrade|uninstall)|docker\s+compose\s+(?:up|down)|(?:npm|bun|pnpm|yarn)\s+run\s+(?:deploy|release))\b|(?:^|[\s/])deploy(?:-[\w.-]+)?\.(?:sh|ps1|bat|cmd)\b/i.test(command)) return true;

  return false;
}

function realPath(p) {
  p = path.resolve(p);
  try { return fs.realpathSync.native(p); } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realPath(parent), path.basename(p));
  }
}

function insidePath(root, file) {
  const relative = path.relative(realPath(root), realPath(file));
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

// MiMo owns its data tree; native memory-path-guard still enforces
// agent/task ownership and reserved paths in every workspace.
// No shell commands or deletion patches qualify.
function isMimoDataPath(input) {
  if (process.env.TG_BRIDGE_AGENT !== "mimo") return false;
  const args = input.tool_input || {};
  let paths;
  if (["Read", "Write", "Edit"].includes(input.tool_name)) {
    paths = [args.file_path];
  } else if (input.tool_name === "apply_patch") {
    const patch = String(args.input ?? "");
    if (/^\*\*\* (?:Delete File|Move to):/m.test(patch)) return false;
    paths = Array.from(patch.matchAll(/^\*\*\* (?:Add File|Update File): (.+)$/gm), m => m[1]);
  } else if (["Glob", "Grep"].includes(input.tool_name)) {
    paths = [args.path];
  } else return false;
  const root = path.join(os.homedir(), ".local/share/mimocode");
  if (realPath(root) !== path.resolve(root)) return false;
  return paths.length > 0 && paths.every(p => {
    if (typeof p !== "string" || !p) return false;
    if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
    const file = path.resolve(input.cwd || process.cwd(), p);
    return insidePath(root, file) && (realPath(file) !== realPath(root) || ["Read", "Glob", "Grep"].includes(input.tool_name));
  });
}

// Telegram attachments and bridge diagnostics are shared by all agent windows.
// Only read tools qualify; a symlink into another directory does not.
function isBridgeRead(input) {
  if (!["Read", "Glob", "Grep", "LS", "view_image", "read_file", "list_directory"].includes(input.tool_name)) return false;
  const args = input.tool_input || {};
  const paths = [args.file_path, args.path, args.directory, args.dir_path,
    ...(Array.isArray(args.paths) ? args.paths : [])].filter((p) => typeof p === "string" && p);
  if (!paths.length) paths.push(args.cwd || input.cwd || process.cwd());
  const roots = [path.resolve(__dirname, ".."),
    ...[".tg-bridge-channel", ".tg-bridge", ".tg-copilot-bridge", ".config/polydaemon"]
      .map((p) => path.join(os.homedir(), p))];
  return paths.every((p) => {
    if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
    const file = path.resolve(input.cwd || process.cwd(), p);
    return roots.some((root) => insidePath(root, file));
  });
}

// File-tool paths are checked here; indirect shell access needs the native sandbox.
function outsideWorkspace(input, root) {
  if (!root) return true;
  const args = input.tool_input || {};
  const paths = [input.cwd, args.file_path, args.path, args.workdir, args.cwd];
  if (input.tool_name === "apply_patch") {
    const patch = typeof args === "string" ? args : String(args.input ?? args.command ?? "");
    const targets = Array.from(patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm), m => m[1]);
    if (!targets.length) return true;
    paths.push(...targets);
  }
  return paths.some((p) => {
    if (typeof p !== "string" || !p) return false;
    if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
    return !insidePath(root, path.resolve(input.cwd || root, p));
  });
}

function codexAutonomy(input, root, scopes) {
  if (!(input.turn_id || process.env.CODEX_THREAD_ID) || !root) return null;
  for (const [workspace, scope] of Object.entries(scopes)) {
    if (realPath(workspace) === realPath(root) && ["workspace", "external"].includes(scope)) return scope;
  }
  return null;
}

let autonomyScopes = {};
try {
  const scopes = JSON.parse(fs.readFileSync(CODEX_AUTONOMY_PATH, "utf8"));
  if (scopes && typeof scopes === "object" && !Array.isArray(scopes)) autonomyScopes = scopes;
} catch {}
const target = findOwnPlugin(input.cwd, input.turn_id ? "codex" : undefined);
const workspaceRoot = target?.cwd || process.env.CLAUDE_PROJECT_DIR || input.cwd;
const autonomy = codexAutonomy(input, workspaceRoot, autonomyScopes);
const sensitive = isSensitive(toolName, input.tool_input) ||
  (autonomy !== "external" && outsideWorkspace(input, workspaceRoot));

// Native OpenCode uses the same guard, without executing an approval twice.
if (process.argv.includes("--classify")) {
  const bridgeRead = isBridgeRead(input);
  const sessionMemory = isMimoDataPath(input);
  process.stdout.write(JSON.stringify({ sensitive: sensitive && !bridgeRead && !sessionMemory, bridgeRead, sessionMemory }));
  process.exit(0);
}

if (process.argv.includes("--self-check")) {
  const cases = [
    ["Bash", { command: "git push origin main" }, true],
    ["exec_command", { cmd: "git push origin main" }, true],
    ["exec_command", { cmd: "git check-ignore tmp/.local-test-artifacts/push-byteguard-review.log tmp/.local-test-artifacts/push-byteguard-independent.log" }, false],
    ["Bash", { command: "git check-ignore push" }, false],
    ["Bash", { command: "git grep push" }, false],
    ["Bash", { command: "git -C '/work/project dir' --no-pager push origin main" }, true],
    ["Bash", { command: "git -c core.quotePath=false push" }, true],
    ["Bash", { command: "git --git-dir=.git push; pwd" }, true],
    ["Bash", { command: "git --no-pager check-ignore push" }, false],
    ["Bash", { command: "git status && git push origin main" }, true],
    ["Bash", { command: "pwd", dangerouslyDisableSandbox: true }, true],
    ["Bash", { command: "gh pr merge 123" }, false],
    ["Bash", { command: "rm -f one two" }, false],
    ["Bash", { command: "rm -rf build" }, false],
    ["Bash", { command: "./deploy-prod.sh" }, true],
    ["Bash", { command: "rg -n 'B02|DATA_BACKEND=memory' scripts/deploy-local.sh" }, false],
    ["Bash", { command: "sed -n '1,170p' scripts/deploy-local.sh" }, false],
    ["Bash", { command: "cat scripts/deploy-local.sh" }, false],
    ["Bash", { command: "bash -n scripts/deploy-local.sh" }, false],
    ["Bash", { command: "bash scripts/deploy-local.sh" }, true],
    ["Bash", { command: "rg --pre=./deploy-prod.sh text README.md" }, true],
    ["Bash", { command: "rg text README.md && ./deploy-prod.sh" }, true],
    ["Bash", { command: "cat README.md\n./deploy-prod.sh" }, true],
    ["Bash", { command: "/tmp/cat scripts/deploy-local.sh" }, true],
    ["Bash", { command: "cat $(./deploy-prod.sh)" }, true],
    ["Bash", { command: 'cat "$(./deploy-prod.sh)"' }, true],
    ["Bash", { command: "cat `./deploy-prod.sh`" }, true],
    ["Bash", { command: "sed -n '1,170p' -e 'e ./deploy-prod.sh' README.md" }, true],
    ["apply_patch", { command: "*** Begin Patch\n*** Delete File: a\n*** Delete File: b\n*** End Patch" }, false],
    ["apply_patch", { command: "*** Begin Patch\n*** Delete File: a\n*** End Patch" }, false],
    ["Bash", { command: "rm one" }, false],
    ["Bash", { command: "bun test" }, false],
    ["mcp__git__push", {}, true],
    ["mcp__tg_bridge__download_attachment", {}, false],
  ];
  for (const [name, args, expected] of cases) {
    if (isSensitive(name, args) !== expected) throw new Error(`classifier failed: ${name} ${JSON.stringify(args)}`);
  }
  const scopeRoot = path.join(__dirname, "..");
  const scopes = { [scopeRoot]: "external" };
  if (codexAutonomy({ turn_id: "test" }, scopeRoot, scopes) !== "external") throw new Error("Codex scope missing");
  if (codexAutonomy({}, scopeRoot, scopes) !== null && !process.env.CODEX_THREAD_ID) throw new Error("Claude scope widened");
  if (codexAutonomy({ turn_id: "test" }, scopeRoot + "-other", scopes) !== null) throw new Error("scope prefix collision");
  if (codexAutonomy({ turn_id: "test" }, __dirname, scopes) !== null) throw new Error("unregistered child scope widened");
  const inbox = path.join(os.homedir(), ".tg-bridge-channel", "inbox", "photo.jpg");
  const readCases = [
    ["view_image", { path: inbox }, true],
    ["Read", { file_path: "~/.tg-bridge/agent.toml" }, true],
    ["Grep", { path: path.join(os.homedir(), ".tg-copilot-bridge") }, true],
    ["Read", { file_path: __filename }, true],
    ["view_image", { path: path.join(os.homedir(), ".tg-bridge-channel-other", "photo.jpg") }, false],
    ["Read", { file_path: path.join(os.homedir(), ".tg-bridge-channel", "..", ".ssh", "config") }, false],
    ["read_file", { paths: [inbox, path.join(os.homedir(), ".ssh", "config")] }, false],
    ["Write", { file_path: inbox }, false],
    ["Edit", { file_path: inbox }, false],
    ["apply_patch", { path: inbox }, false],
    ["exec_command", { cmd: "git push", workdir: path.dirname(inbox) }, false],
  ];
  for (const [name, args, expected] of readCases) {
    if (isBridgeRead({ tool_name: name, tool_input: args }) !== expected) throw new Error(`bridge read failed: ${name} ${JSON.stringify(args)}`);
  }
  const tmp = fs.mkdtempSync(path.join(__dirname, ".bridge-read-check-"));
  try {
    const link = path.join(tmp, "escape");
    fs.symlinkSync(os.homedir(), link, "dir");
    if (isBridgeRead({ tool_name: "Read", tool_input: { file_path: path.join(link, ".ssh", "config") } })) throw new Error("symlink escape allowed");
    if (!outsideWorkspace({ tool_name: "Read", tool_input: { file_path: inbox } }, __dirname)) throw new Error("test must cross workspace boundary");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.stdout.write("approval guard self-check OK\n");
  process.exit(0);
}

// Also handles native PermissionRequest for the same owner-authorized read.
if (isBridgeRead(input)) {
  reply("allow", "read-only access to Telegram bridge files");
  return;
}

// Explicit owner-selected scopes also cover native prompts and subagent tools.
// Configured/managed denials remain enforced by the host, not this hook.
if (autonomy && !sensitive) {
  reply("allow", `owner-authorized Codex autonomy (${autonomy})`);
  return;
}

// Direct passthrough: if Claude's session is already in bypassPermissions mode,
// there's nothing for us to gate — UNLESS the command is sensitive (above).
// Newer claude versions include permission_mode in the hook input; absent/older
// versions just fall through to the override check below.
const sessionMode = String(input.permission_mode || "");
if (!sensitive && !PERMISSION_REQUEST && sessionMode === "bypassPermissions") {
  reply("allow", "claude session is in bypassPermissions mode");
  return;
}

function isBypass(mode) {
  // Canonical mode name is "bypassPermissions" (see tg-bot/bot/permissions.py).
  // "bypass" kept as a legacy alias in case a stale override file is on disk.
  return mode === "bypassPermissions" || mode === "bypass";
}

// Find THIS claude's plugin first — its recorded workspace_name is the
// AUTHORITATIVE workspace identity (the exact key the bot writes overrides
// under). We use it for an EXACT override lookup, instead of the old walk-up
// that matched any ancestor folder's basename — that over-matched, e.g. a tool
// under <root>/<non-bypass-ws> still hit a bypass key set on <root> itself.
let workspaceName;
let overrideMode;
if (target) {
  // Plugin attached → exact, drift-free match on its own workspace name.
  workspaceName = target.workspace_name;
  overrideMode = readOverrideMode(workspaceName);
} else {
  // No plugin (standalone claude). Fall back to the cwd-tree walk-up — same
  // behavior as before, since without a registered plugin we have no
  // authoritative workspace root to match exactly.
  const up = findOverrideUpTree(input.cwd);
  workspaceName = up.workspaceName;
  overrideMode = up.mode;
}

if (!sensitive && !PERMISSION_REQUEST && isBypass(overrideMode)) {
  reply("allow", `workspace '${workspaceName}' is in bypass mode`);
  return;
}

// Routine tools run without a Telegram round-trip. Only the explicit protected
// operations above wait for a human; bypass remains bounded by that list.
if (!sensitive && !PERMISSION_REQUEST) {
  reply("allow", "automatic approval for routine action");
}

// A sensitive command must be approved by a person, and in bypassPermissions
// "no opinion" from this hook means it RUNS. So for those, every outcome other
// than an explicit allow is a deny: no plugin, plugin unreachable, no Telegram
// session, a timeout, a malformed answer.
function noDecision(why) {
  if (sensitive && !PERMISSION_REQUEST) reply("deny", `needs an explicit approval and none was given (${why}) — run it yourself if you meant it`);
  bail();
}

// No bypass and no plugin to route through → exit silently so the IDE/native
// picker handles the prompt (standalone claude gets its native flow).
if (!target) {
  noDecision("no Telegram window found");
}

const requestBody = {
  tool_name: toolName,
  tool_input: input.tool_input,
  cwd: input.cwd,
  workspace_name: workspaceName,
  // Tells the plugin not to auto-allow this one on a workspace bypass.
  sensitive: sensitive || PERMISSION_REQUEST,
};

const requests = [
  postJson(target.host, target.port, "/approve-request", requestBody, target.auth_token || "", APPROVAL_TIMEOUT_MS + 60000)
    .then((resp) => {
      // "No active Telegram session" is the plugin saying "this window has no
      // TG chat bound yet" — that's an unavailable channel, not a user's deny.
      // Drop out (null) so the native approval flow (Codex's own prompt /
      // Claude's picker) handles it instead of hard-blocking every tool call.
      if (resp.decision === "deny" && /no active telegram session/i.test(String(resp.reason || ""))) {
        return { source: "telegram", decision: null, reason: resp.reason || "" };
      }
      const decision = resp.decision === "allow" || resp.decision === "deny" ? resp.decision : null;
      return { source: "telegram", decision, reason: resp.reason || "" };
    }),
];

const extEp = findExtensionEndpointForCwd(input.cwd);
if (extEp) {
  requests.push(
    // Send the per-window token the extension wrote into its endpoint file; the
    // extension now requires it (401 otherwise). Older endpoint files without a
    // token send "" and will 401 → this responder drops out (null decision) and
    // Telegram still decides, so a version skew degrades gracefully.
    postJson(extEp.host || "127.0.0.1", extEp.port, "/approve", requestBody, extEp.auth_token || "", APPROVAL_TIMEOUT_MS + 60000)
      // Map ONLY explicit allow/deny to a decision. A dismissed VS Code dialog
      // returns "ignored" (the user clicked away without choosing) — that must
      // NOT count as deny: treat it as "no decision" (null) so this responder
      // drops out of the race and the Telegram answer still decides. Mapping
      // "ignored"→deny used to let a stray dialog-dismiss force-deny a prompt
      // the user intended to approve in Telegram.
      .then((resp) => ({ source: "vscode", decision: resp.decision === "allow" ? "allow" : resp.decision === "deny" ? "deny" : null, reason: resp.reason || "" })),
  );
}

// Resolve on the FIRST real allow/deny; a null-decision (dialog dismissed,
// channel errored) drops out and we keep waiting for the others. Only if EVERY
// channel settles without a real decision do we fall back to "ask".
function firstRealDecision(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    let done = false;
    let fallback = null;
    for (const p of promises) {
      p.then((r) => {
        if (done) return;
        if (r && (r.decision === "allow" || r.decision === "deny")) {
          done = true;
          resolve(r);
          return;
        }
        fallback = r || fallback;
        if (--pending === 0) resolve(fallback);
      });
    }
  });
}

firstRealDecision(requests.map((p) => p.catch((e) => ({ source: "error", decision: null, reason: e.message }))))
  .then((winner) => {
    if (!winner || winner.decision == null) {
      noDecision((winner && winner.reason) || "no channel answered"); // else defer to the native flow
    }
    reply(winner.decision, `${winner.source}: ${winner.reason}`);
  })
  .catch((e) => noDecision(e && e.message ? e.message : "error"));
