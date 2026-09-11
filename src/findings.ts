/** Internal finding model: filtering, capping, rendering. */

import type { LinterKey } from './linters.js'

export type Severity = 'error' | 'warning' | 'info'

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
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
const SEVERITY_LABEL: Record<Severity, string> = { error: 'error', warning: 'warn', info: 'info' }

/** Stable identity for delta computations (same finding before/after an edit). */
export function findingKey(f: Finding): string {
  return [f.file, f.severity, f.rule, f.line, f.col, f.message].join('|')
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
