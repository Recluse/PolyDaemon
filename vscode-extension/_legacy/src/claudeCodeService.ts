import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { existsSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { BridgeConfig, ChatMessage, ContentPart } from "./types";

const BUNDLED_HINTS = [
  "anthropic.claude-code-",
];

export class ClaudeCodeService {
  constructor(private readonly output: vscode.OutputChannel) {}

  async streamChat(
    config: BridgeConfig,
    messages: ChatMessage[],
    token: vscode.CancellationToken,
    onText: (text: string) => void,
  ): Promise<string> {
    const executable = await this.resolveExecutable(config.claudeCode.executable);
    const cwd = this.resolveCwd();
    const args = this.buildArgs(config);
    const prompt = serializeConversation(messages);

    this.output.appendLine(
      `[claude-code] Spawning: "${executable}" ${args.join(" ")} (cwd=${cwd ?? "<no-workspace>"}, prompt-bytes=${Buffer.byteLength(prompt, "utf8")}).`,
    );

    return await runProcess({
      executable,
      args,
      cwd,
      prompt,
      token,
      timeoutMs: config.claudeCode.timeoutMs ?? 600_000,
      onText,
      output: this.output,
    });
  }

  private resolveCwd(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath;
  }

  private buildArgs(config: BridgeConfig): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--no-session-persistence",
    ];

    const model = config.claudeCode.model?.trim();
    if (model) {
      args.push("--model", model);
    }

    const permissionMode = config.claudeCode.permissionMode?.trim();
    if (permissionMode) {
      args.push("--permission-mode", permissionMode);
    }

    const extra = config.claudeCode.extraArgs ?? [];
    for (const value of extra) {
      if (typeof value === "string" && value.length > 0) {
        args.push(value);
      }
    }

    return args;
  }

  private async resolveExecutable(override?: string): Promise<string> {
    const trimmed = override?.trim();
    if (trimmed) {
      if (!existsSync(trimmed)) {
        throw new Error(`Configured claudeCode.executable does not exist: ${trimmed}`);
      }
      return trimmed;
    }

    const bundled = await findBundledClaudeBinary();
    if (bundled) {
      return bundled;
    }

    return process.platform === "win32" ? "claude.cmd" : "claude";
  }
}

interface RunOptions {
  executable: string;
  args: string[];
  cwd?: string;
  prompt: string;
  token: vscode.CancellationToken;
  timeoutMs: number;
  onText: (text: string) => void;
  output: vscode.OutputChannel;
}

function runProcess(options: RunOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
    } catch (error) {
      reject(wrapSpawnError(error, options.executable));
      return;
    }

    let settled = false;
    let collected = "";
    let lastEmittedLength = 0;
    let stderrTail = "";
    const stdoutBuffer = new LineBuffer();

    const finish = (run: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      run();
    };

    const failWith = (message: string): void => {
      finish(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
        reject(new Error(message));
      });
    };

    const timer = setTimeout(() => {
      failWith(`Claude Code CLI timed out after ${options.timeoutMs}ms.`);
    }, options.timeoutMs);

    const cancelSub = options.token.onCancellationRequested(() => {
      failWith("Request cancelled.");
    });

    const cleanup = (): void => {
      clearTimeout(timer);
      cancelSub.dispose();
    };

    const emitDelta = (fullText: string): void => {
      if (fullText.length <= lastEmittedLength) {
        return;
      }
      const delta = fullText.slice(lastEmittedLength);
      lastEmittedLength = fullText.length;
      collected = fullText;
      try {
        options.onText(delta);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown chunk consumer error.";
        options.output.appendLine(`[claude-code] Chunk consumer error: ${message}`);
      }
    };

    const handleEvent = (event: ClaudeStreamEvent): void => {
      if (!event || typeof event !== "object") {
        return;
      }

      switch (event.type) {
        case "system": {
          if (event.subtype === "init" && typeof event.session_id === "string") {
            options.output.appendLine(`[claude-code] Session ${event.session_id} started.`);
          }
          return;
        }
        case "assistant": {
          const text = extractAssistantText(event);
          if (text) {
            emitDelta(text);
          }
          return;
        }
        case "stream_event": {
          // partial deltas; we rely on the cumulative `assistant` events instead
          return;
        }
        case "result": {
          if (event.is_error) {
            failWith(typeof event.error === "string" ? event.error : "Claude Code CLI returned an error result.");
            return;
          }
          const finalText = typeof event.result === "string" && event.result.length > 0
            ? event.result
            : collected;
          if (typeof event.result === "string" && event.result.length > 0) {
            emitDelta(event.result);
          }
          finish(() => resolve(finalText));
          return;
        }
        case "error": {
          const message = typeof event.message === "string" ? event.message : "Claude Code CLI error.";
          failWith(message);
          return;
        }
        default:
          return;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const line of stdoutBuffer.push(chunk)) {
        if (!line) {
          continue;
        }
        try {
          handleEvent(JSON.parse(line) as ClaudeStreamEvent);
        } catch {
          options.output.appendLine(`[claude-code] Skipping non-JSON stdout line: ${truncate(line, 200)}`);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4_000);
      options.output.appendLine(`[claude-code][stderr] ${chunk.trimEnd()}`);
    });

    child.on("error", (error) => {
      failWith(wrapSpawnError(error, options.executable).message);
    });

    child.on("close", (code, signal) => {
      for (const line of stdoutBuffer.flush()) {
        if (!line) {
          continue;
        }
        try {
          handleEvent(JSON.parse(line) as ClaudeStreamEvent);
        } catch {
          // ignore
        }
      }

      if (settled) {
        return;
      }

      if (code === 0) {
        finish(() => resolve(collected));
        return;
      }

      const reason = signal
        ? `Claude Code CLI killed by ${signal}.`
        : `Claude Code CLI exited with code ${code ?? "unknown"}.`;
      const stderrSnippet = stderrTail.trim();
      failWith(stderrSnippet ? `${reason} stderr: ${truncate(stderrSnippet, 500)}` : reason);
    });

    try {
      child.stdin.end(options.prompt, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown stdin error.";
      failWith(`Failed to write prompt to Claude Code stdin: ${message}`);
    }
  });
}

class LineBuffer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      lines.push(this.buffer.slice(0, newlineIndex).trim());
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
    }
    return lines;
  }

  flush(): string[] {
    if (!this.buffer) {
      return [];
    }
    const tail = this.buffer.trim();
    this.buffer = "";
    return tail ? [tail] : [];
  }
}

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  error?: unknown;
  result?: unknown;
  message?: unknown;
}

function extractAssistantText(event: ClaudeStreamEvent): string {
  const message = (event as { message?: unknown }).message as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function serializeConversation(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return "";
  }

  if (messages.length === 1 && messages[0].role === "user") {
    return renderParts(messages[0].content);
  }

  const lines: string[] = [];
  for (let i = 0; i < messages.length - 1; i += 1) {
    const message = messages[i];
    const role = message.role === "assistant" ? "Assistant" : "User";
    lines.push(`### ${role}`);
    lines.push(renderParts(message.content));
    lines.push("");
  }

  const last = messages[messages.length - 1];
  lines.push("### Current user message");
  lines.push(renderParts(last.content));
  return lines.join("\n").trim();
}

function renderParts(parts: ContentPart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      return `[image attachment: ${part.mime_type}, base64 omitted]`;
    })
    .join("\n")
    .trim();
}

function wrapSpawnError(error: unknown, executable: string): Error {
  const base = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to spawn Claude Code CLI (${executable}): ${base}`);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function findBundledClaudeBinary(): Promise<string | undefined> {
  const homeDir = process.env.USERPROFILE ?? process.env.HOME;
  if (!homeDir) {
    return undefined;
  }

  const extensionsRoot = path.join(homeDir, ".vscode", "extensions");
  if (!existsSync(extensionsRoot)) {
    return undefined;
  }

  let dirents: import("fs").Dirent[];
  try {
    const fs = await import("fs/promises");
    dirents = await fs.readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const exeName = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = dirents
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => BUNDLED_HINTS.some((hint) => name.startsWith(hint)))
    .sort()
    .reverse();

  for (const dir of candidates) {
    const candidate = path.join(extensionsRoot, dir, "resources", "native-binary", exeName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
