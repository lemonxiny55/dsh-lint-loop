/** Internal finding model: filtering, capping, rendering. */

import type { LinterKey } from './linters.js'

export type Severity = 'error' | 'warning' | 'info'

/** Regression classification for a finding relative to the active edit baseline. */
export type FindingScope = 'preexisting' | 'introduced' | 'resolved' | 'changed'

export interface Finding {
  /** Linter rule id (e.g. no-unused-vars, lint/suspicious/noDebugger, F401). */
  rule: string
  /** Repo-relative path (forward slashes). */
  file: string
  /** 1-based positions (linter-native for eslint/ruff; converted for biome spans). */
  line: number
  col: number
  endLine: number
  endCol: number
  severity: Severity
  message: string
  /** The linter can auto-repair this finding (eslint --fix / biome check --write / ruff check --fix). */
  fixable: boolean
  /** Which linter produced this finding. */
  linter: LinterKey
  /** Normalized source context captured by the manager for baseline matching. */
  context?: string
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
const SEVERITY_LABEL: Record<Severity, string> = { error: 'error', warning: 'warn', info: 'info' }

/** Stable identity for delta computations (same finding before/after an edit). */
export function findingKey(f: Finding): string {
  return [f.file, f.severity, f.rule, f.line, f.col, f.message].join('|')
}

/**
 * Position-independent identity used by the regression matcher. The legacy
 * `findingKey` above remains position-sensitive for public compatibility; the
 * baseline matcher deliberately does not use it.
 */
export function findingFingerprint(f: Finding): string {
  return [f.file, f.linter, f.severity, f.rule, normalizeMessage(f.message)].join('|')
}

/** Collapse formatting noise that otherwise makes equivalent linter messages differ. */
export function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ').toLowerCase()
}

interface Match {
  current: number
  previous: number
  exact: boolean
  score: number
}

/**
 * Match current findings to a previous snapshot without making line/column
 * part of the primary identity. Source context wins; approximate location is
 * only a bounded fallback for linters that do not give us stable source text.
 * Duplicate rule/message occurrences are paired one-to-one by the lowest
 * score, so one duplicate does not make every duplicate pre-existing.
 */
export function matchFindings(
  previous: readonly Finding[],
  current: readonly Finding[],
): { matches: Match[]; unmatchedPrevious: number[]; unmatchedCurrent: number[] } {
  const usedPrevious = new Set<number>()
  const matches: Match[] = []

  const exactGroups = new Map<string, number[]>()
  previous.forEach((finding, index) => {
    const list = exactGroups.get(findingFingerprint(finding)) ?? []
    list.push(index)
    exactGroups.set(findingFingerprint(finding), list)
  })

  const currentOrder = current
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => a.finding.line - b.finding.line || a.finding.col - b.finding.col)

  for (const { finding, index } of currentOrder) {
    const candidates = exactGroups.get(findingFingerprint(finding)) ?? []
    let best: { index: number; score: number } | undefined
    for (const previousIndex of candidates) {
      if (usedPrevious.has(previousIndex)) continue
      const prior = previous[previousIndex]
      const sameContext = Boolean(finding.context && prior.context && finding.context === prior.context)
      const distance = Math.abs(finding.line - prior.line) + Math.abs(finding.col - prior.col) / 100
      const score = (sameContext ? 0 : 100) + distance
      if (!best || score < best.score) best = { index: previousIndex, score }
    }
    const prior = best ? previous[best.index] : undefined
    const hasSourceOnBothSides = Boolean(finding.context && prior?.context)
    const lineDistance = prior ? Math.abs(finding.line - prior.line) : Number.POSITIVE_INFINITY
    if (best && prior && (
      best.score < 100
        // A fixer can change the source text on the same line while leaving
        // the rule/message untouched (for example, removing a semicolon).
        // Permit that narrow drift even when both source contexts differ;
        // larger moves still require a stable source context.
        || (!hasSourceOnBothSides && lineDistance <= 20)
        || (hasSourceOnBothSides && lineDistance <= 3)
    )) {
      usedPrevious.add(best.index)
      matches.push({ current: index, previous: best.index, exact: true, score: best.score })
    }
  }

  // A rule/message change at the same source location is a changed finding,
  // not a resolved finding plus an unrelated introduction.
  const remainingCurrent = current
    .map((finding, index) => ({ finding, index }))
    .filter(({ index }) => !matches.some((match) => match.current === index))
  const remainingPrevious = previous
    .map((finding, index) => ({ finding, index }))
    .filter(({ index }) => !usedPrevious.has(index))

  for (const { finding, index } of remainingCurrent) {
    let best: { index: number; score: number } | undefined
    for (const candidate of remainingPrevious) {
      if (usedPrevious.has(candidate.index)) continue
      const prior = candidate.finding
      if (prior.file !== finding.file || prior.linter !== finding.linter) continue
      const sameContext = Boolean(finding.context && prior.context && finding.context === prior.context)
      if (finding.context && prior.context && !sameContext) continue
      const distance = Math.abs(finding.line - prior.line) + Math.abs(finding.col - prior.col) / 100
      const sameRule = prior.rule === finding.rule
      const score = (sameContext ? 0 : sameRule ? 10 : 40) + distance
      if (!sameContext && !sameRule && distance > 20) continue
      if (!best || score < best.score) best = { index: candidate.index, score }
    }
    if (best) {
      usedPrevious.add(best.index)
      matches.push({ current: index, previous: best.index, exact: false, score: best.score })
    }
  }

  const matchedCurrent = new Set(matches.map((match) => match.current))
  return {
    matches,
    unmatchedPrevious: previous.map((_, index) => index).filter((index) => !usedPrevious.has(index)),
    unmatchedCurrent: current.map((_, index) => index).filter((index) => !matchedCurrent.has(index)),
  }
}

export function filterFindings(findings: readonly Finding[], severity?: Severity): Finding[] {
  return severity ? findings.filter((f) => f.severity === severity) : [...findings]
}

/** Errors first, then warnings, then info; within a severity by file/line/col. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.col - b.col,
  )
}

/** Cap a list; returns the kept slice and how many were dropped. */
export function capFindings(findings: readonly Finding[], max: number): { result: Finding[]; dropped: number } {
  if (findings.length <= max) return { result: [...findings], dropped: 0 }
  return { result: [...findings.slice(0, max)], dropped: findings.length - max }
}

/**
 * Compact model-facing render:
 *
 * ```
 * # lint findings (2 errors, 1 warning)
 * src/a.ts:3:10    error  no-unused-vars  'x' is defined but never used  [fixable]
 * src/b.ts:12:1    warn   explicit-any    unexpected any
 * ```
 */
export function renderFindings(
  findings: readonly Finding[],
  dropped = 0,
  frameFor?: (finding: Finding) => string | undefined,
): string {
  if (findings.length === 0 && dropped === 0) return '# lint findings (none)'
  const errors = findings.filter((f) => f.severity === 'error').length
  const warnings = findings.filter((f) => f.severity === 'warning').length
  const infos = findings.length - errors - warnings
  const counts = [
    errors ? `${errors} error${errors === 1 ? '' : 's'}` : '',
    warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '',
    infos ? `${infos} info` : '',
  ]
    .filter(Boolean)
    .join(', ')

  const rows = findings.map((f) => ({
    loc: `${f.file}:${f.line}:${f.col}`,
    sev: SEVERITY_LABEL[f.severity],
    rule: f.rule,
    message: f.message,
    fixable: f.fixable,
  }))
  const locWidth = Math.max(0, ...rows.map((r) => r.loc.length))
  const sevWidth = Math.max(0, ...rows.map((r) => r.sev.length))
  const ruleWidth = Math.max(0, ...rows.map((r) => r.rule.length))

  const lines = [`# lint findings (${counts})`]
  findings.forEach((finding, index) => {
    const row = rows[index]
    const line = [row.loc.padEnd(locWidth), row.sev.padEnd(sevWidth), row.rule.padEnd(ruleWidth), row.message]
      .join('  ')
      .trimEnd()
    lines.push(row.fixable ? `${line}  [fixable]` : line)
    const frame = frameFor?.(finding)
    if (frame) lines.push(frame)
  })
  if (dropped > 0) {
    lines.push(`(+${dropped} more suppressed — raise the max parameter or maxFindings config)`)
  }
  return lines.join('\n')
}
