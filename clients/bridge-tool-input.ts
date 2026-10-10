export function guardInput(tool: string, input: any, cwd: string, agent = 'opencode') {
  const names: Record<string, string> = { shell: 'Bash', bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', glob: 'Glob', grep: 'Grep', apply_patch: 'apply_patch' }
  return { cwd, tool_name: names[tool] || (tool.includes('_') ? `mcp__${agent}__${tool}` : tool), tool_input: {
    ...input, file_path: agent === 'mimo' ? input?.file_path ?? input?.filePath : input?.filePath ?? input?.file_path,
    path: input?.path, cwd: input?.cwd ?? input?.workdir,
    ...(tool === 'apply_patch' ? { input: (agent === 'mimo' ? input?.patch_text : input?.patchText) ?? input?.input ?? (typeof input === 'string' ? input : '') } : {}),
  } }
}
