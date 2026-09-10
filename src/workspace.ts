/** Workspace resolution and file↔path helpers. */

import { stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Locate the git repo root for a path by walking up to the nearest `.git`
 * directory. Bounded walk (max `maxLevels` levels); returns `null` when no
 * repo marker is found — callers must NOT adopt an untagged directory as a
 * workspace (the fs root is the classic footgun: linting `C:\` by accident).
 */
export async function findRepoRoot(startDir: string, maxLevels = 12): Promise<string | null> {
  let dir = path.resolve(startDir)
  for (let level = 0; level < maxLevels; level++) {
    try {
      // stat() accepts BOTH a `.git` directory (normal repos) and a `.git`
      // file (worktrees / submodules).
      await stat(path.join(dir, '.git'))
      return dir
    } catch {
      // not a repo here — keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Resolve a user-supplied file argument (absolute or workspace-relative) to an
 * absolute path strictly inside `root`, or `null` when it escapes the
 * workspace — a file outside the repo must never reach a linter.
 */
export function resolveFileInRoot(root: string, file: string): string | null {
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file)
  const rel = path.relative(root, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

/**
 * Windows drive-letter case normalization. Tool arguments and linter outputs
 * can disagree on the drive's case (C: vs c: on absolute paths reported by
 * linters) — without this, one store ends up with two keys for the same file.
 */
export function normalizeDrive(absPath: string): string {
  return process.platform === 'win32' ? absPath.replace(/^[a-zA-Z]:/, (m) => m.toUpperCase()) : absPath
}

/** Repo-relative, forward-slash form for display and output. */
export function toRelative(absPath: string, root: string): string {
  return path.relative(root, absPath).split(path.sep).join('/')
}
