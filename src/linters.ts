/** Per-linter spawn configuration and file-extension routing. */

import path from 'node:path'

export const LINTER_KEYS = ['eslint', 'biome', 'ruff'] as const

export type LinterKey = (typeof LINTER_KEYS)[number]

export interface LinterSpec {
  key: LinterKey
  /** Binary we expect on PATH — used in error messages. */
  displayName: string
  command: string
  /** Args prepended before the file path for a plain lint run. */
  lintArgs: string[]
  /** Args prepended before the file path for an auto-fix run. */
  fixArgs: string[]
  /** Hint surfaced when the binary is missing. */
  installHint: string
  /** Hint surfaced when the repo has no config for this linter. */
  initHint: string
}

export const LINTER_SPECS: Record<LinterKey, LinterSpec> = {
  eslint: {
    key: 'eslint',
    displayName: 'eslint',
    command: 'eslint',
    lintArgs: ['--no-warn-ignored', '-f', 'json'],
    fixArgs: ['--no-warn-ignored', '--fix'],
    installHint: 'npm i -D eslint',
    initHint: 'npx eslint --init',
  },
  biome: {
    key: 'biome',
    displayName: 'biome',
    command: 'biome',
    lintArgs: ['check', '--reporter=json'],
    fixArgs: ['check', '--write'],
    installHint: 'npm i -D @biomejs/biome',
    initHint: 'biome init',
  },
  ruff: {
    key: 'ruff',
    displayName: 'ruff',
    command: 'ruff',
    lintArgs: ['check', '--output-format=json'],
    fixArgs: ['check', '--fix'],
    installHint: 'pip install ruff',
    initHint: 'ruff check --help',
  },
}

/** File extensions the plugin routes to a JS-family linter (eslint / biome). */
export const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const
/** File extensions routed to ruff. */
export const PY_EXTENSIONS = ['.py', '.pyi'] as const
/** Every extension the plugin understands, for friendly error messages. */
export const SUPPORTED_EXTENSIONS = [...JS_EXTENSIONS, ...PY_EXTENSIONS] as const

/**
 * Extension → the linter family that owns it, or null when the file type is
 * not supported. The exact linter WITHIN the family is resolved per repo by
 * `chooseLinter` (config detection), not here.
 */
export function linterFamilyForExt(ext: string): 'js' | 'py' | null {
  const normalized = ext.toLowerCase()
  if ((JS_EXTENSIONS as readonly string[]).includes(normalized)) return 'js'
  if ((PY_EXTENSIONS as readonly string[]).includes(normalized)) return 'py'
  return null
}

/**
 * Effective spawn command/args after applying a `linterPath` override. An
 * override ending in .js/.mjs/.cjs runs under the current Node binary — that
 * is how tests (and exotic setups) inject a substitute linter.
 */
export function resolveCommand(
  spec: LinterSpec,
  override: string | undefined,
  args: string[],
): { command: string; args: string[] } {
  if (!override) return { command: spec.command, args }
  if (/\.[mc]?js$/i.test(override)) {
    return { command: process.execPath, args: [override, ...args] }
  }
  return { command: override, args }
}

/** Absolute path → extension (lowercased). */
export function extOf(absPath: string): string {
  return path.extname(absPath).toLowerCase()
}
