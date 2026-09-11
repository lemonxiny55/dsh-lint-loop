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
import { getConfig } from './config.js'
import { capFindings, findingKey, sortFindings, type Finding } from './findings.js'
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
  handleObserved: (displayPath: string | undefined) => void
  dispose: () => void
}

export function createLintSection(): LintSection {
  let cached: { at: number; text: string } = { at: 0, text: '' }
  let pending = new Set<string>()
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
    pending = new Set()
    try {
      const fresh: Finding[] = []
      for (const displayPath of files) {
        // The edit event is the ground truth — derive the workspace from the
        // file itself, so multi-workspace sessions each hit their own manager.
        const root = await findRepoRoot(path.dirname(displayPath))
        if (!root) continue
        const abs = resolveFileInRoot(root, displayPath)
        if (!abs || !linterFamilyForExt(extOf(abs))) continue

        const manager = managerForRoot(root)
        const previous = new Set(manager.findingsFor(abs).map(findingKey))
        const findings = await manager.lintFile(abs)
        for (const finding of findings) {
          if (finding.severity !== getConfig().sectionSeverity) continue
          if (!previous.has(findingKey(finding))) fresh.push(finding)
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
      if (!disposed && pending.size > 0) schedule()
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
    return (
      `lint: ${sorted.length} ${severity}${sorted.length === 1 ? '' : 's'} introduced by your last edit${overflow}:\n`
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
    handleObserved: (displayPath) => {
      try {
        if (!displayPath || disposed) return
        pending.add(displayPath)
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
      pending.clear()
    },
  }
}
