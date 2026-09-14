/**
 * Per-workspace lint manager: routes files to their linter, runs lint/fix
 * through the serial runner pool, and owns the findings store (absPath →
 * findings for the file's LAST lint).
 *
 * Linters come in three scopes (`LinterSpec.scope`):
 * - `file`  — eslint / biome / ruff: one file path in, findings for that file,
 * - `dir`   — golangci-lint: a package directory in, findings across the package,
 * - `cwd`   — cargo clippy: the project at the working directory, no path arg.
 * Package-scoped results are DISTRIBUTED into the store by each finding's own
 * file, so `lint_diagnostics { file }` still answers for exactly that file and
 * `lint_workspace_errors` sees the rest of the package too.
 */

import { access, constants, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getConfig } from './config.js'
import { chooseLinter, probeLinters } from './detect.js'
import { LinterTimeoutError, MissingLinterError, NoConfigError, UnsupportedFileError } from './errors.js'
import type { Finding } from './findings.js'
import { recordFileLines } from './frames.js'
import {
  linterFamilyForExt,
  extOf,
  LINTER_KEYS,
  LINTER_SPECS,
  resolveCommand,
  type LinterKey,
  type LinterSpec,
} from './linters.js'
import { parseFindingsFor } from './parse.js'
import { isMissingBinary, runProcess, schedule, type RunOutcome } from './runner.js'
import { normalizeDrive, toRelative } from './workspace.js'

/** Soft cap on tracked files per manager (memory guard). */
const MAX_TRACKED_FILES = 512

/** golangci-lint's JSON-report flag moved in v2 (v1 used `--out-format`). */
const GOLANGCI_V2_JSON_FLAG = '--output.json.path=stdout'
const GOLANGCI_V1_JSON_FLAG = '--out-format=json'

/** Resolved execution plan for one (linter, file) pair. */
interface RunTarget {
  /** Argument appended after the linter args, or null for cwd-scoped linters. */
  arg: string | null
  /** Process working directory. */
  cwd: string
  /** Directory that relative linter-reported paths resolve against. */
  baseDir: string
  /** Directory whose files this run owns (used to evict stale findings). */
  scopeDir: string
  /** Stable identity for grouping identical runs. */
  key: string
}

export interface FixResult {
  /** Repo-relative path. */
  file: string
  linter: LinterKey
  /** The auto-fix run actually rewrote the file. */
  fixed: boolean
  addedLines: number
  removedLines: number
  /** Fresh findings after the fix (the manager's new store entry). */
  remaining: Finding[]
  /** Findings hidden by the tool-level cap (set by the tool, not the manager). */
  dropped: number
}

export class LintManager {
  /** storeKey → findings from the file's last lint. */
  private readonly store = new Map<string, Finding[]>()

  constructor(readonly root: string) {}

  get seenFileCount(): number {
    return this.store.size
  }

  findingsFor(absPath: string): Finding[] {
    return this.store.get(this.key(absPath)) ?? []
  }

  allFindings(): Finding[] {
    return [...this.store.values()].flat()
  }

  /** Canonical store key — tool paths and linter-reported paths must agree. */
  private key(absPath: string): string {
    return normalizeDrive(path.resolve(absPath))
  }

  /** Clear the findings store (plugin unload). */
  dispose(): void {
    this.store.clear()
  }

  private async requireLinter(absPath: string): Promise<LinterKey> {
    const ext = extOf(absPath)
    if (!linterFamilyForExt(ext)) throw new UnsupportedFileError(ext)
    const linter = await chooseLinter(this.root, absPath)
    if (!linter) {
      const detected = await probeLinters(this.root)
      const names = LINTER_KEYS.filter((key) => detected[key])
      throw new NoConfigError(this.root, names)
    }
    return linter
  }

  /**
   * Lint one file (serially queued per root+linter), store, and return the
   * fresh findings.
   */
  async lintFile(absPath: string): Promise<Finding[]> {
    const linter = await this.requireLinter(absPath)
    const spec = LINTER_SPECS[linter]
    const target = await resolveRunTarget(spec, absPath, this.root)
    const findings = await this.runLint(linter, target)
    this.replaceScope(linter, spec, target, [absPath], findings)
    await this.recordLines(absPath)
    return this.findingsFor(absPath)
  }

  /**
   * Lint several files, running each (linter, target) exactly once — a
   * package-scoped linter is invoked once per package, not once per edited
   * file. Files whose linter cannot be resolved are skipped (callers — the
   * gate and the injected section — treat a missing linter as "nothing to
   * report" rather than an error).
   */
  async lintMany(absPaths: readonly string[]): Promise<Map<string, Finding[]>> {
    const groups = new Map<string, { linter: LinterKey; target: RunTarget; members: string[] }>()
    for (const absPath of absPaths) {
      let linter: LinterKey
      try {
        linter = await this.requireLinter(absPath)
      } catch {
        continue
      }
      const spec = LINTER_SPECS[linter]
      const target = await resolveRunTarget(spec, absPath, this.root)
      const groupKey = `${linter}::${target.key}`
      const group = groups.get(groupKey) ?? { linter, target, members: [] }
      group.members.push(absPath)
      groups.set(groupKey, group)
    }

    const out = new Map<string, Finding[]>()
    for (const group of groups.values()) {
      const spec = LINTER_SPECS[group.linter]
      let findings: Finding[] | null = null
      try {
        findings = await this.runLint(group.linter, group.target)
      } catch {
        // A failed run keeps the scope's previous findings rather than wiping them.
      }
      if (findings) this.replaceScope(group.linter, spec, group.target, group.members, findings)
      for (const abs of group.members) {
        out.set(abs, this.findingsFor(abs))
        await this.recordLines(abs)
      }
    }
    return out
  }

  /** Cache the file's current lines so rendered findings can carry a code frame. */
  private async recordLines(absPath: string): Promise<void> {
    try {
      const text = await readFile(absPath, 'utf8')
      recordFileLines(toRelative(this.key(absPath), this.key(this.root)), text)
    } catch {
      // Unreadable file (deleted mid-run) → no frame; never fails the lint.
    }
  }

  /** Auto-fix one file, then re-lint. Throws the same friendly errors as lintFile. */
  async fixFile(absPath: string): Promise<FixResult> {
    const linter = await this.requireLinter(absPath)
    const spec = LINTER_SPECS[linter]
    const target = await resolveRunTarget(spec, absPath, this.root)
    const before = await readFile(absPath, 'utf8').catch(() => null)

    const outcome = await this.runWithFlagFallback(linter, spec.fixArgs, target)
    this.assertRunnable(linter, outcome)

    const after = await readFile(absPath, 'utf8').catch(() => null)
    const fixed = before !== null && after !== null && before !== after
    const diff = summarizeLineChanges(before ?? '', after ?? '')
    const remaining = await this.lintFile(absPath)
    return {
      file: toRelative(this.key(absPath), this.key(this.root)),
      linter,
      fixed,
      addedLines: diff.added,
      removedLines: diff.removed,
      remaining,
      dropped: 0,
    }
  }

  private async runLint(linter: LinterKey, target: RunTarget): Promise<Finding[]> {
    const spec = LINTER_SPECS[linter]
    const outcome = await this.runWithFlagFallback(linter, spec.lintArgs, target)
    this.assertRunnable(linter, outcome)
    return parseFindingsFor(linter, outcome.stdout, this.root, target.baseDir)
  }

  /**
   * Replace the store entries a run owns. File-scoped linters own exactly their
   * target file; package-scoped runs own every tracked file under their scope
   * directory (stale findings there are dropped, fresh ones distributed by the
   * file each finding reports).
   */
  private replaceScope(
    linter: LinterKey,
    spec: LinterSpec,
    target: RunTarget,
    members: readonly string[],
    findings: readonly Finding[],
  ): void {
    if (spec.scope === 'file') {
      this.store.set(this.key(members[0]), [...findings])
      this.enforceCap()
      return
    }
    for (const storeKey of [...this.store.keys()]) {
      if (!isUnder(storeKey, target.scopeDir)) continue
      const kept = (this.store.get(storeKey) ?? []).filter((finding) => finding.linter !== linter)
      if (kept.length > 0) this.store.set(storeKey, kept)
      else this.store.delete(storeKey)
    }
    for (const finding of findings) {
      const storeKey = this.key(path.resolve(this.root, finding.file))
      const list = this.store.get(storeKey)
      if (list) list.push(finding)
      else this.store.set(storeKey, [finding])
    }
    for (const abs of members) {
      const storeKey = this.key(abs)
      if (!this.store.has(storeKey)) this.store.set(storeKey, [])
    }
    this.enforceCap()
  }

  private enforceCap(): void {
    while (this.store.size > MAX_TRACKED_FILES) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.store.delete(oldest)
    }
  }

  /**
   * One linter run, with per-linter version fallbacks:
   * eslint < 8.22 rejects `--no-warn-ignored`; golangci-lint v1 rejects the v2
   * `--output.json.path` flag. Both are detected once and retried without.
   */
  private async runWithFlagFallback(
    linter: LinterKey,
    baseArgs: string[],
    target: RunTarget,
  ): Promise<RunOutcome> {
    let args = target.arg === null ? [...baseArgs] : [...baseArgs, target.arg]
    if (linter === 'eslint' && !eslintFlagUsable(this.root)) {
      args = args.filter((arg) => arg !== '--no-warn-ignored')
    }
    let outcome = await this.run(linter, args, target.cwd)
    if (linter === 'eslint' && eslintFlagUsable(this.root) && isUnknownOptionFailure(outcome)) {
      noteEslintFlagUnsupported(this.root)
      outcome = await this.run(linter, args.filter((arg) => arg !== '--no-warn-ignored'), target.cwd)
    }
    if (linter === 'golangci' && args.includes(GOLANGCI_V2_JSON_FLAG) && isUnknownOptionFailure(outcome)) {
      outcome = await this.run(
        linter,
        args.map((arg) => (arg === GOLANGCI_V2_JSON_FLAG ? GOLANGCI_V1_JSON_FLAG : arg)),
        target.cwd,
      )
    }
    return outcome
  }

  private async run(linter: LinterKey, args: string[], cwd: string): Promise<RunOutcome> {
    const spec = LINTER_SPECS[linter]
    const override = getConfig().linterPath[linter]
    const { command, args: finalArgs } = override
      ? resolveCommand(spec, override, args)
      : { command: await resolveRepoLocalBinary(this.root, spec.command), args }
    return schedule(`${this.root}::${linter}`, () =>
      runProcess(command, finalArgs, { cwd, timeoutMs: this.effectiveTimeout(linter) }),
    )
  }

  /** The run timeout actually applied: the config value, floored by the linter's minimum. */
  private effectiveTimeout(linter: LinterKey): number {
    return Math.max(getConfig().timeoutMs, LINTER_SPECS[linter].minTimeoutMs ?? 0)
  }

  /** Map a run outcome onto friendly errors; exit 0/1 means parseable output. */
  private assertRunnable(linter: LinterKey, outcome: RunOutcome): void {
    if (outcome.timedOut) throw new LinterTimeoutError(linter, this.effectiveTimeout(linter))
    if (isMissingBinary(outcome)) throw new MissingLinterError(linter, outcome.stderr)
    if (outcome.spawnError) throw new MissingLinterError(linter, outcome.spawnError.message)
    if (outcome.exitCode !== null && outcome.exitCode > 1) {
      throw new Error(
        `linter "${linter}" failed to run (exit ${outcome.exitCode}).`
          + (outcome.stderr.trim() ? `\nlinter said: ${outcome.stderr.trim().split('\n').slice(-3).join('\n')}` : ''),
      )
    }
  }
}

// --- run target resolution --------------------------------------------------

async function resolveRunTarget(spec: LinterSpec, absPath: string, root: string): Promise<RunTarget> {
  if (spec.scope === 'file') {
    return { arg: absPath, cwd: root, baseDir: root, scopeDir: absPath, key: `file::${absPath}` }
  }
  if (spec.scope === 'dir') {
    const dir = path.dirname(absPath)
    return { arg: dir, cwd: root, baseDir: root, scopeDir: dir, key: `dir::${dir}` }
  }
  // cwd scope (cargo clippy): analyze the crate that owns the file.
  const manifestDir = (await nearestManifestDir(path.dirname(absPath), root, 'Cargo.toml')) ?? root
  return { arg: null, cwd: manifestDir, baseDir: manifestDir, scopeDir: manifestDir, key: `cwd::${manifestDir}` }
}

/** Walk from `startDir` up to (and including) `stopDir` for a manifest file. */
async function nearestManifestDir(startDir: string, stopDir: string, manifest: string): Promise<string | null> {
  const root = path.resolve(stopDir)
  let dir = path.resolve(startDir)
  for (let level = 0; level < 64; level++) {
    try {
      await access(path.join(dir, manifest))
      return dir
    } catch {
      // not here — keep walking toward the repo root
    }
    if (dir === root) return null
    const parent = path.dirname(dir)
    if (parent === dir || path.relative(root, parent).startsWith('..')) return null
    dir = parent
  }
  return null
}

/** True when `storeKey` is the directory itself or a descendant of it. */
function isUnder(storeKey: string, dir: string): boolean {
  const base = normalizeDrive(path.resolve(dir))
  return storeKey === base || storeKey.startsWith(base + path.sep)
}

// --- repo-local binary resolution -------------------------------------------

const repoBinCache = new Map<string, string>()

/**
 * `npm i -D eslint` installs the binary into the repo's node_modules/.bin,
 * which is NOT on PATH for a spawned process. Prefer the repo-local binary
 * (exact match, or .cmd on Windows), fall back to PATH.
 */
async function resolveRepoLocalBinary(root: string, command: string): Promise<string> {
  const cacheKey = `${path.resolve(root)}::${command}`
  const cached = repoBinCache.get(cacheKey)
  if (cached) return cached
  const binDir = path.join(root, 'node_modules', '.bin')
  const names = process.platform === 'win32' ? [`${command}.cmd`, command] : [command]
  for (const name of names) {
    const candidate = path.join(binDir, name)
    try {
      await access(candidate, constants.X_OK)
      repoBinCache.set(cacheKey, candidate)
      return candidate
    } catch {
      // not present — keep looking
    }
  }
  return command
}

// --- eslint --no-warn-ignored version fallback -----------------------------

const eslintFlagMemo = new Map<string, boolean>()

function eslintFlagUsable(root: string): boolean {
  return eslintFlagMemo.get(path.resolve(root)) ?? true
}

function noteEslintFlagUnsupported(root: string): void {
  eslintFlagMemo.set(path.resolve(root), false)
}

function isUnknownOptionFailure(outcome: RunOutcome): boolean {
  return (
    outcome.exitCode !== null &&
    outcome.exitCode !== 0 &&
    /unknown (?:option|flag)/i.test(outcome.stderr + outcome.stdout)
  )
}

// --- line-diff summary ------------------------------------------------------

/** Multiset line diff — cheap O(n) summary of what the fixer rewrote. */
export function summarizeLineChanges(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 }
  const counts = new Map<string, number>()
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  for (const line of after.split('\n')) counts.set(line, (counts.get(line) ?? 0) - 1)
  let added = 0
  let removed = 0
  for (const delta of counts.values()) {
    if (delta < 0) added += -delta
    else removed += delta
  }
  return { added, removed }
}

// --- one manager per workspace root -----------------------------------------

/** One manager per resolved workspace root, shared by all tools and the section. */
const managers = new Map<string, LintManager>()

export function managerForRoot(root: string): LintManager {
  const resolved = path.resolve(root)
  let manager = managers.get(resolved)
  if (!manager) {
    manager = new LintManager(resolved)
    managers.set(resolved, manager)
  }
  return manager
}

/** Drop every manager's store (plugin unload). Idempotent; awaited inflight runs are harmless. */
export async function disposeAllManagers(): Promise<void> {
  for (const manager of managers.values()) {
    manager.dispose()
  }
  managers.clear()
}
