/** Per-linter spawn configuration and file-extension routing. */

import path from 'node:path'

export const LINTER_KEYS = ['eslint', 'biome', 'ruff', 'golangci', 'clippy'] as const

export type LinterKey = (typeof LINTER_KEYS)[number]

/**
 * How a linter is scoped to its input:
 * - `file` — the linter takes one file path (eslint, biome, ruff),
 * - `dir`  — the linter takes a package directory and reports across it (golangci-lint),
 * - `cwd`  — the linter analyzes the project at its working directory and takes no path (cargo clippy).
 */
export type LinterScope = 'file' | 'dir' | 'cwd'

export interface LinterSpec {
  key: LinterKey
  /** Binary we expect on PATH — used in error messages. */
  displayName: string
  command: string
  /** Args prepended before the target for a plain lint run. */
  lintArgs: string[]
  /** Args prepended before the target for an auto-fix run. */
  fixArgs: string[]
  /** How the target is passed (see LinterScope). */
  scope: LinterScope
  /**
   * Lower bound for this linter's run timeout. Package-scoped linters compile
   * (cargo clippy especially) and can be far slower than per-file linters, so a
   * floor keeps the default 10s timeout from killing a legitimate cold run.
   */
  minTimeoutMs?: number
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
    scope: 'file',
    installHint: 'npm i -D eslint',
    initHint: 'npx eslint --init',
  },
  biome: {
    key: 'biome',
    displayName: 'biome',
    command: 'biome',
    lintArgs: ['check', '--reporter=json'],
    fixArgs: ['check', '--write'],
    scope: 'file',
    installHint: 'npm i -D @biomejs/biome',
    initHint: 'biome init',
  },
  ruff: {
    key: 'ruff',
    displayName: 'ruff',
    command: 'ruff',
    lintArgs: ['check', '--output-format=json'],
    fixArgs: ['check', '--fix'],
    scope: 'file',
    installHint: 'pip install ruff',
    initHint: 'ruff check --help',
  },
  golangci: {
    key: 'golangci',
    displayName: 'golangci-lint',
    command: 'golangci-lint',
    // golangci-lint v2 writes the JSON report via --output.json.path; v1 used
    // --out-format (the manager retries with the v1 flag when v2 rejects it).
    lintArgs: ['run', '--output.json.path=stdout'],
    fixArgs: ['run', '--fix'],
    scope: 'dir',
    minTimeoutMs: 60_000,
    installHint: 'go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest',
    initHint: 'create a .golangci.yml at the repo root (golangci-lint has no init command)',
  },
  clippy: {
    key: 'clippy',
    displayName: 'cargo clippy',
    command: 'cargo',
    lintArgs: ['clippy', '--message-format=json', '--quiet'],
    fixArgs: ['clippy', '--fix', '--allow-dirty', '--allow-staged', '--quiet'],
    scope: 'cwd',
    minTimeoutMs: 120_000,
    installHint: 'rustup component add clippy',
    initHint: 'cargo clippy --help',
  },
}

/** File extensions the plugin routes to a JS-family linter (eslint / biome). */
export const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const
/** File extensions routed to ruff. */
export const PY_EXTENSIONS = ['.py', '.pyi'] as const
/** File extensions routed to golangci-lint. */
export const GO_EXTENSIONS = ['.go'] as const
/** File extensions routed to cargo clippy. */
export const RUST_EXTENSIONS = ['.rs'] as const
/** Every extension the plugin understands, for friendly error messages. */
export const SUPPORTED_EXTENSIONS = [
  ...JS_EXTENSIONS,
  ...PY_EXTENSIONS,
  ...GO_EXTENSIONS,
  ...RUST_EXTENSIONS,
] as const

/**
 * Extension → the linter family that owns it, or null when the file type is
 * not supported. The exact linter WITHIN the family is resolved per repo by
 * `chooseLinter` (config detection), not here.
 */
export function linterFamilyForExt(ext: string): 'js' | 'py' | 'go' | 'rust' | null {
  const normalized = ext.toLowerCase()
  if ((JS_EXTENSIONS as readonly string[]).includes(normalized)) return 'js'
  if ((PY_EXTENSIONS as readonly string[]).includes(normalized)) return 'py'
  if ((GO_EXTENSIONS as readonly string[]).includes(normalized)) return 'go'
  if ((RUST_EXTENSIONS as readonly string[]).includes(normalized)) return 'rust'
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
