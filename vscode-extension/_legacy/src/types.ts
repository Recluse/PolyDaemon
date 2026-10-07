export type BridgeRole = "user" | "assistant";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  data: string;
  mime_type: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: BridgeRole;
  content: ContentPart[];
}

export interface RequestMessage {
  type: "chat";
  request_id: string;
  token: string;
  messages: ChatMessage[];
}

export interface PingMessage {
  type: "ping";
  token: string;
}

export interface ChunkMessage {
  type: "chunk";
  request_id: string;
  text: string;
}

export interface DoneMessage {
  type: "done";
  request_id: string;
}

export interface ErrorMessage {
  type: "error";
  request_id: string;
  message: string;
}

export interface PongMessage {
  type: "pong";
  instance_name: string;
  model: string;
}

export type IncomingMessage = RequestMessage | PingMessage;

export type RequestMode = "workspace-tools" | "official-chat-ingress" | "claude-code-sdk";
export type OfficialChatMode = "ask" | "edit" | "agent";

export interface ClaudeCodeConfig {
  executable?: string;
  model?: string;
  permissionMode?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export interface BridgeConfig {
  host: string;
  port: number;
  instanceName: string;
  authToken: string;
  model?: string;
  requestMode: RequestMode;
  officialChatMode: OfficialChatMode;
  claudeCode: ClaudeCodeConfig;
}

export interface ServerStatus {
  kind: "starting" | "listening" | "stopped" | "error";
  detail?: string;
}