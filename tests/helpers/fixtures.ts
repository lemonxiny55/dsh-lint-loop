/** Shared fixture helpers: temp git-shaped repos + the fake linter paths. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the fake linter used by every process-spawning test. */
export function fakeLinterPath(): string {
  return fileURLToPath(new URL('./fakeLinter.mjs', import.meta.url))
}

/** Absolute path of the never-finishing linter used by the timeout test. */
export function slowLinterPath(): string {
  return fileURLToPath(new URL('./slowLinter.mjs', import.meta.url))
}

export interface FixtureRepo {
  root: string
  /** Write a file (repo-relative) with the given content; returns its absolute path. */
  write(relPath: string, content: string): Promise<string>
}

/** A temp directory with a `.git` marker — enough for findRepoRoot to adopt it. */
export async function makeFixtureRepo(): Promise<FixtureRepo> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-lint-loop-'))
  await mkdir(path.join(root, '.git'))
  return {
    root,
    async write(relPath, content) {
      const abs = path.join(root, relPath)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      return abs
    },
  }
}

/** A TS file with one error, one warning, and one fixable warning. */
export const SAMPLE_TS = [
  'const unused = 1 // lint: warning no-unused-vars unused is declared but never used',
  'debugger // lint: error no-debugger no debugger statements allowed',
  'let x = 1 // lint: warning semi missing semicolon [fixable]',
  '',
].join('\n')

/** A Python file with one error and one fixable error (ruff-style rules). */
export const SAMPLE_PY = [
  'import os  # lint: error F401 os imported but never used',
  'x = 1  # lint: error E501 line too long [fixable]',
  '',
].join('\n')
