import * as vscode from "vscode";

export interface PendingChatHandle {
  pushChunk(text: string): void;
  resolve(): void;
  reject(error: Error): void;
}

interface PendingEntry {
  chunks: string[];
  onChunk: (text: string) => void;
  resolveFn: (text: string) => void;
  rejectFn: (error: Error) => void;
  settled: boolean;
}

const MARKER_PREFIX = "[tg:";
const MARKER_REGEX = /^\s*\[tg:([a-z0-9-]+)\]\s*/i;

const pending = new Map<string, PendingEntry>();

export interface PendingRegistration {
  token: string;
  promise: Promise<string>;
  cancel(reason?: string): void;
}

export function buildMarkerPrompt(token: string, prompt: string): string {
  return `${MARKER_PREFIX}${token}] ${prompt}`;
}

export function consumeMarker(prompt: string): { token?: string; prompt: string } {
  const match = MARKER_REGEX.exec(prompt);
  if (!match) {
    return { prompt };
  }

  return { token: match[1], prompt: prompt.slice(match[0].length) };
}

export function registerPendingChat(
  token: string,
  onChunk: (text: string) => void,
  cancellation?: vscode.CancellationToken,
  timeoutMs = 120_000,
): PendingRegistration {
  const entry: PendingEntry = {
    chunks: [],
    onChunk,
    resolveFn: () => undefined,
    rejectFn: () => undefined,
    settled: false,
  };

  const promise = new Promise<string>((resolve, reject) => {
    entry.resolveFn = resolve;
    entry.rejectFn = reject;
  });

  pending.set(token, entry);

  const cleanup = (): void => {
    pending.delete(token);
  };

  const fail = (reason: string): void => {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    cleanup();
    entry.rejectFn(new Error(reason));
  };

  const timer = setTimeout(() => fail(`Official chat response timed out after ${timeoutMs}ms.`), timeoutMs);

  const cancellationSub = cancellation?.onCancellationRequested(() => fail("Request cancelled."));

  promise.finally(() => {
    clearTimeout(timer);
    cancellationSub?.dispose();
    cleanup();
  }).catch(() => undefined);

  return {
    token,
    promise,
    cancel: (reason = "Request cancelled.") => fail(reason),
  };
}

export function takePendingHandle(token: string): PendingChatHandle | undefined {
  const entry = pending.get(token);
  if (!entry) {
    return undefined;
  }

  return {
    pushChunk: (text: string) => {
      if (entry.settled) {
        return;
      }
      entry.chunks.push(text);
      try {
        entry.onChunk(text);
      } catch {
        // ignore consumer errors
      }
    },
    resolve: () => {
      if (entry.settled) {
        return;
      }
      entry.settled = true;
      pending.delete(token);
      entry.resolveFn(entry.chunks.join(""));
    },
    reject: (error: Error) => {
      if (entry.settled) {
        return;
      }
      entry.settled = true;
      pending.delete(token);
      entry.rejectFn(error);
    },
  };
}

export function generatePendingToken(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${random}`;
}

export function wrapStreamForPending(
  stream: vscode.ChatResponseStream,
  handle: PendingChatHandle,
): vscode.ChatResponseStream {
  // NOTE: do NOT wrap `stream` in a `Proxy`.
  //
  // VS Code's `ChatResponseStream` exposes its methods via property
  // descriptors flagged as `writable: false, configurable: false`.
  // Per the ECMA-262 Proxy invariants, a `get` trap MUST return the
  // exact same value held on the target for such properties; otherwise
  // the engine throws:
  //
  //   TypeError: 'get' on proxy: property 'markdown' is a read-only
  //   and non-configurable data property on the proxy target but the
  //   proxy did not return its actual value
  //
  // See docs/adr/adr-0002-no-proxy-over-chat-response-stream.md.
  //
  // Instead we build a plain delegating wrapper: collect every method
  // from the stream (own + prototype), bind it to the original stream,
  // then override `markdown` to tee the text into the pending handle.
  const wrapper: Record<string, unknown> = {};
  const seen = new Set<string>();
  let proto: object | null = stream as unknown as object;
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor" || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const value = (stream as unknown as Record<string, unknown>)[key];
      if (typeof value === "function") {
        wrapper[key] = (value as (...args: unknown[]) => unknown).bind(stream);
      } else {
        wrapper[key] = value;
      }
    }
    proto = Object.getPrototypeOf(proto);
  }

  wrapper.markdown = (value: string | vscode.MarkdownString) => {
    const text = typeof value === "string" ? value : value.value;
    handle.pushChunk(text);
    return stream.markdown(value);
  };

  return wrapper as unknown as vscode.ChatResponseStream;
}
