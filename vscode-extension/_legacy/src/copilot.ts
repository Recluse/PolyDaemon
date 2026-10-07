import * as vscode from "vscode";

import { BridgeConfig, ChatMessage, ContentPart, ImagePart, TextPart } from "./types";
import { WorkspaceToolService } from "./workspaceTools";

function isTextPart(part: ContentPart): part is TextPart {
  return part.type === "text";
}

function isImagePart(part: ContentPart): part is ImagePart {
  return part.type === "image";
}

export class CopilotService {
  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly workspaceTools: WorkspaceToolService,
  ) {}

  async listAvailableModels(): Promise<vscode.LanguageModelChat[]> {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });

    if (models.length === 0) {
      throw new Error("No GitHub Copilot chat models are currently available.");
    }

    return models;
  }

  async resolveModel(modelHint?: string): Promise<vscode.LanguageModelChat> {
    const models = await this.listAvailableModels();

    if (!modelHint) {
      return models[0];
    }

    const normalizedHint = modelHint.trim().toLowerCase();
    const matched = models.find((model) => {
      return [model.id, model.name, model.family].some((value) => value.toLowerCase() === normalizedHint);
    });

    if (matched) {
      return matched;
    }

    this.output.appendLine(`[copilot] Model hint "${modelHint}" was not found. Falling back to ${models[0].name}.`);
    return models[0];
  }

  async streamChat(
    config: BridgeConfig,
    messages: ChatMessage[],
    token: vscode.CancellationToken,
    onText: (text: string) => void,
  ): Promise<vscode.LanguageModelChat> {
    const model = await this.resolveModel(config.model);
    const containsImages = this.containsImageParts(messages);
    let emittedText = false;

    try {
      await this.streamWithModel(model, messages, token, true, (text) => {
        emittedText = true;
        onText(text);
      });
    } catch (error) {
      if (!containsImages || emittedText) {
        throw this.normalizeError(error);
      }

      this.output.appendLine("[copilot] Image input failed, retrying with text fallback.");
      await this.streamWithModel(model, messages, token, false, onText);
    }

    return model;
  }

  private async streamWithModel(
    model: vscode.LanguageModelChat,
    messages: ChatMessage[],
    token: vscode.CancellationToken,
    includeImages: boolean,
    onText: (text: string) => void,
  ): Promise<void> {
    const conversation = this.toVscodeMessages(messages, includeImages);

    for (let round = 0; round < 12; round += 1) {
      const response = await model.sendRequest(conversation, { tools: this.workspaceTools.definitions }, token);
      const assistantParts: Array<
        vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart
      > = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];

      try {
        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            assistantParts.push(part);
            onText(part.value);
            continue;
          }

          if (part instanceof vscode.LanguageModelToolCallPart) {
            assistantParts.push(part);
            toolCalls.push(part);
            continue;
          }

          if (part instanceof vscode.LanguageModelDataPart) {
            assistantParts.push(part);
            continue;
          }

          this.output.appendLine(`[copilot] Ignoring unsupported response part of type ${typeof part}.`);
        }
      } catch (error) {
        throw this.normalizeError(error);
      }

      if (toolCalls.length === 0) {
        return;
      }

      conversation.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
      const toolResults = await Promise.all(
        toolCalls.map(async (call) => {
          const result = await this.workspaceTools.invokeToolCall(call, token);
          return new vscode.LanguageModelToolResultPart(call.callId, result.content);
        }),
      );
      conversation.push(vscode.LanguageModelChatMessage.User(toolResults));
    }

    throw new Error("Workspace tool loop exceeded the maximum number of rounds.");
  }

  private toVscodeMessages(messages: ChatMessage[], includeImages: boolean): vscode.LanguageModelChatMessage[] {
    return messages.map((message) => {
      const parts = this.toInputParts(message.content, includeImages);

      if (message.role === "assistant") {
        return vscode.LanguageModelChatMessage.Assistant(parts);
      }

      return vscode.LanguageModelChatMessage.User(parts);
    });
  }

  private toInputParts(
    content: ContentPart[],
    includeImages: boolean,
  ): Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> {
    return content.map((part) => {
      if (isTextPart(part)) {
        return new vscode.LanguageModelTextPart(part.text);
      }

      if (isImagePart(part)) {
        if (includeImages) {
          try {
            return vscode.LanguageModelDataPart.image(Buffer.from(part.data, "base64"), part.mime_type);
          } catch {
            this.output.appendLine(`[copilot] Failed to decode image payload for ${part.mime_type}, using text fallback.`);
          }
        }

        return new vscode.LanguageModelTextPart(`[image omitted in MVP scaffold: ${part.mime_type}]`);
      }

      return new vscode.LanguageModelTextPart("[unsupported content part]");
    });
  }

  private containsImageParts(messages: ChatMessage[]): boolean {
    return messages.some((message) => message.content.some((part) => isImagePart(part)));
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof vscode.LanguageModelError) {
      return new Error(error.message);
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error("Unknown Copilot request failure.");
  }
}