export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }

export type ChangedFile = { path: string; edits: number }

export type GitFile = { code: string; path: string }

export type BridgeWindow = { name: string; port: number | null; ageSec: number; isMe: boolean }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  model: string
  cwd: string
  contextPercent?: number
  contextTokens?: number
  contextWindow: number
  costUsd?: number
  limits: Limit[]
  branch: string | null
  git: GitFile[] | null
  windows: BridgeWindow[] | null
  mcpServers: string[]
  hasLspTool: boolean
  updatedAt: number
}

export type BridgeTask = { id: number | string; from: string; kind: string; text: string; state: string }

/** This window's own bridge, from GET /status and GET /tasks. `error` when it could not be read. */
export type BridgeStatus = {
  topic: string | null
  threadId: number | null
  isWorking: boolean
  approvals: number
  asks: number
  plans: number
  /** null: the bridge does not serve /tasks (yet), or answered that they are unavailable. */
  tasks: BridgeTask[] | null
  tasksReason?: string
  error?: string
  checkedAt: number
}

/** HyperMnesia project_status for this window's scope. */
export type MemoryStatus = {
  server: string | null
  repo: string | null
  state: string
  stale: number | null
  unindexed: number | null
  missing: number | null
  documents: number | null
  chunks: number | null
  map: string
  error?: string
  checkedAt: number
}

/** A task of this session's own task list (TaskCreate / TaskUpdate), as the calls left it. */
export type SessionTask = { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

export type AgentRow = { id: string; description: string; type: string; status: string; name?: string }

declare module 'claude-code' {
  interface PluginState {
    'pd-sidebar': {
      todos: Todo[]
      tasks: SessionTask[]
      agentsRunning: number
      files: ChangedFile[]
      snapshot: Snapshot | null
      sessionError: boolean
      bridge: BridgeStatus | null
      memory: MemoryStatus | null
      agentList: AgentRow[] | null
      agentView: { id: string; title: string; text: string; state: 'loading' | 'ready' | 'unavailable' } | null
    }
  }
}
