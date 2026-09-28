/**
 * Per-session regression baselines.
 *
 * A baseline is captured immediately before a DSH edit/write tool dispatch.
 * State uses the stable session ID when available, with the session object as
 * a compatibility fallback, so cloned execution objects still share a turn.
 */

import path from 'node:path'
import {
  findingFingerprint,
  matchFindings,
  type Finding,
  type FindingScope,
} from './findings.js'
import { normalizeDrive } from './workspace.js'

export type BaselineOwner = object | string

const GLOBAL_OWNER = 'dsh-lint-loop:global'
interface BaselineEntry {
  findings: Finding[]
  /** True when the entry came from a pre-mutation lint, not a compatibility fallback. */
  authoritative: boolean
}

const states = new Map<BaselineOwner, Map<string, BaselineEntry>>()
const pendingMutations = new Map<BaselineOwner, Set<string>>()
const editedThisTurn = new Map<BaselineOwner, Set<string>>()

/** Share one owner key across cloned DSH execution objects for the same session. */
function ownerFromSession(session: unknown): BaselineOwner | undefined {
  if (!session || typeof session !== 'object') return undefined
  const candidate = session as { id?: unknown; header?: { id?: unknown } }
  const id = typeof candidate.id === 'string'
    ? candidate.id
    : typeof candidate.header?.id === 'string'
      ? candidate.header.id
      : undefined
  return id ? `dsh-lint-loop:session:${id}` : session
}

/** Extract the stable opaque session identity carried by DSH tool executions. */
export function ownerFromActor(actor: unknown): BaselineOwner | undefined {
  if (!actor || typeof actor !== 'object') return undefined
  const candidate = actor as { agent?: { session?: object } | object; session?: object }
  if (candidate.agent && typeof candidate.agent === 'object') {
    const agent = candidate.agent as { session?: object }
    return ownerFromSession(agent.session) ?? candidate.agent
  }
  return ownerFromSession(candidate.session) ?? actor
}

/** Extract the same owner from an agent/turn-stopping payload. */
export function ownerFromAgent(agent: unknown): BaselineOwner | undefined {
  if (!agent || typeof agent !== 'object') return undefined
  const candidate = agent as { session?: object; id?: string }
  return ownerFromSession(candidate.session)
    ?? (candidate.id ? `dsh-lint-loop:agent:${candidate.id}` : agent)
}

function ownerKey(owner: BaselineOwner | undefined): BaselineOwner {
  return owner ?? GLOBAL_OWNER
}

function fileKey(absPath: string): string {
  return normalizeDrive(path.resolve(absPath))
}

export interface FindingDelta {
  current: Array<Finding & { scope: Exclude<FindingScope, 'resolved'> }>
  preexisting: Finding[]
  introduced: Finding[]
  changed: Finding[]
  resolved: Finding[]
}

/** Return an existing baseline, if this owner has begun tracking the file. */
export function baselineFor(owner: BaselineOwner | undefined, absPath: string): Finding[] | undefined {
  return states.get(ownerKey(owner))?.get(fileKey(absPath))?.findings
}

export function hasBaseline(owner: BaselineOwner | undefined, absPath: string): boolean {
  return states.get(ownerKey(owner))?.has(fileKey(absPath)) ?? false
}

/** Mark a file confirmed through a successful DSH edit/write in this turn. */
export function markTurnEdited(owner: BaselineOwner | undefined, absPath: string): void {
  const key = ownerKey(owner)
  const files = editedThisTurn.get(key) ?? new Set<string>()
  files.add(fileKey(absPath))
  editedThisTurn.set(key, files)
}

/** Edited files are narrower than baseline files (tools may establish baselines too). */
export function turnEditedFiles(owner: BaselineOwner | undefined): string[] {
  return [...(editedThisTurn.get(ownerKey(owner)) ?? [])]
}

/** Capture once per owner/file; later edits in the same turn keep the original baseline. */
export function ensureBaseline(
  owner: BaselineOwner | undefined,
  absPath: string,
  findings: readonly Finding[],
  authoritative = false,
): Finding[] {
  const key = ownerKey(owner)
  const file = fileKey(absPath)
  let state = states.get(key)
  if (!state) {
    state = new Map()
    states.set(key, state)
  }
  const existing = state.get(file)
  if (existing) return existing.findings
  const snapshot = [...findings]
  state.set(file, { findings: snapshot, authoritative })
  return snapshot
}

/** Mark a file as part of the current owner/turn without replacing its baseline. */
export function touchBaseline(owner: BaselineOwner | undefined, absPath: string, findings: readonly Finding[]): void {
  ensureBaseline(owner, absPath, findings, false)
}

/**
 * Classify the current findings against the baseline. `scope` is attached only
 * to the current side; resolved findings are returned separately because they
 * no longer exist in the current linter result.
 */
export function classifyFindings(
  owner: BaselineOwner | undefined,
  absPath: string,
  current: readonly Finding[],
): FindingDelta {
  const previous = baselineFor(owner, absPath) ?? []
  const match = matchFindings(previous, current)
  const currentByIndex = new Map<number, Finding & { scope: Exclude<FindingScope, 'resolved'> }>()
  const preexisting: Finding[] = []
  const introduced: Finding[] = []
  const changed: Finding[] = []

  for (const item of match.matches) {
    const finding = current[item.current]
    if (item.exact) {
      const scoped = { ...finding, scope: 'preexisting' as const }
      preexisting.push(scoped)
      currentByIndex.set(item.current, scoped)
    } else {
      const scoped = { ...finding, scope: 'changed' as const }
      changed.push(scoped)
      currentByIndex.set(item.current, scoped)
    }
  }
  for (const index of match.unmatchedCurrent) {
    const scoped = { ...current[index], scope: 'introduced' as const }
    introduced.push(scoped)
    currentByIndex.set(index, scoped)
  }

  return {
    current: current.map((_, index) => currentByIndex.get(index)!).filter(Boolean),
    preexisting,
    introduced,
    changed,
    resolved: match.unmatchedPrevious.map((index) => ({ ...previous[index], scope: 'resolved' as const })),
  }
}

export function classifyWithoutBaseline(current: readonly Finding[]): Array<Finding & { scope: 'preexisting' }> {
  return current.map((finding) => ({ ...finding, scope: 'preexisting' as const }))
}

/** A concise status useful to diagnostics and release evidence. */
export function baselineSummary(delta: FindingDelta): string {
  return `introduced=${delta.introduced.length}, changed=${delta.changed.length}, `
    + `preexisting=${delta.preexisting.length}, resolved=${delta.resolved.length}`
}

/** Clear turn state for one owner; called after the gate admits or gives up. */
export function clearBaseline(owner: BaselineOwner | undefined, absPaths?: readonly string[]): void {
  const key = ownerKey(owner)
  const state = states.get(key)
  if (!state) {
    if (!absPaths) pendingMutations.delete(key)
    return
  }
  if (!absPaths) {
    states.delete(key)
    pendingMutations.delete(key)
    editedThisTurn.delete(key)
    return
  }
  const pending = pendingMutations.get(key)
  const edited = editedThisTurn.get(key)
  for (const absPath of absPaths) {
    state.delete(fileKey(absPath))
    pending?.delete(fileKey(absPath))
    edited?.delete(fileKey(absPath))
  }
  if (pending?.size === 0) pendingMutations.delete(key)
  if (edited?.size === 0) editedThisTurn.delete(key)
  if (state.size === 0) states.delete(key)
}

export function clearAllBaselines(): void {
  states.clear()
  pendingMutations.clear()
  editedThisTurn.clear()
}

export function noteMutation(owner: BaselineOwner | undefined, absPath: string): void {
  const key = ownerKey(owner)
  const pending = pendingMutations.get(key) ?? new Set<string>()
  pending.add(fileKey(absPath))
  pendingMutations.set(key, pending)
}

/** Return true only for an observed event that follows a mutation intent. */
export function consumeMutation(owner: BaselineOwner | undefined, absPath: string): boolean {
  const key = ownerKey(owner)
  const pending = pendingMutations.get(key)
  if (!pending?.has(fileKey(absPath))) return false
  pending.delete(fileKey(absPath))
  if (pending.size === 0) pendingMutations.delete(key)
  return true
}

/** Drop a failed mutation intent, and its baseline if no successful edit used it. */
export function cancelMutation(owner: BaselineOwner | undefined, absPath: string): void {
  const key = ownerKey(owner)
  const file = fileKey(absPath)
  const pending = pendingMutations.get(key)
  pending?.delete(file)
  if (pending?.size === 0) pendingMutations.delete(key)
  if (!editedThisTurn.get(key)?.has(file)) clearBaseline(owner, [file])
}

/** The robust identity is intentionally exported for tests and diagnostics. */
export { findingFingerprint }
