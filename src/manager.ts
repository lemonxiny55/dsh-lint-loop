/**
 * Per-workspace lint manager: routes files to their linter, runs lint/fix
 * through the serial runner pool, and owns the findings store (absPath →
 * findings for the file's LAST lint).
 */

import { access, constants, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getConfig } from './config.js'
import { chooseLinter, probeLinters } from './detect.js'
import { LinterTimeoutError, MissingLinterError, NoConfigError, UnsupportedFileError } from './errors.js'
import type { Finding } from './findings.js'
import { recordFileLines } from './frames.js'
import { linterFamilyForExt, extOf, LINTER_KEYS, LINTER_SPECS, resolveCommand, type LinterKey } from './linters.js'
import { parseFindingsFor } from './parse.js'
import { isMissingBinary, runProcess, schedule, type RunOutcome } from './runner.js'
import { normalizeDrive, toRelative } from './workspace.js'

/** Soft cap on tracked files per manager (memory guard). */
const MAX_TRACKED_FILES = 512

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
    const findings = await this.runLint(linter, absPath)
    const key = this.key(absPath)
    if (!this.store.has(key) && this.store.size >= MAX_TRACKED_FILES) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, findings)
    await this.recordLines(absPath)
    return findings
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
    const before = await readFile(absPath, 'utf8').catch(() => null)

    const outcome = await this.runWithFlagFallback(linter, spec.fixArgs, absPath)
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

  private async runLint(linter: LinterKey, absPath: string): Promise<Finding[]> {
    const spec = LINTER_SPECS[linter]
    const outcome = await this.runWithFlagFallback(linter, spec.lintArgs, absPath)
    this.assertRunnable(linter, outcome)
    return parseFindingsFor(linter, outcome.stdout, this.root)
  }

  /**
   * One linter run, with the eslint `--no-warn-ignored` version fallback:
   * eslint < 8.22 rejects the flag — detect once per root, remember, retry
   * without it.
   */
  private async runWithFlagFallback(linter: LinterKey, baseArgs: string[], absPath: string): Promise<RunOutcome> {
    const flagUsable = linter === 'eslint' ? eslintFlagUsable(this.root) : true
    const args = flagUsable ? baseArgs : baseArgs.filter((arg) => arg !== '--no-warn-ignored')
    let outcome = await this.run(linter, [...args, absPath])
    if (linter === 'eslint' && flagUsable && isUnknownOptionFailure(outcome)) {
      noteEslintFlagUnsupported(this.root)
      const retryArgs = [...args.filter((arg) => arg !== '--no-warn-ignored'), absPath]
      outcome = await this.run(linter, retryArgs)
    }
    return outcome
  }

  private async run(linter: LinterKey, args: string[]): Promise<RunOutcome> {
    const spec = LINTER_SPECS[linter]
    const override = getConfig().linterPath[linter]
    const { command, args: finalArgs } = override
      ? resolveCommand(spec, override, args)
      : { command: await resolveRepoLocalBinary(this.root, spec.command), args }
    return schedule(`${this.root}::${linter}`, () =>
      runProcess(command, finalArgs, { cwd: this.root, timeoutMs: getConfig().timeoutMs }),
    )
  }

  /** Map a run outcome onto friendly errors; exit 0/1 means parseable output. */
  private assertRunnable(linter: LinterKey, outcome: RunOutcome): void {
    if (outcome.timedOut) throw new LinterTimeoutError(linter, getConfig().timeoutMs)
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
    outcome.exitCode > 1 &&
    /unknown option/i.test(outcome.stderr + outcome.stdout)
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
