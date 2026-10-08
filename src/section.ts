/**
 * Auto-injected system-prompt section: a compact lint DELTA after the last
 * edit — only NEW/CHANGED findings for the files just written, never the
 * whole workspace (the model is token-cost-sensitive).
 *
 * Wired to the harness `fs/observed` event: the listener contract there is
 * synchronous and side-effect-only, so handleObserved merely queues the file
 * and schedules a debounced refresh — the async lint runs happen outside the
 * event and through the same serial pool the tools use.
 */

import path from 'node:path'
import { classifyFindings, ensureBaseline, hasBaseline, hasAuthoritativeBaseline, type BaselineOwner } from './baseline.js'
import { getConfig } from './config.js'
import { capFindings, matchFindings, sortFindings, type Finding } from './findings.js'
import { linterFamilyForExt, extOf } from './linters.js'
import { managerForRoot } from './manager.js'
import { findRepoRoot, resolveFileInRoot } from './workspace.js'

const TOP_N = 5

const GUIDANCE =
  'lint: after editing a file, call lint_diagnostics { file } to check it '
    + '(lint_workspace_errors for the whole workspace; lint_fix auto-repairs what it can).'

export interface LintSection {
  name: string
  order: number
  text: () => string
  /** Queue a file (from an fs/observed event). Synchronous, never throws. */
  handleObserved: (displayPath: string | undefined, owner?: BaselineOwner) => void
  dispose: () => void
}

export function createLintSection(): LintSection {
  let cached: { at: number; text: string } = { at: 0, text: '' }
  let pending: Array<{ displayPath: string; owner?: BaselineOwner }> = []
  let lastCurrent: Array<{ abs: string; owner?: BaselineOwner; findings: Finding[] }> = []
  let timer: NodeJS.Timeout | null = null
  let inFlight = false
  let disposed = false

  function schedule(): void {
    if (timer || disposed) return
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, getConfig().settleMs)
    timer.unref?.()
  }

  async function refresh(): Promise<void> {
    if (inFlight || disposed) return
    inFlight = true
    const files = [...pending]
    pending = []
    try {
      // Resolve each edited file to its workspace + absolute path, per root.
      const byRoot = new Map<string, string[]>()
      for (const { displayPath } of files) {
        // The edit event is the ground truth — derive the workspace from the
        // file itself, so multi-workspace sessions each hit their own manager.
        const root = await findRepoRoot(path.dirname(displayPath))
        if (!root) continue
        const abs = resolveFileInRoot(root, displayPath)
        if (!abs || !linterFamilyForExt(extOf(abs))) continue
        const list = byRoot.get(root) ?? []
        list.push(abs)
        byRoot.set(root, list)
      }

      const fresh: Finding[] = []
      for (const [root, absPaths] of byRoot) {
        const manager = managerForRoot(root)
        for (const { displayPath, owner } of files) {
          const abs = resolveFileInRootSync(root, displayPath)
          if (abs && !hasBaseline(owner, abs)) ensureBaseline(owner, abs, manager.findingsFor(abs))
        }
        const results = await manager.lintMany(absPaths)
        for (const { displayPath, owner } of files) {
          const abs = resolveFileInRootSync(root, displayPath)
          if (!abs) continue
          const findings = results.get(abs) ?? manager.findingsFor(abs)
          const delta = classifyFindings(owner, abs, findings)
          const candidates = owner !== undefined && !hasAuthoritativeBaseline(owner, abs) ? [] : [...delta.introduced, ...delta.changed]
          const previousCurrent = lastCurrent.find((entry) => entry.abs === abs && entry.owner === owner)?.findings ?? []
          const repeated = new Set(matchFindings(previousCurrent, candidates).matches.map((match) => match.current))
          for (const [index, finding] of candidates.entries()) {
            if (repeated.has(index)) continue
            if (finding.severity !== getConfig().sectionSeverity) continue
            fresh.push(finding)
          }
          lastCurrent = [
            ...lastCurrent.filter((entry) => !(entry.abs === abs && entry.owner === owner)),
            { abs, owner, findings: [...findings] },
          ]
        }
      }
      if (disposed) return
      // Empty delta (clean edit, or a read-only observation) clears the
      // section — stale news about older edits must not linger.
      cached = { at: Date.now(), text: renderDelta(fresh) }
    } catch {
      // Never let a refresh failure reach the event emitter or the prompt.
    } finally {
      inFlight = false
      if (!disposed && pending.length > 0) schedule()
    }
  }

  function renderDelta(fresh: Finding[]): string {
    if (fresh.length === 0) return ''
    const severity = getConfig().sectionSeverity
    const sorted = sortFindings(fresh)
    const capped = capFindings(sorted, TOP_N)
    const body = capped.result
      .map((f) => `${f.file}:${f.line} ${f.severity} ${f.rule} ${f.message}${f.fixable ? ' [fixable]' : ''}`)
      .join('\n')
    const overflow = capped.dropped > 0 ? ` (top ${TOP_N} of ${sorted.length})` : ''
    const changed = sorted.some((finding) => (finding as Finding & { scope?: string }).scope === 'changed')
    const label = changed ? 'introduced or changed' : 'introduced'
    return (
      `lint: ${sorted.length} ${severity}${sorted.length === 1 ? '' : 's'} ${label} by your last edit${overflow}:\n`
        + `${body}\n`
        + `(full list: lint_diagnostics { file } — auto-repair what you can: lint_fix { file }; `
        + `other severities stay out of the prompt via sectionSeverity)`
    )
  }

  return {
    name: 'lint:findings',
    order: 75, // after lsp:diagnostics (70), before tool guidance (100–199)
    text: () => {
      if (cached.text && Date.now() - cached.at < getConfig().sectionTtlMs) return cached.text
      return GUIDANCE
    },
    handleObserved: (displayPath, owner) => {
      try {
        if (!displayPath || disposed) return
        if (!pending.some((entry) => entry.displayPath === displayPath && entry.owner === owner)) {
          pending.push({ displayPath, owner })
        }
        schedule()
      } catch {
        // fs/observed listeners must be infallible — a throw here would fail the tool call.
      }
    },
    dispose: () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pending = []
      lastCurrent = []
    },
  }
}

/** `refresh` already resolved the root asynchronously; this is the matching path-only conversion. */
function resolveFileInRootSync(root: string, displayPath: string): string | null {
  const abs = path.isAbsolute(displayPath) ? path.resolve(displayPath) : path.resolve(root, displayPath)
  const rel = path.relative(root, abs)
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? null : abs
}
