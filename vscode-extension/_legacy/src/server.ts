import * as vscode from "vscode";
import WebSocket, { RawData, WebSocketServer } from "ws";

import { ClaudeCodeService } from "./claudeCodeService";
import { CopilotService } from "./copilot";
import {
  buildMarkerPrompt,
  generatePendingToken,
  registerPendingChat,
} from "./officialChatBridge";
import { ChatMirrorSink } from "./panel";
import {
  ChatMessage,
  BridgeConfig,
  ChunkMessage,
  DoneMessage,
  ErrorMessage,
  IncomingMessage,
  PingMessage,
  PongMessage,
  RequestMessage,
  ServerStatus,
} from "./types";

export class BridgeServer {
  private server?: WebSocketServer;
  private config?: BridgeConfig;
  private panelHistory: ChatMessage[] = [];
  private panelRequestSequence = 0;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly copilot: CopilotService,
    private readonly onStatusChange: (status: ServerStatus) => void,
    private readonly chatMirror: ChatMirrorSink,
    private readonly claudeCode: ClaudeCodeService,
  ) {}

  async start(config: BridgeConfig): Promise<BridgeConfig> {
    await this.stop();

    this.onStatusChange({ kind: "starting", detail: `${config.instanceName} :${config.port}` });
    const resolvedConfig = await this.startOnAvailablePort(config);
    this.config = resolvedConfig;
    return resolvedConfig;
  }

  async restart(config: BridgeConfig): Promise<BridgeConfig> {
    this.output.appendLine("[server] Restart requested.");
    return await this.start(config);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      this.onStatusChange({ kind: "stopped" });
      return;
    }

    const server = this.server;
    this.server = undefined;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown shutdown failure.";
      this.output.appendLine(`[server] Failed to stop cleanly: ${message}`);
    });

    this.onStatusChange({ kind: "stopped" });
    this.output.appendLine("[server] Stopped.");
  }

  async handlePanelPrompt(prompt: string): Promise<void> {
    if (!this.config) {
      throw new Error("Bridge is not configured.");
    }

    const requestId = `panel-${Date.now()}-${this.panelRequestSequence}`;
    this.panelRequestSequence += 1;
    const userMessage: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
    };
    const messages = [...this.panelHistory, userMessage];

    this.chatMirror.reveal();
    this.chatMirror.setComposerBusy(true);
    this.chatMirror.showPanelMessage(requestId, prompt);

    try {
      const finalText = await this.runChatRequest(requestId, messages, (text) => {
        this.chatMirror.appendAssistantChunk(requestId, text);
      });
      this.chatMirror.completeAssistantMessage(requestId);
      this.panelHistory = [...messages, createAssistantMessage(finalText)];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown chat failure.";
      this.chatMirror.failAssistantMessage(requestId, errorMessage);
      throw error;
    } finally {
      this.chatMirror.setComposerBusy(false);
    }
  }

  private async handleRawMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const payload = this.decodeRawData(raw);

    let message: IncomingMessage;
    try {
      message = JSON.parse(payload) as IncomingMessage;
    } catch {
      this.output.appendLine("[server] Ignoring invalid JSON payload.");
      return;
    }

    if (message.type === "ping") {
      await this.handlePing(socket, message);
      return;
    }

    if (message.type === "chat") {
      await this.handleChat(socket, message);
      return;
    }

    this.output.appendLine(`[server] Ignoring unsupported message type: ${(message as { type?: string }).type ?? "unknown"}.`);
  }

  private async handlePing(socket: WebSocket, message: PingMessage): Promise<void> {
    if (!this.config || !this.isAuthorized(message.token)) {
      socket.close(1008, "Unauthorized");
      return;
    }

    let modelName = this.config.model || "auto";

    try {
      const model = await this.copilot.resolveModel(this.config.model);
      modelName = model.name;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown model resolution error.";
      this.output.appendLine(`[server] Ping model resolution failed: ${errorMessage}`);
    }

    const response: PongMessage = {
      type: "pong",
      instance_name: this.config.instanceName,
      model: modelName,
    };
    this.sendJson(socket, response);
  }

  private async handleChat(socket: WebSocket, message: RequestMessage): Promise<void> {
    if (!this.config) {
      return;
    }

    if (!this.isAuthorized(message.token)) {
      const errorResponse: ErrorMessage = {
        type: "error",
        request_id: message.request_id,
        message: "Unauthorized",
      };
      this.sendJson(socket, errorResponse);
      return;
    }

    this.chatMirror.showTelegramMessage(
      message.request_id,
      summarizeLatestUserMessage(message.messages),
      this.config.instanceName,
    );

    const cancellation = new vscode.CancellationTokenSource();
    const cancelOnClose = (): void => cancellation.cancel();
    socket.once("close", cancelOnClose);

    try {
      const finalText = await this.runChatRequest(message.request_id, message.messages, (text) => {
        const chunk: ChunkMessage = {
          type: "chunk",
          request_id: message.request_id,
          text,
        };
        this.sendJson(socket, chunk);
        this.chatMirror.appendAssistantChunk(message.request_id, text);
      }, cancellation.token);

      const done: DoneMessage = {
        type: "done",
        request_id: message.request_id,
      };
      this.sendJson(socket, done);
      this.chatMirror.completeAssistantMessage(message.request_id);
      this.panelHistory = [...message.messages, createAssistantMessage(finalText)];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown chat failure.";
      const response: ErrorMessage = {
        type: "error",
        request_id: message.request_id,
        message: errorMessage,
      };
      this.sendJson(socket, response);
      this.chatMirror.failAssistantMessage(message.request_id, errorMessage);
      this.output.appendLine(`[server] Request ${message.request_id} failed: ${errorMessage}`);
    } finally {
      socket.off("close", cancelOnClose);
      cancellation.dispose();
    }
  }

  private async runChatRequest(
    requestId: string,
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    token?: vscode.CancellationToken,
  ): Promise<string> {
    if (!this.config) {
      throw new Error("Bridge is not configured.");
    }

    if (this.config.requestMode === "official-chat-ingress") {
      return await this.dispatchToOfficialChat(requestId, messages, onChunk, token);
    }

    const localCancellation = token ? undefined : new vscode.CancellationTokenSource();
    const effectiveToken = token ?? localCancellation?.token;

    try {
      if (this.config.requestMode === "claude-code-sdk") {
        const chunks: string[] = [];
        const finalText = await this.claudeCode.streamChat(this.config, messages, effectiveToken!, (text) => {
          chunks.push(text);
          onChunk(text);
        });
        this.output.appendLine(`[server] Request ${requestId} completed via Claude Code CLI.`);
        return finalText || chunks.join("");
      }

      const chunks: string[] = [];
      const model = await this.copilot.streamChat(this.config, messages, effectiveToken!, (text) => {
        chunks.push(text);
        onChunk(text);
      });
      this.output.appendLine(`[server] Request ${requestId} completed via ${model.name}.`);
      return chunks.join("");
    } finally {
      localCancellation?.dispose();
    }
  }

  private async dispatchToOfficialChat(
    requestId: string,
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    token?: vscode.CancellationToken,
  ): Promise<string> {
    if (!this.config) {
      throw new Error("Bridge is not configured.");
    }

    const prompt = summarizeLatestUserMessage(messages);
    const mode = this.config.officialChatMode;
    const bridgeToken = generatePendingToken();
    const markedPrompt = buildMarkerPrompt(bridgeToken, prompt);
    const query = `@tgbridge ${markedPrompt}`;

    const pending = registerPendingChat(bridgeToken, onChunk, token);

    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query,
        mode,
      });
    } catch (error) {
      pending.cancel("workbench.action.chat.open failed.");
      const message = error instanceof Error ? error.message : "Unknown chat-open failure.";
      throw new Error(`workbench.action.chat.open failed: ${message}`);
    }

    this.output.appendLine(
      `[server] Request ${requestId} forwarded to @tgbridge in official Copilot Chat (mode=${mode}, token=${bridgeToken}).`,
    );

    try {
      const finalText = await pending.promise;
      this.output.appendLine(`[server] Request ${requestId} completed via official Copilot Chat.`);
      return finalText;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown official chat failure.";
      throw new Error(`Official Copilot Chat dispatch failed: ${message}`);
    }
  }

  private isAuthorized(token: string): boolean {
    return Boolean(this.config) && token === this.config?.authToken;
  }

  private sendJson(socket: WebSocket, payload: object): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(payload));
  }

  private decodeRawData(raw: RawData): string {
    if (typeof raw === "string") {
      return raw;
    }

    if (raw instanceof Buffer) {
      return raw.toString("utf8");
    }

    if (Array.isArray(raw)) {
      return Buffer.concat(raw.map((chunk) => (chunk instanceof Buffer ? chunk : Buffer.from(chunk)))).toString("utf8");
    }

    if (raw instanceof ArrayBuffer) {
      return Buffer.from(new Uint8Array(raw)).toString("utf8");
    }

    if (ArrayBuffer.isView(raw)) {
      return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
    }

    return "";
  }

  private async startOnAvailablePort(config: BridgeConfig): Promise<BridgeConfig> {
    const candidatePorts = buildCandidatePorts(config.port);
    let lastError: Error | undefined;

    for (const candidatePort of candidatePorts) {
      try {
        if (candidatePort !== config.port) {
          this.output.appendLine(
            `[server] Port ${config.port} is busy. Retrying on ${candidatePort}.`,
          );
        }

        return await this.tryStart({ ...config, port: candidatePort });
      } catch (error) {
        if (!isAddressInUseError(error)) {
          throw error;
        }

        lastError = error;
      }
    }

    throw lastError ?? new Error(`No available port found near ${config.port}.`);
  }

  private async tryStart(config: BridgeConfig): Promise<BridgeConfig> {
    return await new Promise<BridgeConfig>((resolve, reject) => {
      const server = new WebSocketServer({ host: config.host, port: config.port });

      const handleError = (error: Error): void => {
        server.off("listening", handleListening);
        reject(error);
      };

      const handleListening = (): void => {
        server.off("error", handleError);
        this.server = server;
        this.attachServerListeners(server);
        const actualPort = this.readListeningPort(server, config.port);
        const resolvedConfig = { ...config, port: actualPort };
        this.output.appendLine(`[server] Listening on ws://${config.host}:${actualPort} (${config.instanceName}).`);
        this.onStatusChange({ kind: "listening", detail: `${config.instanceName} :${actualPort}` });
        resolve(resolvedConfig);
      };

      server.once("error", handleError);
      server.once("listening", handleListening);
    });
  }

  private attachServerListeners(server: WebSocketServer): void {
    server.on("connection", (socket) => {
      this.output.appendLine("[server] Client connected.");
      socket.on("message", (raw) => {
        void this.handleRawMessage(socket, raw);
      });
      socket.on("close", () => {
        this.output.appendLine("[server] Client disconnected.");
      });
      socket.on("error", (error) => {
        this.output.appendLine(`[server] Socket error: ${error.message}`);
      });
    });
  }

  private readListeningPort(server: WebSocketServer, fallbackPort: number): number {
    const address = server.address();
    if (address && typeof address === "object" && "port" in address && typeof address.port === "number") {
      return address.port;
    }

    return fallbackPort;
  }
}

function buildCandidatePorts(port: number): number[] {
  return Array.from({ length: 20 }, (_, index) => port + index);
}

function isAddressInUseError(error: unknown): error is Error & { code?: unknown } {
  if (!(error instanceof Error)) {
    return false;
  }

  return "code" in error && error.code === "EADDRINUSE";
}

function summarizeLatestUserMessage(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }

    const parts = message.content.map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      return `[image: ${part.mime_type}]`;
    });
    return parts.join("\n").trim() || "[empty user message]";
  }

  return "[no user message]";
}

function createAssistantMessage(text: string): ChatMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}