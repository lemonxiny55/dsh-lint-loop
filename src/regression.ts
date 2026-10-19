/** DSH filesystem lifecycle adapter for regression baselines. */

import path from 'node:path'
import { lstat } from 'node:fs/promises'
import {
  consumeMutation,
  cancelMutation,
  ensureBaseline,
  hasBaseline,
  markTurnEdited,
  noteMutation,
  ownerFromActor,
  type BaselineOwner,
} from './baseline.js'
import { managerForRoot } from './manager.js'
import { prepareQualityBaseline } from './quality.js'
import { assertSafeFile, findRepoRoot, findWorkspaceRoot, resolveFileInRoot } from './workspace.js'
import { anchorEvidence, hasEvidence, snapshotWorkspace, beginDirectCheckpoint, finishDirectCheckpoint } from './evidence.js'

interface DisplayTarget {
  displayPath?: string
}
const executionDirectories = new WeakMap<object, string>()
const outerMutationActors = new WeakSet<object>()
export function endMutationDispatch(actor: object): void { outerMutationActors.delete(actor) }
/** Latest DSH keeps cwd in workingDirectory projections, not the immutable header. */
export function bindActorCwd(actor: object, cwd: string): void { executionDirectories.set(actor, cwd) }

export function actorCwd(actor: unknown): string | undefined {
  if (!actor || typeof actor !== 'object') return undefined
  const bound = executionDirectories.get(actor)
  if (bound) return bound
  const candidate = actor as {
    header?: { cwd?: string }
    session?: { header?: { cwd?: string } }
    agent?: { header?: { cwd?: string }; session?: { header?: { cwd?: string } } }
  }
  return candidate.agent?.session?.header?.cwd
    ?? candidate.agent?.header?.cwd
    ?? candidate.session?.header?.cwd
    ?? candidate.header?.cwd
}

/** Resolve an event target the same way the existing tools resolve display paths. */
export async function resolveObservedFile(
  displayPath: string,
  actor?: unknown,
): Promise<{ root: string; abs: string } | null> {
  const absolute = path.resolve(actorCwd(actor) ?? process.cwd(), displayPath)
  const root = actorCwd(actor) ? await findWorkspaceRoot(actorCwd(actor)!) : await findRepoRoot(path.dirname(absolute))
  if (!root) return null
  const abs = resolveFileInRoot(root, absolute)
  return abs ? { root, abs } : null
}

/**
 * Capture the pre-mutation findings before a DSH file tool dispatch (or an
 * older filesystem intent hook). Linter failure must never block the write;
 * the compatibility fallback uses the manager's last known store entry.
 */
export async function prepareMutation(displayPath: string | undefined, actor: unknown, outerCheckpoint = false): Promise<void> {
  if (outerCheckpoint && actor && typeof actor === 'object') outerMutationActors.add(actor)
  if (!displayPath) return
  const resolved = await resolveObservedFile(displayPath, actor)
  if (!resolved) return
  const owner = ownerFromActor(actor)
  const signal = actor && typeof actor === 'object' ? (actor as { signal?: AbortSignal }).signal : undefined
  await prepareQualityBaseline(resolved.root, owner, signal).catch(() => undefined)
  if (!hasEvidence(resolved.root, owner)) anchorEvidence(resolved.root, owner, await snapshotWorkspace(resolved.root, signal))
  const manager = managerForRoot(resolved.root)
  if (!hasBaseline(owner, resolved.abs)) {
    const previous = manager.findingsFor(resolved.abs)
    try {
      await assertSafeFile(resolved.root, resolved.abs)
      let absent = false
      try { await lstat(resolved.abs) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') absent = true; else throw error }
      const current = absent ? [] : await manager.lintFile(resolved.abs, signal)
      ensureBaseline(owner, resolved.abs, current, true)
    } catch {
      ensureBaseline(owner, resolved.abs, previous, false)
    }
  }
  noteMutation(owner, resolved.abs)
  if (actor && typeof actor === 'object' && !outerMutationActors.has(actor)) {
    await beginDirectCheckpoint(resolved.root, owner, resolved.abs, signal)
  }
}

/** Confirm and record an edit/write after the DSH tool call returned successfully. */
export async function recordSuccessfulToolMutation(
  displayPath: string | undefined,
  actor: unknown,
): Promise<{ owner: BaselineOwner | undefined; abs: string } | null> {
  if (!displayPath) return null
  const resolved = await resolveObservedFile(displayPath, actor)
  if (!resolved) return null
  const owner = ownerFromActor(actor)
  consumeMutation(owner, resolved.abs)
  markTurnEdited(owner, resolved.abs)
  await finishDirectCheckpoint(owner, resolved.abs, 'success')
  return { owner, abs: resolved.abs }
}

/** Cancel a failed DSH edit/write without leaving it in turn repair scope. */
export async function cancelToolMutation(displayPath: string | undefined, actor: unknown): Promise<void> {
  if (!displayPath) return
  const resolved = await resolveObservedFile(displayPath, actor)
  if (!resolved) return
  cancelMutation(ownerFromActor(actor), resolved.abs)
  await finishDirectCheckpoint(ownerFromActor(actor), resolved.abs, 'failure')
}

/**
 * Mark a mutation after fs/observed. The boolean tells callers whether the
 * event was tied to a modern intent hook or is a legacy/hand-test event.
 */
export function finishObservedMutation(
  target: DisplayTarget | undefined,
  actor: unknown,
): { owner: BaselineOwner | undefined; abs: string; mutation: boolean } | null {
  const displayPath = target?.displayPath
  if (!displayPath) return null
  const owner = ownerFromActor(actor)
  const abs = path.resolve(actorCwd(actor) ?? process.cwd(), displayPath)
  const mutation = consumeMutation(owner, abs)
  if (mutation) markTurnEdited(owner, abs)
  void finishDirectCheckpoint(owner, abs, 'success').catch(() => undefined)
  return { owner, abs, mutation }
}
