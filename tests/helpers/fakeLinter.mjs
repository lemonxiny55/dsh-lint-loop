// Minimal fake linter over CLI for tests — no real eslint/biome/ruff/golangci/cargo needed.
//
// Invoked as `node fakeLinter.mjs <linter args...> [target]` — it infers WHICH
// linter shape to emit from the args (the same args the plugin passes to the
// real binary) and derives findings from in-file markers:
//
//   // lint: <severity> <rule> <message>          → a finding
//   # lint: <severity> <rule> <message>           → same, python-style
//   ... [fixable] suffix on the message           → fixable finding
//   // lint: broken                               → output garbage (parse-failure path)
//
// Modes:
//   - eslint (default) / biome (`check --reporter=json`) / ruff (`check --output-format=json`):
//     the target FILE is the last arg; markers live in that one file.
//   - golangci-lint (`run ... <dir>`): scans <dir> for .go files and emits the
//     `{ Issues: [...] }` report with absolute Pos.Filename.
//   - cargo clippy (`clippy --message-format=json`): scans the process cwd for
//     .rs files and emits NDJSON `compiler-message` lines (like real cargo).
//
// Fix mode (`--fix` / `--write`): rewrites files stripping the comment of every
// fixable marker, prints nothing — the plugin re-lints after.
//
// Marker position rules: line = 1-based line number, col = 1-based index of
// the comment start; biome mode converts positions to BYTE-OFFSET spans like
// the real JSON reporter.
//
// Tests may set FAKE_RUN_LOG=<file> to append one `<mode>` line per invocation.

import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)

function logRun(mode) {
  const log = process.env.FAKE_RUN_LOG
  if (!log) return
  try {
    appendFileSync(log, `${mode}\n`)
  } catch {
    // best effort — the log is a test convenience
  }
}

// Legacy-eslint injection (env set by the flag-fallback test): old eslint
// rejects --no-warn-ignored with a usage error on stderr + exit 2.
if (process.env.FAKE_ESLINT_LEGACY === '1' && args.includes('--no-warn-ignored')) {
  console.error("eslint: unknown option '--no-warn-ignored'")
  process.exit(2)
}

const MARKER = /(\/\/|#)\s*lint:\s*(error|warning|info)\s+(\S+)\s+(.*)$/

function parseMarkers(content) {
  const findings = []
  const lines = content.split('\n')
  let offset = 0
  lines.forEach((line, index) => {
    const match = MARKER.exec(line)
    if (match) {
      const commentStart = line.indexOf(match[1])
      let message = match[4].trim()
      const fixable = message.endsWith('[fixable]')
      if (fixable) message = message.slice(0, -'[fixable]'.length).trim()
      findings.push({
        severity: match[2],
        rule: match[3],
        message,
        fixable,
        line: index + 1,
        col: commentStart + 1,
        endCol: line.length + 1,
        startByte: offset + Buffer.byteLength(line.slice(0, commentStart)),
        endByte: offset + Buffer.byteLength(line),
      })
    }
    offset += Buffer.byteLength(line) + 1
  })
  return findings
}

function hasBroken(content) {
  return /lint:\s*broken\b/.test(content)
}

function scanFiles(dir, exts, recursive) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recursive) out.push(...scanFiles(full, exts, recursive))
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

function stripFixable(content) {
  return content
    .split('\n')
    .map((line) => {
      const match = MARKER.exec(line)
      if (!match || !match[4].trim().endsWith('[fixable]')) return line
      return line.slice(0, line.indexOf(match[1])).trimEnd()
    })
    .join('\n')
}

const isGolangci = args[0] === 'run'
const isClippy = args[0] === 'clippy'
const isFix = args.includes('--write') || (args.includes('--fix') && !args.includes('--output-format=json'))

if (isGolangci) {
  const dir = args[args.length - 1]
  const files = scanFiles(dir, ['.go'], false)
  logRun('golangci')
  if (files.some((file) => hasBroken(readFileSync(file, 'utf8')))) {
    console.log('this is definitely not json {{{')
    process.exit(0)
  }
  if (isFix) {
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      const fixed = stripFixable(content)
      if (fixed !== content) writeFileSync(file, fixed, 'utf8')
    }
    process.exit(0)
  }
  const Issues = []
  for (const file of files) {
    for (const marker of parseMarkers(readFileSync(file, 'utf8'))) {
      Issues.push({
        FromLinter: marker.rule,
        Text: marker.message,
        Severity: marker.severity,
        Replacement: marker.fixable ? { NewLines: [] } : null,
        Pos: { Filename: file, Line: marker.line, Column: marker.col },
      })
    }
  }
  console.log(JSON.stringify({ Issues, Report: {} }))
  process.exit(0)
}

if (isClippy) {
  const files = scanFiles(process.cwd(), ['.rs'], true)
  logRun('clippy')
  if (files.some((file) => hasBroken(readFileSync(file, 'utf8')))) {
    console.log('not ndjson at all')
    process.exit(0)
  }
  if (isFix) {
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      const fixed = stripFixable(content)
      if (fixed !== content) writeFileSync(file, fixed, 'utf8')
    }
    process.exit(0)
  }
  const lines = []
  for (const file of files) {
    for (const marker of parseMarkers(readFileSync(file, 'utf8'))) {
      lines.push(JSON.stringify({
        reason: 'compiler-message',
        message: {
          level: marker.severity === 'error' ? 'error' : 'warning',
          message: marker.message,
          code: { code: marker.rule, explanation: null },
          spans: [
            {
              file_name: file,
              line_start: marker.line,
              line_end: marker.line,
              column_start: marker.col,
              column_end: marker.endCol,
              is_primary: true,
              suggested_replacement: marker.fixable ? '' : null,
            },
          ],
        },
      }))
    }
  }
  lines.push(JSON.stringify({ reason: 'build-finished', success: true }))
  console.log(lines.join('\n'))
  process.exit(0)
}

const file = args[args.length - 1]
const content = readFileSync(file, 'utf8')

// Parse-failure injection: exit 0 with non-JSON output.
if (hasBroken(content)) {
  console.log('this is definitely not json {{{')
  process.exit(0)
}

const markers = parseMarkers(content)

// --- fix modes ---------------------------------------------------------------
if (isFix) {
  writeFileSync(file, stripFixable(content), 'utf8')
  process.exit(0)
}

// --- lint modes ---------------------------------------------------------------
const isRuff = args.includes('check') && args.includes('--output-format=json')
const isBiome = args.includes('check') && !isRuff

if (isRuff) {
  logRun('ruff')
  console.log(JSON.stringify(markers.map((m) => ({
    code: m.rule,
    message: m.message,
    filename: file,
    location: { row: m.line, column: m.col },
    end_location: { row: m.line, column: m.endCol },
    fix: m.fixable ? { applicability: 'FixApplicability.Safe', edits: [], message: '' } : null,
    noqa_row: m.line,
    url: `https://docs.astral.sh/ruff/rules/${m.rule.toLowerCase()}`,
  }))))
  process.exit(0)
}

if (isBiome) {
  logRun('biome')
  console.log(JSON.stringify({
    $schema: 'https://biomejs.dev/schemas/2.0.0/schema.json',
    files: { max_diagnostics_reached: false, written: false },
    diagnostics: markers.map((m) => ({
      category: `lint/correctness/${m.rule}`,
      severity: m.severity === 'error' ? 'error' : m.severity === 'warning' ? 'warning' : 'information',
      description: m.message,
      message: m.message,
      location: { path: { file }, span: [m.startByte, m.endByte] },
    })),
  }))
  process.exit(0)
}

// eslint shape (default)
logRun('eslint')
console.log(JSON.stringify([{
  filePath: file,
  messages: markers.map((m) => ({
    ruleId: m.rule,
    severity: m.severity === 'error' ? 2 : m.severity === 'warning' ? 1 : 3,
    line: m.line,
    column: m.col,
    endLine: m.line,
    endColumn: m.endCol,
    message: m.message,
    fix: m.fixable ? { range: [m.startByte, m.endByte], text: '' } : undefined,
  })),
  errorCount: markers.filter((m) => m.severity === 'error').length,
  warningCount: markers.filter((m) => m.severity === 'warning').length,
  fixableErrorCount: markers.filter((m) => m.severity === 'error' && m.fixable).length,
  fixableWarningCount: markers.filter((m) => m.severity === 'warning' && m.fixable).length,
  source: null,
}]))
