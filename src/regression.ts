/** DSH filesystem lifecycle adapter for regression baselines. */

import path from 'node:path'
import {
  consumeMutation,
  ensureBaseline,
  hasBaseline,
  noteMutation,
  ownerFromActor,
  type BaselineOwner,
} from './baseline.js'
import { managerForRoot } from './manager.js'
import { findRepoRoot, resolveFileInRoot } from './workspace.js'

interface DisplayTarget {
  displayPath?: string
}

function actorCwd(actor: unknown): string | undefined {
  if (!actor || typeof actor !== 'object') return undefined
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
  const root = await findRepoRoot(path.dirname(absolute))
  if (!root) return null
  const abs = resolveFileInRoot(root, absolute)
  return abs ? { root, abs } : null
}

/**
 * Capture the pre-mutation findings before the filesystem waterfall delegates
 * to the harness policy. The linter is allowed to fail here: an unavailable
 * linter must never block a write, and the compatibility fallback can still
 * use the manager's last known store entry.
 */
export async function prepareMutation(displayPath: string | undefined, actor: unknown): Promise<void> {
  if (!displayPath) return
  const resolved = await resolveObservedFile(displayPath, actor)
  if (!resolved) return
  const owner = ownerFromActor(actor)
  const manager = managerForRoot(resolved.root)
  if (!hasBaseline(owner, resolved.abs)) {
    const previous = manager.findingsFor(resolved.abs)
    try {
      const current = await manager.lintFile(resolved.abs)
      ensureBaseline(owner, resolved.abs, current, true)
    } catch {
      ensureBaseline(owner, resolved.abs, previous, false)
    }
  }
  noteMutation(owner, resolved.abs)
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
  return { owner, abs, mutation }
}
