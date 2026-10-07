import * as vscode from "vscode";

import { ServerStatus } from "./types";

export interface PanelModelOption {
  value: string;
  label: string;
  description?: string;
}

type TranscriptRole = "telegram" | "panel" | "assistant" | "system";
type TranscriptState = "streaming" | "done" | "error";

interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  title: string;
  text: string;
  state: TranscriptState;
}

interface PanelState {
  bridgeStatus: string;
  composerBusy: boolean;
  modelBusy: boolean;
  selectedModel: string;
  availableModels: PanelModelOption[];
  entries: TranscriptEntry[];
}

export interface ChatMirrorSink {
  reveal(): void;
  setBridgeStatus(status: ServerStatus): void;
  setModelOptions(options: PanelModelOption[], selectedModel: string): void;
  setModelBusy(isBusy: boolean): void;
  showTelegramMessage(requestId: string, text: string, instanceName: string): void;
  showPanelMessage(requestId: string, text: string): void;
  appendAssistantChunk(requestId: string, text: string): void;
  completeAssistantMessage(requestId: string): void;
  failAssistantMessage(requestId: string, message: string): void;
  setComposerBusy(isBusy: boolean): void;
}

export class ChatMirrorPanel implements vscode.Disposable, ChatMirrorSink {
  private panel: vscode.WebviewPanel | undefined;
  private readonly state: PanelState = {
    bridgeStatus: "Bridge not started.",
    composerBusy: false,
    modelBusy: false,
    selectedModel: "",
    availableModels: [{ value: "", label: "Auto" }],
    entries: [],
  };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onSubmitPrompt: (prompt: string) => Promise<void>,
    private readonly onSelectModel: (value: string) => Promise<void>,
  ) {}

  dispose(): void {
    this.panel?.dispose();
  }

  reveal(): void {
    this.ensurePanel(true);
  }

  setBridgeStatus(status: ServerStatus): void {
    const label = status.detail ? `${status.kind}: ${status.detail}` : status.kind;
    this.state.bridgeStatus = label;
    void this.postState();
  }

  setModelOptions(options: PanelModelOption[], selectedModel: string): void {
    this.state.availableModels = options;
    this.state.selectedModel = selectedModel;
    void this.postState();
  }

  setModelBusy(isBusy: boolean): void {
    this.state.modelBusy = isBusy;
    void this.postState();
  }

  showTelegramMessage(requestId: string, text: string, instanceName: string): void {
    this.ensurePanel(true);
    this.pushUserEntry(requestId, "telegram", `Telegram -> ${instanceName}`, text);
    this.pushAssistantPlaceholder(requestId);
    void this.postState();
  }

  showPanelMessage(requestId: string, text: string): void {
    this.ensurePanel(true);
    this.pushUserEntry(requestId, "panel", "Panel -> Workspace", text);
    this.pushAssistantPlaceholder(requestId);
    void this.postState();
  }

  appendAssistantChunk(requestId: string, text: string): void {
    const entry = this.findAssistantEntry(requestId);
    if (!entry) {
      return;
    }

    entry.text += text;
    entry.state = "streaming";
    void this.postState();
  }

  completeAssistantMessage(requestId: string): void {
    const entry = this.findAssistantEntry(requestId);
    if (!entry) {
      return;
    }

    entry.state = "done";
    void this.postState();
  }

  failAssistantMessage(requestId: string, message: string): void {
    const entry = this.findAssistantEntry(requestId);
    if (!entry) {
      this.state.entries.push({
        id: `${requestId}:assistant`,
        role: "assistant",
        title: "Workspace Copilot",
        text: message,
        state: "error",
      });
    } else {
      entry.text = message;
      entry.state = "error";
    }

    void this.postState();
  }

  setComposerBusy(isBusy: boolean): void {
    this.state.composerBusy = isBusy;
    void this.postState();
  }

  private findAssistantEntry(requestId: string): TranscriptEntry | undefined {
    return this.state.entries.find((entry) => entry.id === `${requestId}:assistant`);
  }

  private ensurePanel(reveal: boolean): void {
    if (this.panel) {
      if (reveal) {
        this.panel.reveal(vscode.ViewColumn.Beside, true);
      }
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "tgCopilotBridge.workspaceChat",
      "TG Workspace Chat",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === "submitPrompt" && typeof message.prompt === "string") {
        const prompt = message.prompt.trim();
        if (!prompt) {
          return;
        }

        void this.onSubmitPrompt(prompt).catch((error) => {
          const submitMessage = error instanceof Error ? error.message : "Unknown panel submission error.";
          void vscode.window.showErrorMessage(`TG Workspace Chat: ${submitMessage}`);
        });
        return;
      }

      if (message?.type !== "selectModel" || typeof message.value !== "string") {
        return;
      }

      void this.onSelectModel(message.value).catch((error) => {
        const selectMessage = error instanceof Error ? error.message : "Unknown panel model selection error.";
        void vscode.window.showErrorMessage(`TG Workspace Chat: ${selectMessage}`);
      });
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    void this.postState();
  }

  private async postState(): Promise<void> {
    if (!this.panel) {
      return;
    }

    await this.panel.webview.postMessage({ type: "state", state: this.state });
  }

  private getHtml(): string {
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TG Workspace Chat</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --telegram: rgba(64, 156, 255, 0.14);
      --assistant: rgba(0, 200, 140, 0.12);
      --panel: rgba(255, 180, 40, 0.12);
      --error: rgba(255, 80, 80, 0.15);
      --button: var(--vscode-button-background);
      --button-hover: var(--vscode-button-hoverBackground);
      --button-fg: var(--vscode-button-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
    }

    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      background: var(--bg);
      color: var(--fg);
    }

    header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--bg);
      z-index: 10;
    }

    .header-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    .header-copy {
      min-width: 0;
      flex: 1;
    }

    header h1 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }

    header p {
      margin: 8px 0 0;
      font-size: 12px;
      color: var(--muted);
    }

    .model-picker {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 210px;
    }

    .model-picker-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .model-picker select {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      padding: 8px 10px;
      font: inherit;
      outline: none;
    }

    main {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-bottom: 112px;
    }

    .entry {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .entry.telegram { background: var(--telegram); }
    .entry.panel { background: var(--panel); }
    .entry.assistant { background: var(--assistant); }
    .entry.assistant.error { background: var(--error); }

    .title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 8px;
    }

    .empty {
      color: var(--muted);
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 16px;
    }

    .streaming::after {
      content: " ●";
      animation: pulse 1s infinite ease-in-out;
    }

    .composer {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 92%, transparent);
      backdrop-filter: blur(6px);
      display: flex;
      gap: 10px;
      align-items: flex-end;
    }

    .composer textarea {
      flex: 1;
      min-height: 64px;
      max-height: 200px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--input-bg);
      color: var(--input-fg);
      padding: 10px 12px;
      font: inherit;
    }

    .composer button {
      border: 0;
      border-radius: 10px;
      background: var(--button);
      color: var(--button-fg);
      padding: 10px 14px;
      font: inherit;
      cursor: pointer;
    }

    .composer button:hover { background: var(--button-hover); }
    .composer button:disabled,
    .composer textarea:disabled,
    .model-picker select:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.25; }
      50% { opacity: 1; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <div class="header-copy">
        <h1>TG Workspace Chat</h1>
      </div>
      <label class="model-picker">
        <span class="model-picker-label">Model</span>
        <select id="modelSelect"></select>
      </label>
    </div>
    <p id="status">Waiting for bridge activity…</p>
  </header>
  <main id="entries">
    <div class="empty">Telegram messages will appear here automatically. Responses are generated with workspace-aware tools.</div>
  </main>
  <form class="composer" id="composer">
    <textarea id="prompt" placeholder="Type directly in VS Code to continue this workspace chat..."></textarea>
    <button id="send" type="submit">Send</button>
  </form>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const entriesRoot = document.getElementById('entries');
    const statusRoot = document.getElementById('status');
    const composer = document.getElementById('composer');
    const promptInput = document.getElementById('prompt');
    const sendButton = document.getElementById('send');
    const modelSelect = document.getElementById('modelSelect');
    let modelSignature = '';

    function syncModelOptions(state) {
      const nextSignature = state.availableModels
        .map((option) => [option.value, option.label, option.description || ''].join('|'))
        .join('||');

      if (nextSignature !== modelSignature) {
        modelSelect.innerHTML = '';
        for (const option of state.availableModels) {
          const node = document.createElement('option');
          node.value = option.value;
          node.textContent = option.description ? option.label + ' - ' + option.description : option.label;
          modelSelect.appendChild(node);
        }
        modelSignature = nextSignature;
      }

      const selectedValue = state.selectedModel || '';
      const hasSelectedOption = Array.from(modelSelect.options).some((option) => option.value === selectedValue);
      modelSelect.value = hasSelectedOption ? selectedValue : '';
      modelSelect.disabled = !!state.modelBusy || !!state.composerBusy || state.availableModels.length === 0;
    }

    function render(state) {
      statusRoot.textContent = state.bridgeStatus;
      promptInput.disabled = !!state.composerBusy;
      sendButton.disabled = !!state.composerBusy;
      sendButton.textContent = state.composerBusy ? 'Sending…' : 'Send';
      syncModelOptions(state);
      if (!state.entries.length) {
        entriesRoot.innerHTML = '<div class="empty">Telegram messages will appear here automatically. Responses are generated with workspace-aware tools.</div>';
        return;
      }

      entriesRoot.innerHTML = '';
      for (const entry of state.entries) {
        const node = document.createElement('section');
        node.className = 'entry ' + entry.role + (entry.state === 'error' ? ' error' : '');
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = entry.title + (entry.state === 'streaming' ? ' streaming' : '');
        const body = document.createElement('div');
        body.textContent = entry.text || (entry.state === 'streaming' ? '…' : '');
        node.appendChild(title);
        node.appendChild(body);
        entriesRoot.appendChild(node);
      }
    }

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data?.type === 'state') {
        render(data.state);
      }
    });

    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      const prompt = promptInput.value.trim();
      if (!prompt || sendButton.disabled) {
        return;
      }

      vscode.postMessage({ type: 'submitPrompt', prompt });
      promptInput.value = '';
    });

    modelSelect.addEventListener('change', () => {
      if (modelSelect.disabled) {
        return;
      }

      vscode.postMessage({ type: 'selectModel', value: modelSelect.value });
    });
  </script>
</body>
</html>`;
  }

  private pushUserEntry(requestId: string, role: TranscriptRole, title: string, text: string): void {
    this.state.entries.push({
      id: `${requestId}:${role}`,
      role,
      title,
      text,
      state: "done",
    });
  }

  private pushAssistantPlaceholder(requestId: string): void {
    this.state.entries.push({
      id: `${requestId}:assistant`,
      role: "assistant",
      title: "Workspace Copilot",
      text: "",
      state: "streaming",
    });
  }
}

function createNonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}