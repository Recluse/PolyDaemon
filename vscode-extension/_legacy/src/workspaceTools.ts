import * as path from "node:path";

import * as vscode from "vscode";

const DEFAULT_EXCLUDE_GLOB = "{**/node_modules/**,**/.git/**,**/.venv/**,**/out/**}";

type ToolHandler = (input: object, token: vscode.CancellationToken) => Promise<vscode.LanguageModelToolResult>;

export class WorkspaceToolService {
  private readonly tools = new Map<string, ToolHandler>();

  readonly definitions: vscode.LanguageModelChatTool[];

  constructor(private readonly output: vscode.OutputChannel) {
    this.definitions = [
      {
        name: "list_workspace_files",
        description: "List files in the current workspace. Use this before reading files when you need to discover project structure.",
        inputSchema: {
          type: "object",
          properties: {
            glob: { type: "string", description: "Glob pattern relative to the workspace, for example src/**/*.ts" },
            limit: { type: "number", description: "Maximum number of files to return" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "read_workspace_file",
        description: "Read a file from the workspace. Provide a workspace-relative path and optional line range.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path" },
            startLine: { type: "number", description: "1-based start line" },
            endLine: { type: "number", description: "1-based end line" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "search_workspace_text",
        description: "Search plain text across workspace files. Returns matching file paths, line numbers, and matching lines.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Literal search string" },
            glob: { type: "string", description: "Optional file glob to restrict search" },
            fileLimit: { type: "number", description: "Maximum files to scan" },
            matchLimit: { type: "number", description: "Maximum matches to return" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "find_workspace_symbols",
        description: "Find workspace symbols such as classes, functions, methods, and variables by name.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Symbol search query" },
            limit: { type: "number", description: "Maximum number of symbol matches to return" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "open_workspace_file",
        description: "Open a workspace file in the editor at an optional line and column.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path" },
            line: { type: "number", description: "1-based line number to reveal" },
            column: { type: "number", description: "1-based column number to reveal" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "replace_workspace_text",
        description: "Replace exact text in a workspace file. Use only after reading the file and provide the expected occurrence count to avoid ambiguous edits.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path" },
            oldText: { type: "string", description: "Exact existing text to replace" },
            newText: { type: "string", description: "Replacement text" },
            expectedOccurrences: { type: "number", description: "Exact number of times oldText should appear. Defaults to 1." },
            openAfterEdit: { type: "boolean", description: "Whether to open the file in the editor after the edit. Defaults to true." },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
      },
      {
        name: "find_symbol_references",
        description: "Find references for a symbol at a specific file position.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path" },
            line: { type: "number", description: "1-based line number of the symbol" },
            column: { type: "number", description: "1-based column number of the symbol" },
            limit: { type: "number", description: "Maximum number of reference results to return" },
          },
          required: ["path", "line", "column"],
          additionalProperties: false,
        },
      },
      {
        name: "rename_workspace_symbol",
        description: "Rename a symbol at a specific file position using the language rename provider and apply the resulting workspace edit.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path" },
            line: { type: "number", description: "1-based line number of the symbol" },
            column: { type: "number", description: "1-based column number of the symbol" },
            newName: { type: "string", description: "New symbol name" },
            openAfterRename: { type: "boolean", description: "Whether to open the originating file after rename. Defaults to true." },
          },
          required: ["path", "line", "column", "newName"],
          additionalProperties: false,
        },
      },
    ];

    this.tools.set("list_workspace_files", (input, token) => this.listWorkspaceFiles(input as ListFilesInput, token));
    this.tools.set("read_workspace_file", (input, token) => this.readWorkspaceFile(input as ReadFileInput, token));
    this.tools.set("search_workspace_text", (input, token) => this.searchWorkspaceText(input as SearchTextInput, token));
    this.tools.set("find_workspace_symbols", (input, token) => this.findWorkspaceSymbols(input as FindSymbolsInput, token));
    this.tools.set("open_workspace_file", (input, token) => this.openWorkspaceFile(input as OpenFileInput, token));
    this.tools.set("replace_workspace_text", (input, token) => this.replaceWorkspaceText(input as ReplaceTextInput, token));
    this.tools.set("find_symbol_references", (input, token) => this.findSymbolReferences(input as FindReferencesInput, token));
    this.tools.set("rename_workspace_symbol", (input, token) => this.renameWorkspaceSymbol(input as RenameSymbolInput, token));
  }

  async invokeToolCall(
    call: vscode.LanguageModelToolCallPart,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const handler = this.tools.get(call.name);
    if (!handler) {
      return this.asTextResult(`Tool ${call.name} is not available.`);
    }

    this.output.appendLine(`[tools] Invoking ${call.name}.`);

    try {
      return await handler(call.input, token);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown tool failure.";
      this.output.appendLine(`[tools] ${call.name} failed: ${message}`);
      return this.asTextResult(`Tool ${call.name} failed: ${message}`);
    }
  }

  private async listWorkspaceFiles(input: ListFilesInput, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    const limit = clampNumber(input.limit, 1, 200, 50);
    const include = input.glob?.trim() || "**/*";
    const files = await vscode.workspace.findFiles(include, DEFAULT_EXCLUDE_GLOB, limit, token);

    if (files.length === 0) {
      return this.asTextResult("No files matched the requested pattern.");
    }

    const lines = files.map((uri) => toWorkspaceRelativePath(uri));
    return this.asTextResult(lines.join("\n"));
  }

  private async readWorkspaceFile(input: ReadFileInput, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    if (!input.path?.trim()) {
      return this.asTextResult("Missing required input: path.");
    }

    const uri = await resolveWorkspaceFile(input.path.trim());
    if (!uri) {
      return this.asTextResult(`File not found in workspace: ${input.path}`);
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    const lines = text.split(/\r?\n/);
    const startLine = clampNumber(input.startLine, 1, Math.max(lines.length, 1), 1);
    const endLine = clampNumber(input.endLine, startLine, Math.max(lines.length, startLine), Math.min(lines.length, startLine + 199));
    const numbered = lines
      .slice(startLine - 1, endLine)
      .map((line, index) => `${startLine + index}: ${line}`)
      .join("\n");

    return this.asTextResult(`FILE ${toWorkspaceRelativePath(uri)}\n${numbered}`);
  }

  private async searchWorkspaceText(input: SearchTextInput, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    if (!input.query?.trim()) {
      return this.asTextResult("Missing required input: query.");
    }

    const query = input.query.trim();
    const lowerQuery = query.toLowerCase();
    const fileLimit = clampNumber(input.fileLimit, 1, 200, 50);
    const matchLimit = clampNumber(input.matchLimit, 1, 100, 20);
    const include = input.glob?.trim() || "**/*";
    const files = await vscode.workspace.findFiles(include, DEFAULT_EXCLUDE_GLOB, fileLimit, token);
    const matches: string[] = [];

    for (const uri of files) {
      if (token.isCancellationRequested || matches.length >= matchLimit) {
        break;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      const lines = text.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= matchLimit) {
          break;
        }

        if (lines[index].toLowerCase().includes(lowerQuery)) {
          matches.push(`${toWorkspaceRelativePath(uri)}:${index + 1}: ${lines[index].trim()}`);
        }
      }
    }

    if (matches.length === 0) {
      return this.asTextResult(`No text matches for: ${query}`);
    }

    return this.asTextResult(matches.join("\n"));
  }

  private async findWorkspaceSymbols(input: FindSymbolsInput, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    if (!input.query?.trim()) {
      return this.asTextResult("Missing required input: query.");
    }

    const limit = clampNumber(input.limit, 1, 100, 20);
    const symbols = await vscode.commands.executeCommand<WorkspaceSymbolLike[]>(
      "vscode.executeWorkspaceSymbolProvider",
      input.query.trim(),
    );

    if (token.isCancellationRequested) {
      return this.asTextResult("Symbol search was cancelled.");
    }

    const results = (symbols ?? []).slice(0, limit).map((symbol) => {
      const location = getSymbolLocation(symbol);
      const range = location.range.start;
      const kind = SYMBOL_KIND_LABELS[symbol.kind] ?? `kind-${symbol.kind}`;
      const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
      return `${symbol.name} (${kind})${container} -> ${toWorkspaceRelativePath(location.uri)}:${range.line + 1}:${range.character + 1}`;
    });

    if (results.length === 0) {
      return this.asTextResult(`No workspace symbols matched: ${input.query}`);
    }

    return this.asTextResult(results.join("\n"));
  }

  private async openWorkspaceFile(input: OpenFileInput, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    if (!input.path?.trim()) {
      return this.asTextResult("Missing required input: path.");
    }

    const uri = await resolveWorkspaceFile(input.path.trim());
    if (!uri) {
      return this.asTextResult(`File not found in workspace: ${input.path}`);
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const line = clampNumber(input.line, 1, Math.max(document.lineCount, 1), 1) - 1;
    const lineText = document.lineAt(Math.min(line, document.lineCount - 1));
    const column = clampNumber(input.column, 1, Math.max(lineText.text.length + 1, 1), 1) - 1;
    const position = new vscode.Position(line, column);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);

    return this.asTextResult(`Opened ${toWorkspaceRelativePath(uri)} at ${line + 1}:${column + 1}`);
  }

  private async replaceWorkspaceText(input: ReplaceTextInput, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    if (!input.path?.trim()) {
      return this.asTextResult("Missing required input: path.");
    }
    if (input.oldText === undefined || input.oldText.length === 0) {
      return this.asTextResult("Missing required input: oldText.");
    }
    if (input.newText === undefined) {
      return this.asTextResult("Missing required input: newText.");
    }

    const uri = await resolveWorkspaceFile(input.path.trim());
    if (!uri) {
      return this.asTextResult(`File not found in workspace: ${input.path}`);
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    const expectedOccurrences = clampNumber(input.expectedOccurrences, 1, 1000, 1);
    const occurrenceCount = countOccurrences(text, input.oldText);

    if (occurrenceCount === 0) {
      return this.asTextResult(`Text to replace was not found in ${toWorkspaceRelativePath(uri)}.`);
    }

    if (occurrenceCount !== expectedOccurrences) {
      return this.asTextResult(
        `Expected ${expectedOccurrences} occurrence(s) of oldText in ${toWorkspaceRelativePath(uri)}, found ${occurrenceCount}. Edit aborted.`,
      );
    }

    const nextText = replaceAllExact(text, input.oldText, input.newText);
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, nextText);
    const applied = await vscode.workspace.applyEdit(edit);

    if (!applied) {
      return this.asTextResult(`VS Code rejected the edit for ${toWorkspaceRelativePath(uri)}.`);
    }

    const updatedDocument = await vscode.workspace.openTextDocument(uri);
    await updatedDocument.save();

    if (input.openAfterEdit !== false) {
      await vscode.window.showTextDocument(updatedDocument, { preview: false, preserveFocus: false });
    }

    return this.asTextResult(
      `Replaced ${occurrenceCount} occurrence(s) in ${toWorkspaceRelativePath(uri)} and saved the file.`,
    );
  }

  private async findSymbolReferences(input: FindReferencesInput, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    const resolved = await resolveDocumentPosition(input);
    if (typeof resolved === "string") {
      return this.asTextResult(resolved);
    }

    const limit = clampNumber(input.limit, 1, 200, 50);
    const references = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      resolved.uri,
      resolved.position,
    );

    if (token.isCancellationRequested) {
      return this.asTextResult("Reference search was cancelled.");
    }

    const results = (references ?? []).slice(0, limit).map((location) => {
      return `${toWorkspaceRelativePath(location.uri)}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
    });

    if (results.length === 0) {
      return this.asTextResult(
        `No references found at ${toWorkspaceRelativePath(resolved.uri)}:${resolved.position.line + 1}:${resolved.position.character + 1}.`,
      );
    }

    return this.asTextResult(results.join("\n"));
  }

  private async renameWorkspaceSymbol(input: RenameSymbolInput, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    if (!input.newName?.trim()) {
      return this.asTextResult("Missing required input: newName.");
    }

    const resolved = await resolveDocumentPosition(input);
    if (typeof resolved === "string") {
      return this.asTextResult(resolved);
    }

    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
      "vscode.executeDocumentRenameProvider",
      resolved.uri,
      resolved.position,
      input.newName.trim(),
    );

    if (!edit) {
      return this.asTextResult(
        `Rename provider did not return edits for ${toWorkspaceRelativePath(resolved.uri)}:${resolved.position.line + 1}:${resolved.position.character + 1}.`,
      );
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      return this.asTextResult(`VS Code rejected the rename edit for ${toWorkspaceRelativePath(resolved.uri)}.`);
    }

    await vscode.workspace.saveAll(false);

    if (input.openAfterRename !== false) {
      const updatedDocument = await vscode.workspace.openTextDocument(resolved.uri);
      await vscode.window.showTextDocument(updatedDocument, { preview: false, preserveFocus: false });
    }

    const touchedFiles = edit
      .entries()
      .map(([uri]) => toWorkspaceRelativePath(uri));
    const uniqueTouchedFiles = Array.from(new Set(touchedFiles));

    return this.asTextResult(
      `Renamed symbol to ${input.newName.trim()} across ${uniqueTouchedFiles.length || 1} file(s): ${uniqueTouchedFiles.join(", ") || toWorkspaceRelativePath(resolved.uri)}.`,
    );
  }

  private asTextResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
  }
}

interface ListFilesInput {
  glob?: string;
  limit?: number;
}

interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

interface SearchTextInput {
  query: string;
  glob?: string;
  fileLimit?: number;
  matchLimit?: number;
}

interface FindSymbolsInput {
  query: string;
  limit?: number;
}

interface OpenFileInput {
  path: string;
  line?: number;
  column?: number;
}

interface ReplaceTextInput {
  path: string;
  oldText: string;
  newText: string;
  expectedOccurrences?: number;
  openAfterEdit?: boolean;
}

interface FindReferencesInput {
  path: string;
  line: number;
  column: number;
  limit?: number;
}

interface RenameSymbolInput {
  path: string;
  line: number;
  column: number;
  newName: string;
  openAfterRename?: boolean;
}

interface WorkspaceSymbolLike {
  name: string;
  kind: vscode.SymbolKind;
  location: vscode.Location | { uri: vscode.Uri; range: vscode.Range };
  containerName?: string;
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(value), min), max);
}

async function resolveWorkspaceFile(candidatePath: string): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return undefined;
  }

  const normalizedCandidate = candidatePath.replace(/\\/g, "/");

  for (const folder of folders) {
    const uri = path.isAbsolute(candidatePath)
      ? vscode.Uri.file(candidatePath)
      : vscode.Uri.joinPath(folder.uri, normalizedCandidate);

    try {
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {
      // Keep looking.
    }
  }

  return undefined;
}

function toWorkspaceRelativePath(uri: vscode.Uri): string {
  const relative = vscode.workspace.asRelativePath(uri, false);
  return relative || uri.fsPath;
}

function countOccurrences(text: string, fragment: string): number {
  if (fragment.length === 0) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (true) {
    const next = text.indexOf(fragment, offset);
    if (next === -1) {
      return count;
    }

    count += 1;
    offset = next + fragment.length;
  }
}

function replaceAllExact(text: string, oldText: string, newText: string): string {
  return text.split(oldText).join(newText);
}

function getSymbolLocation(symbol: WorkspaceSymbolLike): { uri: vscode.Uri; range: vscode.Range } {
  const location = symbol.location as vscode.Location | { uri: vscode.Uri; range: vscode.Range };
  return { uri: location.uri, range: location.range };
}

async function resolveDocumentPosition(
  input: { path: string; line: number; column: number },
): Promise<{ uri: vscode.Uri; document: vscode.TextDocument; position: vscode.Position } | string> {
  if (!input.path?.trim()) {
    return "Missing required input: path.";
  }

  const uri = await resolveWorkspaceFile(input.path.trim());
  if (!uri) {
    return `File not found in workspace: ${input.path}`;
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const line = clampNumber(input.line, 1, Math.max(document.lineCount, 1), 1) - 1;
  const lineText = document.lineAt(Math.min(line, document.lineCount - 1));
  const column = clampNumber(input.column, 1, Math.max(lineText.text.length + 1, 1), 1) - 1;
  return {
    uri,
    document,
    position: new vscode.Position(line, column),
  };
}

const SYMBOL_KIND_LABELS: Record<number, string> = {
  [vscode.SymbolKind.Array]: "array",
  [vscode.SymbolKind.Boolean]: "boolean",
  [vscode.SymbolKind.Class]: "class",
  [vscode.SymbolKind.Constant]: "constant",
  [vscode.SymbolKind.Constructor]: "constructor",
  [vscode.SymbolKind.Enum]: "enum",
  [vscode.SymbolKind.EnumMember]: "enum-member",
  [vscode.SymbolKind.Event]: "event",
  [vscode.SymbolKind.Field]: "field",
  [vscode.SymbolKind.File]: "file",
  [vscode.SymbolKind.Function]: "function",
  [vscode.SymbolKind.Interface]: "interface",
  [vscode.SymbolKind.Key]: "key",
  [vscode.SymbolKind.Method]: "method",
  [vscode.SymbolKind.Module]: "module",
  [vscode.SymbolKind.Namespace]: "namespace",
  [vscode.SymbolKind.Null]: "null",
  [vscode.SymbolKind.Number]: "number",
  [vscode.SymbolKind.Object]: "object",
  [vscode.SymbolKind.Operator]: "operator",
  [vscode.SymbolKind.Package]: "package",
  [vscode.SymbolKind.Property]: "property",
  [vscode.SymbolKind.String]: "string",
  [vscode.SymbolKind.Struct]: "struct",
  [vscode.SymbolKind.TypeParameter]: "type-parameter",
  [vscode.SymbolKind.Variable]: "variable",
};