import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";

const TERMINAL_NAME = "Claude Code";
const BASE_CLAUDE_COMMAND =
  "claude --dangerously-load-development-channels server:tg-bridge";
const ENDPOINTS_DIR = path.join(os.homedir(), ".tg-copilot-bridge", "extension-endpoints");

function buildClaudeCommand(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // --continue resumes the most recent conversation in this workspace's cwd so a
  // window reload (or an update-driven relaunch) doesn't drop two days of
  // context. We use --continue, NOT bare --resume: --resume with no session id
  // opens an interactive picker, which would hang the unattended launch and
  // collide with the auto-Enter that dismisses the dev-channels banner.
  if (!folder) return `${BASE_CLAUDE_COMMAND} --continue --permission-mode bypassPermissions`;
  const name = path.basename(folder).replace(/[^\w.\-]+/g, "_");
  return `${BASE_CLAUDE_COMMAND} --continue --name ${name} --permission-mode bypassPermissions`;
}

let spawnScheduled = false;

export function activate(context: vscode.ExtensionContext): void {
  void scheduleClaudeSpawn(context);
  void startApprovalEndpoint(context);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Create the Claude terminal only AFTER the extensions that mutate the shell
 * environment have registered their EnvironmentVariableCollection contributions
 * (Python venv-activation above all). If we spawn first and a collection lands
 * afterwards, VSCode auto-relaunches the terminal (terminal.integrated.
 * environmentChangesRelaunch, on by default). On slow/cold workspaces that
 * relaunch killed claude mid-launch and spammed repeated venv+claude lines, so
 * the window never actually came up.
 *
 * The previous fixed 4s delay was a guess that lost the race on heavy
 * workspaces. Awaiting the Python extension's activation is deterministic: its
 * env collection is registered by the time activate() resolves. We keep a small
 * floor for other mutators (Copilot, ...) and a hard cap so a hung/absent
 * extension can never block the launch.
 */
async function scheduleClaudeSpawn(context: vscode.ExtensionContext): Promise<void> {
  if (spawnScheduled) return;
  spawnScheduled = true;

  const MIN_WAIT = 3000;
  const MAX_WAIT = 8000;
  const SETTLE = 500;

  const start = Date.now();
  const py = vscode.extensions.getExtension("ms-python.python");
  const activated = py
    ? Promise.resolve(py.activate()).then(
        () => undefined,
        () => undefined,
      )
    : Promise.resolve();

  // Wait for Python activation, but never longer than MAX_WAIT.
  await Promise.race([activated, delay(MAX_WAIT)]);

  // Keep at least MIN_WAIT total so other env mutators also get a chance, then a
  // short settle so the collection is fully applied before the shell spawns.
  const elapsed = Date.now() - start;
  if (elapsed < MIN_WAIT) await delay(MIN_WAIT - elapsed);
  await delay(SETTLE);

  spawnClaudeTerminal(context);
}

function spawnClaudeTerminal(context: vscode.ExtensionContext): void {
  // VSCode restores terminals across reload, but the claude process inside
  // is gone — so we always recreate to make sure the new session picks up
  // the latest flags and MCP config.
  for (const t of vscode.window.terminals) {
    if (t.name === TERMINAL_NAME) {
      t.dispose();
    }
  }

  // DISABLE_AUTOUPDATER pins the claude binary for VS Code-launched sessions.
  // The npm/native auto-updater renamed claude.exe → claude.exe.old mid-relaunch
  // during a window reload, stranding the terminal on a vanished path ("Windows
  // cannot find …claude.exe.old…"). Disabling it here means a reload can never
  // collide with a self-update; updates still happen on manual terminal launches.
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    env: { DISABLE_AUTOUPDATER: "1" },
  });
  terminal.show(true);
  context.subscriptions.push(terminal);

  // The 4s pre-spawn delay above gives other extensions time to register their
  // env mutators BEFORE the shell starts, so the shell normally doesn't need
  // a relaunch. With no relaunch, exactly one send is enough — earlier retries
  // were doubling claude commands when shellIntegration fired post-init for
  // unrelated reasons.
  let sent = false;
  const send = (): void => {
    if (sent || terminal.exitStatus !== undefined) return;
    sent = true;
    terminal.sendText(buildClaudeCommand(), true);
    autoConfirmDevChannels(terminal, context);
  };

  const integrationSub = vscode.window.onDidChangeTerminalShellIntegration((event) => {
    if (event.terminal !== terminal || !event.shellIntegration || sent) return;
    integrationSub.dispose();
    setTimeout(send, 1500);
  });
  context.subscriptions.push(integrationSub);

  // Fallback for shells that never report shell-integration.
  const fallback = setTimeout(() => {
    integrationSub.dispose();
    send();
  }, 10_000);
  context.subscriptions.push({ dispose: () => clearTimeout(fallback) });
}

/**
 * Auto-press the `--dangerously-load-development-channels` confirmation so a
 * window reload comes up fully unattended. That flag pops a native TUI banner
 * ("WARNING: Loading development channels … > 1. I am using this for local
 * development … Enter to confirm") on EVERY launch — there is no settings key or
 * env var to suppress it (it's deliberate research-preview friction). Since we
 * created this terminal, we can write straight into its stdin instead of
 * resorting to OS-level keystroke injection.
 *
 * Option 1 is pre-selected, so a bare Enter confirms it. We send it a few times
 * over a window because claude's cold-start time varies (venv + node):
 *   - too early  → the keystroke is buffered by the pty until the prompt reads it
 *   - on time    → confirms the banner
 *   - too late   → a blank Enter at the REPL is a no-op
 * so over-sending is harmless and the spread absorbs slow startups.
 */
function autoConfirmDevChannels(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext,
): void {
  for (const ms of [2500, 4500, 7000, 10_000]) {
    const h = setTimeout(() => {
      if (terminal.exitStatus === undefined) terminal.sendText("", true);
    }, ms);
    context.subscriptions.push({ dispose: () => clearTimeout(h) });
  }
}

export function deactivate(): void {}

/**
 * Opaque process start-time token, matching the channel-plugin/bot helpers.
 * Lets us tell a live extension host apart from a stale endpoint file whose PID
 * got recycled (Windows reuses PIDs aggressively).
 *   - non-empty string → alive (identifies which process)
 *   - ""   → no process at this PID
 *   - null → lookup failed (keep, conservative)
 * Async so it never blocks the extension host (we spawn rather than spawnSync).
 */
function procStartToken(pid: number): Promise<string | null> {
  if (!pid || pid <= 1) {
    return Promise.resolve(null);
  }
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      let out = "";
      let done = false;
      const finish = (v: string | null): void => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      const ps = spawn(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";` +
            ` if ($p) { [long][Math]::Floor($p.CreationDate.ToFileTimeUtc() / 10000000) }`,
        ],
        { windowsHide: true },
      );
      ps.stdout.on("data", (d: Buffer) => (out += d.toString()));
      ps.on("error", () => finish(null));
      ps.on("close", (code: number | null) => finish(code === 0 ? out.trim() : null));
      setTimeout(() => {
        try {
          ps.kill();
        } catch {}
        finish(null);
      }, 8000);
    });
  }
  return new Promise((resolve) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      resolve(rest[19] ?? null);
    } catch (e) {
      resolve((e as NodeJS.ErrnoException).code === "ENOENT" ? "" : null);
    }
  });
}

/**
 * Remove endpoint files left behind by extension hosts that have exited. A
 * crashed/force-closed window never runs its dispose handler, so its file
 * lingers; and a live-PID check alone is fooled by PID reuse, so we compare the
 * recorded start-time token. Mirrors cleanStaleRegistryFiles in the plugin.
 */
async function cleanStaleEndpoints(selfFile: string): Promise<void> {
  let files: string[];
  try {
    files = fs.readdirSync(ENDPOINTS_DIR);
  } catch {
    return;
  }
  for (const name of files) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const fp = path.join(ENDPOINTS_DIR, name);
    if (fp === selfFile) {
      continue;
    }
    let payload: { pid?: unknown; started_at?: unknown };
    try {
      payload = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      continue;
    }
    const pid = payload.pid;
    if (typeof pid !== "number" || pid <= 1) {
      continue;
    }
    const live = await procStartToken(pid);
    if (live === "") {
      try {
        fs.rmSync(fp, { force: true });
      } catch {}
      continue;
    }
    if (live === null) {
      continue; // lookup failed — keep, don't reap a possibly-live host
    }
    const recorded = payload.started_at;
    if (typeof recorded === "string" && recorded && recorded !== live) {
      try {
        fs.rmSync(fp, { force: true });
      } catch {}
    }
  }
}

async function startApprovalEndpoint(context: vscode.ExtensionContext): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) {
    return;
  }

  const selfToken = (await procStartToken(process.pid)) ?? "";

  // Per-window secret guarding POST /approve. Without it ANY local process (or a
  // browser tab via DNS-rebinding to 127.0.0.1) could POST a forged decision and
  // win the approval race in tg-approve.js, auto-allowing every tool. The token
  // is written into the endpoint file (same dir, user-readable only) which the
  // hook reads to authenticate. 256 bits → a direct compare is not realistically
  // timing-attackable, but we use timingSafeEqual anyway.
  const authToken = crypto.randomBytes(32).toString("hex");
  const expectedAuth = Buffer.from(`Bearer ${authToken}`);
  const authOk = (header: string | undefined): boolean => {
    if (!header) return false;
    const got = Buffer.from(header);
    return got.length === expectedAuth.length && crypto.timingSafeEqual(got, expectedAuth);
  };

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/approve") {
      res.writeHead(404).end();
      return;
    }
    if (!authOk(req.headers.authorization)) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: { tool_name?: string; tool_input?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      const summary = summarizeForNotification(body.tool_name, body.tool_input);
      void vscode.window
        .showInformationMessage(`Claude wants to run: ${summary}`, { modal: false }, "Разрешить", "Запретить")
        .then((choice) => {
          const decision = choice === "Разрешить" ? "allow" : choice === "Запретить" ? "deny" : "ignored";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ decision, reason: `vscode: ${choice ?? "dismissed"}` }));
        });
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      return;
    }
    const port = address.port;

    const endpointFile = path.join(ENDPOINTS_DIR, `${process.pid}.json`);
    try {
      fs.mkdirSync(ENDPOINTS_DIR, { recursive: true });
      fs.writeFileSync(
        endpointFile,
        JSON.stringify(
          {
            pid: process.pid,
            host: "127.0.0.1",
            port,
            workspace_path: workspacePath,
            workspace_name: path.basename(workspacePath),
            started_at: selfToken,
            auth_token: authToken,
          },
          null,
          2,
        ),
      );
    } catch {
      // best-effort
    }

    // Sweep files left by exited extension hosts (crashed/force-closed windows
    // skip the dispose handler). Fire-and-forget so it never blocks listen.
    void cleanStaleEndpoints(endpointFile);

    context.subscriptions.push({
      dispose: () => {
        try {
          fs.rmSync(endpointFile, { force: true });
        } catch {}
        server.close();
      },
    });
  });
}

function summarizeForNotification(toolName: string | undefined, toolInput: unknown): string {
  const name = toolName || "unknown";
  if (toolInput && typeof toolInput === "object") {
    const inp = toolInput as Record<string, unknown>;
    if (name === "Bash" && typeof inp.command === "string") {
      return `${name}: ${truncate(inp.command, 120)}`;
    }
    if (name === "WebFetch" && typeof inp.url === "string") {
      return `${name}: ${truncate(inp.url, 120)}`;
    }
    if ((name === "Edit" || name === "Write") && typeof inp.file_path === "string") {
      return `${name}: ${truncate(inp.file_path, 120)}`;
    }
  }
  return name;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
