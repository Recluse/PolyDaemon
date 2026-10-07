// Read-only project file access for the board: tree + file content.
// Both are jailed to the window's cwd via realpath prefix checks — the
// daemon must never become a generic filesystem reader.
import { readdirSync, lstatSync, realpathSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join, resolve, sep } from 'path'

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'target', 'dist', 'build', 'out',
  '__pycache__', '.next', 'vendor', '.cache', '.idea', 'coverage', '.pytest_cache',
])
const MAX_ENTRIES = 8000
const MAX_FILE_BYTES = 512 * 1024

export type TreeNode = {
  name: string
  path: string           // relative to cwd, '/'-separated
  kind: 'dir' | 'file'
  size?: number
  children?: TreeNode[]
}

export function listTree(cwd: string): { tree: TreeNode[]; truncated: boolean } {
  const rootReal = realpathSync(cwd)
  let count = 0
  let truncated = false

  function walk(absDir: string, relDir: string): TreeNode[] {
    if (count >= MAX_ENTRIES) { truncated = true; return [] }
    let entries: string[]
    try { entries = readdirSync(absDir) } catch { return [] }
    entries.sort((a, b) => a.localeCompare(b))
    const dirs: TreeNode[] = []
    const files: TreeNode[] = []
    for (const name of entries) {
      if (count >= MAX_ENTRIES) { truncated = true; break }
      if (name.startsWith('.') && name !== '.claude' && name !== '.mcp.json') continue
      if (SKIP_DIRS.has(name)) continue
      const abs = join(absDir, name)
      const rel = relDir ? `${relDir}/${name}` : name
      let st
      try { st = lstatSync(abs) } catch { continue }
      // Do not follow directory links outside the project or into cycles.
      if (st.isSymbolicLink()) continue
      count++
      if (st.isDirectory()) {
        dirs.push({ name, path: rel, kind: 'dir', children: walk(abs, rel) })
      } else if (st.isFile()) {
        files.push({ name, path: rel, kind: 'file', size: st.size })
      }
    }
    return [...dirs, ...files]
  }

  return { tree: walk(rootReal, ''), truncated }
}

export function readProjectFile(cwd: string, relPath: string): {
  ok: boolean; reason?: string; content?: string; size?: number; binary?: boolean; truncated?: boolean
} {
  const rootReal = realpathSync(cwd)
  let abs: string
  try {
    abs = realpathSync(resolve(rootReal, relPath))
  } catch {
    return { ok: false, reason: 'not found' }
  }
  if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
    return { ok: false, reason: 'path escapes the workspace' }
  }
  let st
  try { st = statSync(abs) } catch { return { ok: false, reason: 'not found' } }
  if (!st.isFile()) return { ok: false, reason: 'not a file' }

  const truncated = st.size > MAX_FILE_BYTES
  const fd = openSync(abs, 'r')
  let buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES))
  try {
    let total = 0
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, total)
      if (!n) break
      total += n
    }
    buf = buf.subarray(0, total)
  } finally { closeSync(fd) }
  // Null byte in the first 8KB = binary enough for a code viewer.
  if (buf.subarray(0, 8192).includes(0)) {
    return { ok: true, binary: true, size: st.size }
  }
  return { ok: true, content: buf.toString('utf8'), size: st.size, truncated }
}
