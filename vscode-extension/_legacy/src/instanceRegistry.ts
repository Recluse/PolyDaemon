import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { BridgeConfig } from "./types";

interface RegisteredWindow {
  key: string;
  host: string;
  port: number;
  auth_token: string;
  instance_name: string;
  workspace_name: string;
  workspace_folders: string[];
  updated_at: string;
}

export class InstanceRegistry implements vscode.Disposable {
  private currentFilePath: string | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  async register(config: BridgeConfig): Promise<void> {
    const directoryPath = getRegistryDirectoryPath();
    const filePath = getRegistrationFilePath(config);

    if (this.currentFilePath && this.currentFilePath !== filePath) {
      await this.deleteFile(this.currentFilePath);
    }

    await fs.mkdir(directoryPath, { recursive: true });
    const payload: RegisteredWindow = {
      key: buildInstanceKey(config),
      host: config.host,
      port: config.port,
      auth_token: config.authToken,
      instance_name: config.instanceName,
      workspace_name: getWorkspaceDisplayName(config),
      workspace_folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.name),
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    this.currentFilePath = filePath;
    this.output.appendLine(`[registry] Registered window ${payload.workspace_name} at ${payload.host}:${payload.port}.`);
  }

  async unregister(): Promise<void> {
    if (!this.currentFilePath) {
      return;
    }

    await this.deleteFile(this.currentFilePath);
    this.currentFilePath = undefined;
  }

  dispose(): void {
    void this.unregister();
  }

  private async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      if (code !== "ENOENT") {
        this.output.appendLine(`[registry] Failed to delete ${filePath}: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
  }
}

function getWorkspaceDisplayName(config: BridgeConfig): string {
  const workspaceName = vscode.workspace.name?.trim();
  if (workspaceName) {
    return workspaceName;
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) {
    return folders[0].name;
  }

  if (folders.length > 1) {
    return folders.map((folder) => folder.name).join(", ");
  }

  return config.instanceName || `window-${config.port}`;
}

function buildInstanceKey(config: BridgeConfig): string {
  return `${config.host}:${config.port}`;
}

function getRegistryDirectoryPath(): string {
  return path.join(os.homedir(), ".tg-copilot-bridge", "instances");
}

function getRegistrationFilePath(config: BridgeConfig): string {
  const fileName = `${config.host.replace(/[^a-zA-Z0-9.-]/g, "_")}-${config.port}.json`;
  return path.join(getRegistryDirectoryPath(), fileName);
}