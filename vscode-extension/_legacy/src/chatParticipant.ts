import * as vscode from "vscode";

import {
  consumeMarker,
  takePendingHandle,
  wrapStreamForPending,
} from "./officialChatBridge";
import { WorkspaceToolService } from "./workspaceTools";

export const TG_CHAT_PARTICIPANT_ID = "tg-copilot-bridge.workspace";

export function registerWorkspaceChatParticipant(
  extensionUri: vscode.Uri,
  output: vscode.OutputChannel,
  workspaceTools: WorkspaceToolService,
): vscode.ChatParticipant {
  const participant = vscode.chat.createChatParticipant(
    TG_CHAT_PARTICIPANT_ID,
    async (request, context, stream, token) => {
      const { token: bridgeToken, prompt: cleanPrompt } = consumeMarker(request.prompt);
      const pendingHandle = bridgeToken ? takePendingHandle(bridgeToken) : undefined;
      const effectiveStream = pendingHandle ? wrapStreamForPending(stream, pendingHandle) : stream;
      output.appendLine(
        `[chat] @tgbridge request${pendingHandle ? ` (telegram bridge ${bridgeToken})` : ""}: ${cleanPrompt}`,
      );
      const conversation = buildConversationHistory(context, request, cleanPrompt);
      const attachedTools = resolveAttachedTools(request.toolReferences);
      const availableTools = [...workspaceTools.definitions, ...attachedTools];
      try {
        await streamChatParticipantResponse(
          request,
          effectiveStream,
          token,
          output,
          workspaceTools,
          conversation,
          availableTools,
          attachedTools.length > 0,
        );
        pendingHandle?.resolve();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        pendingHandle?.reject(failure);
        throw failure;
      }

      return {
        metadata: {
          participant: TG_CHAT_PARTICIPANT_ID,
          attachedToolNames: attachedTools.map((tool) => tool.name),
          telegramBridgeToken: bridgeToken,
        },
      };
    },
  );

  participant.iconPath = vscode.Uri.joinPath(extensionUri, "media", "tg-bridge-chat.svg");
  participant.followupProvider = {
    provideFollowups: () => {
      return [
        { prompt: "Собери статус проекта" },
        { prompt: "Покажи ключевые файлы и текущие риски" },
        { prompt: "Найди последние изменения и объясни их" },
      ];
    },
  };

  return participant;
}

async function streamChatParticipantResponse(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
  workspaceTools: WorkspaceToolService,
  conversation: vscode.LanguageModelChatMessage[],
  availableTools: vscode.LanguageModelChatTool[],
  requireAttachedTool: boolean,
): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    const response = await request.model.sendRequest(
      conversation,
      {
        tools: availableTools,
        toolMode: requireAttachedTool && round === 0
          ? vscode.LanguageModelChatToolMode.Required
          : vscode.LanguageModelChatToolMode.Auto,
      },
      token,
    );

    const assistantParts: Array<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart
    > = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        assistantParts.push(part);
        stream.markdown(part.value);
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
    }

    if (toolCalls.length === 0) {
      return;
    }

    conversation.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    const toolResults = await Promise.all(
      toolCalls.map(async (call) => {
        stream.progress(`Running tool ${call.name}...`);
        const result = await invokeTool(call, request.toolInvocationToken, workspaceTools, token);
        output.appendLine(`[chat] Tool ${call.name} completed.`);
        return new vscode.LanguageModelToolResultPart(call.callId, result.content);
      }),
    );
    conversation.push(vscode.LanguageModelChatMessage.User(toolResults));
  }

  throw new Error("Built-in chat participant tool loop exceeded the maximum number of rounds.");
}

async function invokeTool(
  call: vscode.LanguageModelToolCallPart,
  toolInvocationToken: vscode.ChatParticipantToolToken,
  workspaceTools: WorkspaceToolService,
  token: vscode.CancellationToken,
): Promise<vscode.LanguageModelToolResult> {
  if (workspaceTools.definitions.some((tool) => tool.name === call.name)) {
    return await workspaceTools.invokeToolCall(call, token);
  }

  return await vscode.lm.invokeTool(
    call.name,
    {
      toolInvocationToken,
      input: call.input,
    },
    token,
  );
}

function buildConversationHistory(
  context: vscode.ChatContext,
  request: vscode.ChatRequest,
  promptOverride?: string,
): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];

  for (const turn of context.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      const { prompt: turnPrompt } = consumeMarker(turn.prompt);
      messages.push(vscode.LanguageModelChatMessage.User(renderPromptWithReferences(turnPrompt, turn.references)));
      continue;
    }

    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response.map(renderResponsePartToText).filter(Boolean).join("\n\n").trim();
      if (text) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
    }
  }

  const finalPrompt = promptOverride ?? request.prompt;
  messages.push(vscode.LanguageModelChatMessage.User(renderPromptWithReferences(finalPrompt, request.references, request.toolReferences)));
  return messages;
}

function renderPromptWithReferences(
  prompt: string,
  references: readonly vscode.ChatPromptReference[],
  toolReferences: readonly vscode.ChatLanguageModelToolReference[] = [],
): string {
  const sections = [prompt.trim()];
  const referenceLines = references
    .map((reference) => describeReference(reference))
    .filter((value): value is string => Boolean(value));

  if (referenceLines.length > 0) {
    sections.push(`Attached references:\n${referenceLines.join("\n")}`);
  }

  if (toolReferences.length > 0) {
    const toolNames = Array.from(new Set(toolReferences.map((reference) => reference.name))).join(", ");
    sections.push(`User-attached tools: ${toolNames}`);
  }

  return sections.filter(Boolean).join("\n\n");
}

function describeReference(reference: vscode.ChatPromptReference): string | undefined {
  if (reference.modelDescription?.trim()) {
    return `- ${reference.modelDescription.trim()}`;
  }

  const value = reference.value;
  if (typeof value === "string") {
    return `- ${value}`;
  }

  if (value instanceof vscode.Uri) {
    return `- ${value.fsPath}`;
  }

  if (value instanceof vscode.Location) {
    return `- ${value.uri.fsPath}:${value.range.start.line + 1}:${value.range.start.character + 1}`;
  }

  return undefined;
}

function renderResponsePartToText(part: vscode.ChatResponsePart): string {
  if (part instanceof vscode.ChatResponseMarkdownPart) {
    return part.value.value;
  }

  if (part instanceof vscode.ChatResponseAnchorPart) {
    return part.title ?? describeAnchorValue(part.value);
  }

  if (part instanceof vscode.ChatResponseCommandButtonPart) {
    return `[button: ${part.value.title}]`;
  }

  if (part instanceof vscode.ChatResponseFileTreePart) {
    return `[file tree with ${part.value.length} root item(s)]`;
  }

  return "";
}

function describeAnchorValue(value: vscode.Uri | vscode.Location): string {
  if (value instanceof vscode.Uri) {
    return value.fsPath;
  }

  return `${value.uri.fsPath}:${value.range.start.line + 1}:${value.range.start.character + 1}`;
}

function resolveAttachedTools(
  toolReferences: readonly vscode.ChatLanguageModelToolReference[],
): vscode.LanguageModelChatTool[] {
  if (toolReferences.length === 0) {
    return [];
  }

  const referencedNames = new Set(toolReferences.map((reference) => reference.name));
  return vscode.lm.tools
    .filter((tool) => referencedNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
}