/** Read-only, bounded source-tree checkpoints. Temporal observation is not authorship. */
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { getConfig } from './config.js'
import type { BaselineOwner } from './baseline.js'
import { normalizeDrive, toRelative } from './workspace.js'

export const CHECKPOINT_EXCLUSIONS = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.next', '.turbo']
export interface Snapshot {
  files: Map<string, string>
  complete: boolean
  reasons: string[]
  bytes: number
  elapsedMs: number
}
export interface ChangeEvidence {
  before?: string
  after?: string
  file: string
  operation: 'added' | 'modified' | 'deleted'
  attribution: 'tool-target' | 'unattributed'
  tool: string
  outcome: 'success' | 'failure' | 'cancelled' | 'verification'
}
export interface EvidenceCoverage {
  digest?: string
  status: 'complete' | 'incomplete'
  scope: 'bounded-workspace-source-tree'
  exclusions: string[]
  reasons: string[]
  changes: ChangeEvidence[]
  checkpoints: number
  bytesHashed: number
  elapsedMs: number
}
interface State {
  last?: Snapshot
  changes: ChangeEvidence[]
  reasons: Set<string>
  active: number
  checkpoints: number
  bytes: number
  elapsedMs: number
  disposed: boolean
  completedWindows: number
}
const states = new Map<BaselineOwner, Map<string, State>>()
const activeRoots = new Map<string, Set<State>>()
const GLOBAL = 'evidence:global'
const directCheckpoints = new Map<BaselineOwner, Map<string, ExecutionCheckpoint>>()
export async function beginDirectCheckpoint(root: string, owner: BaselineOwner | undefined, file: string, signal?: AbortSignal): Promise<void> {
  const entries = directCheckpoints.get(owner ?? GLOBAL) ?? new Map<string, ExecutionCheckpoint>()
  if (!entries.has(file)) entries.set(file, await beginCheckpoint(root, owner, 'edit', file, signal))
  directCheckpoints.set(owner ?? GLOBAL, entries)
}
export async function finishDirectCheckpoint(owner: BaselineOwner | undefined, file: string, outcome: ChangeEvidence['outcome']): Promise<void> {
  const entries = directCheckpoints.get(owner ?? GLOBAL), checkpoint = entries?.get(file)
  entries?.delete(file)
  if (!entries?.size) directCheckpoints.delete(owner ?? GLOBAL)
  if (checkpoint) await endCheckpoint(checkpoint, outcome)
}
function stateFor(root: string, owner?: BaselineOwner): State {
  const key = owner ?? GLOBAL
  let roots = states.get(key)
  if (!roots) { roots = new Map(); states.set(key, roots) }
  root = normalizeDrive(path.resolve(root))
  let state = roots.get(root)
  if (!state) {
    state = { changes: [], reasons: new Set(), active: 0, checkpoints: 0, bytes: 0, elapsedMs: 0, disposed: false, completedWindows: 0 }
    roots.set(root, state)
  }
  return state
}
/** Connect pre-edit baseline acquisition to the first dispatch; do not erase later history. */
export function anchorEvidence(root: string, owner: BaselineOwner | undefined, snapshot: Snapshot): void {
  const state = stateFor(root, owner)
  if (!state.last) { state.last = snapshot; for (const reason of snapshot.reasons) state.reasons.add(reason) }
}

/** No Git commands, watchers, rewinds, writes, or symlink traversal. */
export async function snapshotWorkspace(root: string, signal?: AbortSignal): Promise<Snapshot> {
  const started = Date.now(), config = getConfig()
  root = path.resolve(root)
  const result: Snapshot = { files: new Map(), complete: true, reasons: [], bytes: 0, elapsedMs: 0 }
  const fail = (reason: string) => { result.complete = false; result.reasons.push(reason) }
  let entries = 0
  let reservedBytes = 0
  let pending: Promise<void>[] = []
  const expired = () => signal?.aborted || Date.now() - started >= config.trackingTimeoutMs
  const inspectFile = async (abs: string): Promise<void> => {
    const file = toRelative(abs, root)
    try {
      const before = await lstat(abs)
      if (before.isSymbolicLink()) { fail(`symlink excluded: ${file}`); return }
      if (!before.isFile()) { fail(`special or changing file excluded: ${file}`); return }
      // Reserve synchronously before further awaits, so four readers share one byte budget.
      if (before.size > config.trackingMaxFileBytes || reservedBytes + before.size > config.trackingMaxBytes) { fail(`checkpoint byte budget exceeded: ${file}`); return }
      reservedBytes += before.size
      if (normalizeDrive(await realpath(abs)) !== normalizeDrive(abs)) { fail(`symlink excluded: ${file}`); return }
      const fd = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = await fd.stat()
        if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('file identity changed')
        const buffer = Buffer.alloc(before.size + 1)
        let length = 0
        while (length < buffer.length) {
          if (expired()) throw new Error('checkpoint cancelled or timed out')
          const read = await fd.read(buffer, length, buffer.length - length, null)
          if (!read.bytesRead) break
          length += read.bytesRead
        }
        if (length > before.size) throw new Error('file grew beyond reserved byte budget')
        result.bytes += length
        const after = await fd.stat()
        if (stat.size !== length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('file changed during checkpoint')
        result.files.set(file, `${stat.mode}:${createHash('sha256').update(buffer.subarray(0, length)).digest('hex')}`)
      } finally { await fd.close() }
    } catch (error) { fail(`unreadable or unstable path: ${file}: ${(error as Error).message}`) }
  }
  try {
    if (normalizeDrive(await realpath(root)) !== normalizeDrive(root)) throw new Error('workspace root is a symlink or non-canonical path')
    const dirs = [root]
    while (dirs.length) {
      if (expired()) { fail('checkpoint cancelled or timed out'); break }
      const dir = dirs.pop()!
      try {
        // Recheck ancestors before traversal; file realpath is checked again below.
        if (normalizeDrive(await realpath(dir)) !== normalizeDrive(dir)) { fail(`symlink excluded: ${toRelative(dir, root)}`); continue }
        const handle = await opendir(dir)
        for await (const entry of handle) {
          if (CHECKPOINT_EXCLUSIONS.includes(entry.name)) continue
          if (expired() || ++entries > config.qualityMaxFiles) { fail('checkpoint time/entry budget exceeded'); dirs.length = 0; break }
          const abs = path.join(dir, entry.name)
          if (entry.isSymbolicLink()) { fail(`symlink excluded: ${toRelative(abs, root)}`); continue }
          if (entry.isDirectory()) { dirs.push(abs); continue }
          pending.push(inspectFile(abs))
          if (pending.length === 4) { await Promise.all(pending); pending = [] }
        }
      } catch (error) { fail(`unreadable directory: ${toRelative(dir, root)}: ${(error as Error).message}`) }
    }
  } catch (error) { fail(String(error)) }
  await Promise.all(pending)
  if (expired()) fail('checkpoint cancelled or timed out')
  result.elapsedMs = Date.now() - started
  return result
}
export function snapshotDigest(snapshot: Snapshot): string {
  return createHash('sha256').update(JSON.stringify([...snapshot.files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex')
}
export function snapshotChanges(before: Snapshot, after: Snapshot): Array<Pick<ChangeEvidence, 'file' | 'operation' | 'before' | 'after'>> {
  return [...new Set([...before.files.keys(), ...after.files.keys()])].sort().flatMap((file) => {
    if (before.files.get(file) === after.files.get(file)) return []
    return [{ file, ...(before.files.has(file) ? { before: before.files.get(file)! } : {}), ...(after.files.has(file) ? { after: after.files.get(file)! } : {}), operation: !before.files.has(file) ? 'added' as const : !after.files.has(file) ? 'deleted' as const : 'modified' as const }]
  })
}
function account(state: State, snapshot: Snapshot): void {
  state.checkpoints++; state.bytes += snapshot.bytes; state.elapsedMs += snapshot.elapsedMs
  for (const reason of snapshot.reasons) state.reasons.add(reason)
}
function append(state: State, changes: ChangeEvidence[]): void {
  const limit = getConfig().qualityMaxFiles
  const remaining = Math.max(0, limit - state.changes.length)
  state.changes.push(...changes.slice(0, remaining))
  if (changes.length > remaining) state.reasons.add('change evidence event budget exceeded')
  if (state.reasons.size > 100) state.reasons = new Set([...state.reasons].slice(0, 99).concat('reason budget exceeded'))
}
export interface ExecutionCheckpoint { root: string; state: State; before: Snapshot; tool: string; target?: string; targets?: string[]; changes?: ChangeEvidence[]; commit?: { before: string | null; after: string } }
export function finalizeCheckpoint(checkpoint: ExecutionCheckpoint, result: unknown): void {
  if (result && typeof result === 'object' && (result as { isError?: boolean }).isError) {
    for (const change of checkpoint.changes ?? []) { if (change.outcome !== 'cancelled') change.outcome = 'failure'; change.attribution = 'unattributed' }
    if (checkpoint.changes?.length) checkpoint.state.reasons.add('authoritative tool result failed after filesystem effects')
  }
}
/** Validate canonical DSH commit bytes; a successful call alone does not prove disk contents. */
export function confirmToolCommit(checkpoint: ExecutionCheckpoint, result: unknown): void {
  const value = result && typeof result === 'object' ? (result as { value?: unknown }).value : undefined
  const commit = value as { path?: unknown; before?: unknown; after?: unknown } | undefined
  if (!commit || typeof commit.path !== 'string' || (commit.before !== null && typeof commit.before !== 'string') || typeof commit.after !== 'string'
    || toRelative(path.resolve(commit.path), checkpoint.root) !== checkpoint.target) {
    checkpoint.state.reasons.add('canonical file commit payload unavailable or target mismatch')
    return
  }
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  checkpoint.commit = { before: commit.before === null ? null : hash(commit.before), after: hash(commit.after) }
}
export async function beginCheckpoint(root: string, owner: BaselineOwner | undefined, tool: string, target?: string, signal?: AbortSignal): Promise<ExecutionCheckpoint> {
  root = normalizeDrive(path.resolve(root))
  const state = stateFor(root, owner)
  if (state.active++) state.reasons.add('overlapping execution windows; attribution unavailable')
  const active = activeRoots.get(root) ?? new Set<State>()
  if (active.size) {
    state.reasons.add('overlapping execution windows; attribution unavailable')
    for (const other of active) other.reasons.add('overlapping execution windows; attribution unavailable')
  }
  active.add(state); activeRoots.set(root, active)
  const before = await snapshotWorkspace(root, signal)
  account(state, before)
  if (state.last) for (const change of snapshotChanges(state.last, before)) {
    append(state, [{ ...change, attribution: 'unattributed', tool: 'between-checkpoints', outcome: 'verification' }])
    state.reasons.add('workspace changed outside an observed execution')
  }
  // A general executable may write outside the root, excluded trees or continue in background.
  if (!['edit', 'write', 'read', 'read_image'].includes(tool)) state.reasons.add('general execution has no confined filesystem mutation contract')
  return { root, state, before, tool, target: target && toRelative(path.resolve(target), root) }
}
export async function endCheckpoint(checkpoint: ExecutionCheckpoint, outcome: ChangeEvidence['outcome']): Promise<ChangeEvidence[]> {
  const { state, root, before, target, tool } = checkpoint
  // Cleanup gets its own bounded budget even after the tool's caller cancelled.
  const after = await snapshotWorkspace(root)
  if (state.disposed) return []
  account(state, after)
  if (checkpoint.commit && target) {
    const beforeHash = before.files.get(target)?.split(':')[1] ?? null
    const afterHash = after.files.get(target)?.split(':')[1]
    if (beforeHash !== checkpoint.commit.before || afterHash !== checkpoint.commit.after) state.reasons.add('canonical commit bytes disagree with execution checkpoints; possible concurrent writer')
  }
  const changes = snapshotChanges(before, after).map((change): ChangeEvidence => ({ ...change, tool, outcome,
    attribution: outcome === 'success' && (target === change.file || checkpoint.targets?.includes(change.file)) && state.active === 1 ? 'tool-target' : 'unattributed',
  }))
  for (const change of changes) if (change.attribution === 'unattributed') state.reasons.add('observed changes have uncertain authorship')
  append(state, changes)
  checkpoint.changes = changes
  state.last = after
  state.active = Math.max(0, state.active - 1)
  state.completedWindows++
  if (!state.active) activeRoots.get(root)?.delete(state)
  if (!activeRoots.get(root)?.size) activeRoots.delete(root)
  return changes
}
export async function auditCoverage(root: string, owner?: BaselineOwner): Promise<EvidenceCoverage> {
  const state = stateFor(root, owner)
  if (!state.completedWindows) state.reasons.add('no execution checkpoints available')
  const after = await snapshotWorkspace(root)
  account(state, after)
  if (state.last) for (const change of snapshotChanges(state.last, after)) {
    append(state, [{ ...change, attribution: 'unattributed', tool: 'between-checkpoints', outcome: 'verification' }])
    state.reasons.add('workspace changed outside an observed execution')
  }
  state.last = after
  const reasons = [...state.reasons, ...(state.active ? ['execution still active at verification'] : [])]
  return { digest: snapshotDigest(after), status: reasons.length ? 'incomplete' : 'complete', scope: 'bounded-workspace-source-tree', exclusions: [...CHECKPOINT_EXCLUSIONS], reasons,
    changes: structuredClone(state.changes), checkpoints: state.checkpoints, bytesHashed: state.bytes, elapsedMs: state.elapsedMs }
}
export function evidenceFiles(root: string, owner?: BaselineOwner): string[] { return [...new Set(stateFor(root, owner).changes.map((c) => path.resolve(root, c.file)))] }
export function evidenceRoots(owner?: BaselineOwner): string[] { return [...(states.get(owner ?? GLOBAL)?.keys() ?? [])] }
export function hasEvidence(root: string, owner?: BaselineOwner): boolean { return !!states.get(owner ?? GLOBAL)?.has(normalizeDrive(path.resolve(root))) }
export function clearEvidence(owner?: BaselineOwner): void {
  directCheckpoints.delete(owner ?? GLOBAL)
  for (const [root, state] of states.get(owner ?? GLOBAL) ?? []) {
    state.disposed = true
    activeRoots.get(root)?.delete(state)
    if (!activeRoots.get(root)?.size) activeRoots.delete(root)
  }
  states.delete(owner ?? GLOBAL)
}
export function disposeEvidence(): void { for (const key of states.keys()) clearEvidence(key) }
