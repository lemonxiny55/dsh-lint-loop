// Minimal fake linter over CLI for tests — no real eslint/biome/ruff needed.
//
// Invoked as `node fakeLinter.mjs <linter args...> <file>` — it infers WHICH
// linter shape to emit from the args (the same args the plugin passes to the
// real binary) and derives findings from in-file markers:
//
//   // lint: <severity> <rule> <message>          → a finding
//   # lint: <severity> <rule> <message>           → same, python-style
//   ... [fixable] suffix on the message           → fixable finding
//   // lint: broken                               → output garbage (parse-failure path)
//
// Fix mode (--fix / --write / check --fix): rewrites the file stripping the
// comment of every fixable marker, prints nothing — the plugin re-lints after.
//
// Marker position rules: line = 1-based line number, col = 1-based index of
// the comment start; biome mode converts positions to BYTE-OFFSET spans like
// the real JSON reporter.

const args = process.argv.slice(2)
const file = args[args.length - 1]

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
    if (/lint:\s*broken\b/.test(line)) globalThis.__broken = true
    offset += Buffer.byteLength(line) + 1
  })
  return findings
}

import { readFileSync, writeFileSync } from 'node:fs'

const content = readFileSync(file, 'utf8')

// Parse-failure injection: exit 0 with non-JSON output.
if (/lint:\s*broken\b/.test(content)) {
  console.log('this is definitely not json {{{')
  process.exit(0)
}

const markers = parseMarkers(content)

// --- fix modes ---------------------------------------------------------------
const isFix = args.includes('--write') || (args.includes('--fix') && !args.includes('--output-format=json'))
if (isFix) {
  const lines = content.split('\n')
  const fixed = lines
    .map((line, index) => {
      const match = MARKER.exec(line)
      if (!match) return line
      const finding = markers.find((m) => m.line === index + 1)
      if (!finding || !finding.fixable) return line
      const commentStart = line.indexOf(match[1])
      return line.slice(0, commentStart).trimEnd()
    })
    .join('\n')
  writeFileSync(file, fixed, 'utf8')
  process.exit(0)
}

// --- lint modes ---------------------------------------------------------------
const isRuff = args.includes('check') && args.includes('--output-format=json')
const isBiome = args.includes('check') && !isRuff

if (isRuff) {
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
