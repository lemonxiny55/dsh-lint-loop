/**
 * Linter JSON output → internal Finding[]. One parser per linter; all output
 * is defensive (missing fields fall back, malformed input raises ParseError).
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ParseError } from './errors.js'
import type { Finding, Severity } from './findings.js'
import { normalizeDrive, toRelative } from './workspace.js'
import type { LinterKey } from './linters.js'

function storeKey(absPath: string): string {
  return normalizeDrive(path.resolve(absPath))
}

function relFile(absPath: string, root: string): string {
  return toRelative(storeKey(absPath), storeKey(root))
}

/** Binary-search newline positions → 1-based line/col for a byte offset. */
class LineIndex {
  private readonly newlines: number[] = []

  constructor(private readonly buf: Buffer) {
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) this.newlines.push(i)
    }
  }

  toLineCol(offset: number): { line: number; col: number } {
    const clamped = Math.min(Math.max(offset, 0), this.buf.length)
    // Find the last newline strictly before the offset.
    let lo = 0
    let hi = this.newlines.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.newlines[mid] < clamped) lo = mid + 1
      else hi = mid
    }
    const line = lo + 1
    const lineStart = lo === 0 ? -1 : this.newlines[lo - 1]
    return { line, col: clamped - lineStart }
  }
}

// ---------------------------------------------------------------------------
// eslint — `[ { filePath, messages: [ { ruleId, severity, line, column,
// endLine, endColumn, message, fatal, fix } ] } ]`
// ---------------------------------------------------------------------------

interface EslintMessage {
  ruleId?: string | null
  severity?: number
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  message?: string
  fatal?: boolean
  fix?: unknown
}

interface EslintResult {
  filePath?: string
  messages?: EslintMessage[]
}

export function parseEslintJson(stdout: string, root: string): Finding[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new ParseError('eslint', (error as Error).message)
  }
  if (!Array.isArray(parsed)) throw new ParseError('eslint', 'expected a top-level array')
  const findings: Finding[] = []
  for (const result of parsed as EslintResult[]) {
    if (!result || typeof result !== 'object' || !result.filePath) continue
    const file = relFile(result.filePath, root)
    for (const message of result.messages ?? []) {
      const severity: Severity = message.severity === 2 ? 'error' : message.severity === 1 ? 'warning' : 'info'
      if (message.severity === 0) continue // rule off — never happens in practice, skip defensively
      findings.push({
        rule: message.ruleId ?? (message.fatal ? 'eslint/parse' : 'eslint'),
        file,
        line: message.line ?? 1,
        col: message.column ?? 1,
        endLine: message.endLine ?? message.line ?? 1,
        endCol: message.endColumn ?? message.column ?? 1,
        severity,
        message: message.message ?? '',
        fixable: message.fix != null,
        linter: 'eslint',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// biome — `{ diagnostics: [ { category, severity, description, message,
// location: { path: { file }, span: [start, end] | start: { line, column } } } ] }`
// `span` values are BYTE OFFSETS into the file → converted via LineIndex.
// Format/organize-import diffs are NOT findings and are skipped.
// ---------------------------------------------------------------------------

interface BiomeDiagnostic {
  category?: string
  severity?: string
  description?: string
  message?: string
  fix?: unknown
  location?: BiomeLocation
}

interface BiomeLocation {
  path?: string | { file?: string }
  /** Older biome reporters emit byte offsets. */
  span?: [number, number]
  /** Biome ≥ 2 emits 1-based line/column objects. */
  start?: { line?: number; column?: number }
  end?: { line?: number; column?: number }
}

export async function parseBiomeJson(stdout: string, root: string): Promise<Finding[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new ParseError('biome', (error as Error).message)
  }
  const diagnostics = Array.isArray(parsed)
    ? parsed
    : (parsed as BiomeReport | null)?.diagnostics
  if (!Array.isArray(diagnostics)) throw new ParseError('biome', 'expected diagnostics array')
  const findings: Finding[] = []
  const lineIndexes = new Map<string, Promise<LineIndex | null>>()
  const lineIndexFor = (absFile: string): Promise<LineIndex | null> => {
    let entry = lineIndexes.get(absFile)
    if (!entry) {
      entry = readFile(absFile).then((buf) => new LineIndex(buf)).catch(() => null)
      lineIndexes.set(absFile, entry)
    }
    return entry
  }

  for (const diagnostic of diagnostics as BiomeDiagnostic[]) {
    if (!diagnostic || typeof diagnostic !== 'object') continue
    // Only real diagnostics count — format diffs and organize-import diffs
    // are rewrites, not findings.
    const category = diagnostic.category ?? ''
    if (category === 'format' || category === 'organizeImports') continue
    const rawPath = typeof diagnostic.location?.path === 'string'
      ? diagnostic.location.path
      : diagnostic.location?.path?.file
    if (!rawPath) continue
    // Biome reports the path as given on the CLI — we pass absolute paths,
    // but resolve defensively against the root for relative reports.
    const absFile = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath)
    const severity: Severity =
      diagnostic.severity === 'error' ? 'error' : diagnostic.severity === 'warning' ? 'warning' : 'info'
    let line = 1
    let col = 1
    let endLine = 1
    let endCol = 1
    const span = diagnostic.location?.span
    if (Array.isArray(span) && span.length === 2) {
      const index = await lineIndexFor(storeKey(absFile))
      if (index) {
        const start = index.toLineCol(span[0])
        const end = index.toLineCol(span[1])
        line = start.line
        col = start.col
        endLine = end.line
        endCol = end.col
      }
    } else if (diagnostic.location?.start?.line != null) {
      line = diagnostic.location.start.line
      col = diagnostic.location.start.column ?? 1
      endLine = diagnostic.location.end?.line ?? line
      endCol = diagnostic.location.end?.column ?? col
    }
    findings.push({
      rule: category || 'biome',
      file: relFile(absFile, root),
      line,
      col,
      endLine,
      endCol,
      severity,
      message: diagnostic.description ?? diagnostic.message ?? '',
      fixable: diagnostic.fix != null,
      linter: 'biome',
    })
  }
  return findings
}

interface BiomeReport {
  diagnostics?: BiomeDiagnostic[]
}

// ---------------------------------------------------------------------------
// ruff — `[ { code, message, filename, location: {row, column},
// end_location: {row, column}, fix } ]` (1-based; all findings are errors)
// ---------------------------------------------------------------------------

interface RuffMessage {
  code?: string | null
  message?: string
  filename?: string
  location?: { row?: number; column?: number }
  end_location?: { row?: number; column?: number }
  fix?: unknown
}

export function parseRuffJson(stdout: string, root: string): Finding[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new ParseError('ruff', (error as Error).message)
  }
  if (!Array.isArray(parsed)) throw new ParseError('ruff', 'expected a top-level array')
  const findings: Finding[] = []
  for (const message of parsed as RuffMessage[]) {
    if (!message || typeof message !== 'object' || !message.filename) continue
    findings.push({
      rule: message.code ?? 'ruff',
      file: relFile(message.filename, root),
      line: message.location?.row ?? 1,
      col: message.location?.column ?? 1,
      endLine: message.end_location?.row ?? message.location?.row ?? 1,
      endCol: message.end_location?.column ?? message.location?.column ?? 1,
      severity: 'error', // ruff has no severities — every violation is an error
      message: message.message ?? '',
      fixable: message.fix != null,
      linter: 'ruff',
    })
  }
  return findings
}

export function parseFindingsFor(linter: LinterKey, stdout: string, root: string): Finding[] | Promise<Finding[]> {
  switch (linter) {
    case 'eslint':
      return parseEslintJson(stdout, root)
    case 'biome':
      return parseBiomeJson(stdout, root)
    case 'ruff':
      return parseRuffJson(stdout, root)
  }
}
