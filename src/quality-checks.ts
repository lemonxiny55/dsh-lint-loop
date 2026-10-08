import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { getConfig } from './config.js'
import { runProcess } from './runner.js'
import { scopeFor, type QualityPlan, type TestSelection } from './quality-plan.js'

export interface CheckEvidence {
  id: string
  kind: 'lint' | 'typecheck' | 'tests'
  scope: string
  command: string
  args: string[]
  status: 'complete' | 'unavailable' | 'failed' | 'cancelled' | 'timeout'
  issues: string[]
  executed: string[]
  elapsedMs: number
  reason?: string
  invocations?: Array<{ command: string; args: string[]; cwd: string }>
  skipped?: string[]
  /** Bounded raw evidence only when a reporter cannot be parsed. */
  unparsedOutput?: { exitCode: number | null; stdout: string; stderr: string }
}
export function parseTypecheck(text: string): string[] | null {
  const lines = text.trim().split(/\r?\n/)
  const issues: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const match = /^(?:(.*?)\(\d+,\d+\):\s*|)error (TS\d+):\s*(.*)$/.exec(line)
    if (match) issues.push(`${(match[1] ?? '<project>').replaceAll('\\', '/')}|${match[2]}|${match[3]}`)
    else if (/^\s+/.test(line) && issues.length) issues[issues.length - 1] += ' ' + line.trim()
    else return null
  }
  return issues
}
async function typecheckSourceKeys(text: string, cwd: string, issues: string[]): Promise<string[]> {
  const locations = [...text.matchAll(/^(.*?)\((\d+),\d+\):\s*error TS\d+:/gm)]
  const contents = new Map<string, string[]>()
  let locationIndex = 0
  const result: string[] = []
  for (const issue of issues) {
    if (issue.startsWith('<project>|')) { result.push(issue); continue }
    const location = locations[locationIndex++]
    if (!location) { result.push(issue); continue }
    const file = path.resolve(cwd, location[1])
    let lines = contents.get(file)
    if (!lines) { lines = (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/); contents.set(file, lines) }
    // A safe semicolon fix must not turn the same diagnostic into a new issue.
    const source = lines[Number(location[2]) - 1]?.trim().replace(/\s+/g, ' ').replace(/;+$/, '')
    const context = source ? createHash('sha256').update(source).digest('hex').slice(0, 16) : 'unknown'
    result.push(`${issue}|source:${context}`)
  }
  return result
}
export function parseTestReport(text: string, cwd: string): { issues: string[]; executed: string[]; skipped: string[] } | null {
  try {
    // Reporters may print a startup banner before their one JSON object.
    const start = text.indexOf('{')
    const report = JSON.parse(text.slice(start)) as { testResults?: Array<{ name?: string; status?: string; message?: string; assertionResults?: Array<{ fullName?: string; title?: string; status?: string; failureMessages?: string[] }> }>; numTotalTests?: number; numFailedTestSuites?: number; success?: boolean }
    if (!Array.isArray(report.testResults) || typeof report.numTotalTests !== 'number' || report.numTotalTests < 1) return null
    const issues: string[] = [], executed: string[] = [], skipped: string[] = []
    for (const suite of report.testResults) {
      if (!suite.name || !Array.isArray(suite.assertionResults)) return null
      const file = path.relative(cwd, suite.name).replaceAll('\\', '/')
      for (const test of suite.assertionResults) {
        const key = `${file}|${test.fullName ?? test.title ?? ''}`
        if (test.status === 'passed' || test.status === 'failed') executed.push(key)
        else skipped.push(key)
        if (test.status === 'failed') {
          const signature = (test.failureMessages ?? []).join('\n').split(/\n\s+at\b|\n\s*[❯>]/)[0].replace(/\u001b\[[0-9;]*m/g, '').replaceAll(cwd, '<package>').replace(/\s+/g, ' ').trim()
          issues.push(`${key}|${signature || '<failed>'}`)
        }
        // pending/todo tests are reported but cannot count as executed evidence.
      }
      if (suite.status === 'failed' && !suite.assertionResults.some((t) => t.status === 'failed')) {
        // Runtime/setup failures cannot be attributed to a stable test identity.
        // Keep these incomplete instead of silently calling them historical debt.
        return null
      }
    }
    if (!executed.length && !issues.length) return null
    if (report.success === false && !issues.length) return null
    return { issues, executed, skipped }
  } catch { return null }
}

export async function executeChecks(plan: QualityPlan, selection: TestSelection | undefined, signal: AbortSignal, deadline: number): Promise<CheckEvidence[]> {
  const checks: CheckEvidence[] = []
  const config = getConfig()
  for (const scope of plan.scopes) {
    const rel = path.relative(plan.root, scope.dir).replaceAll('\\', '/') || '.'
    for (const kind of ['typecheck', 'tests'] as const) {
      const entry = kind === 'typecheck' ? scope.typeEntry : scope.testEntry
      if (kind === 'typecheck' && !scope.tsconfig) continue
      if (kind === 'tests' && !scope.hasTests) continue
      const selected = selection?.files.filter((f) => scopeFor(plan, f)?.dir === scope.dir)
      if (kind === 'tests' && selection?.strategy === 'dependency' && !selected?.length) continue
      if (kind === 'tests' && selection?.strategy === 'package-fallback' && !selected?.length) continue
      const args = kind === 'typecheck'
        ? [entry ?? '', '--noEmit', '--pretty', 'false', '--incremental', 'false', '-p', scope.tsconfig!]
        : scope.runner === 'vitest' ? [entry ?? '', 'run', '--reporter=json', ...(selection?.strategy === 'dependency' ? selected! : [])]
          : [entry ?? '', '--runInBand', '--json', ...(selection?.strategy === 'dependency' ? ['--runTestsByPath', ...selected!] : [])]
      const check: CheckEvidence = { id: `${kind}:${rel}`, kind, scope: rel, command: process.execPath, args, status: 'unavailable', issues: [], executed: [], elapsedMs: 0 }
      checks.push(check)
      if (!entry) { check.reason = 'no supported local runner/compiler; arbitrary scripts are not executed'; continue }
      if (checks.length > config.qualityMaxChecks) { check.reason = 'check budget exceeded'; continue }
      if (signal.aborted) { check.status = 'cancelled'; continue }
      const remaining = deadline - Date.now()
      if (remaining <= 0) { check.status = 'timeout'; continue }
      const start = Date.now()
      const run = await runProcess(process.execPath, args, { cwd: scope.dir, timeoutMs: remaining, signal })
      check.elapsedMs = Date.now() - start
      if (run.cancelled) check.status = 'cancelled'
      else if (run.timedOut) check.status = 'timeout'
      else if (run.spawnError || run.truncated) { check.status = 'failed'; check.reason = run.spawnError?.message ?? 'output truncated' }
      else {
        const parsed = kind === 'typecheck' ? parseTypecheck(run.stdout + run.stderr) : parseTestReport(run.stdout, scope.dir)
        if (parsed === null) {
          check.status = 'failed'; check.reason = 'unrecognized or empty evidence'
          check.unparsedOutput = { exitCode: run.exitCode, stdout: run.stdout.slice(0, 2000), stderr: run.stderr.slice(0, 2000) }
        }
        else {
          check.issues = Array.isArray(parsed) ? await typecheckSourceKeys(run.stdout + run.stderr, scope.dir, parsed) : parsed.issues
          check.executed = Array.isArray(parsed) ? [] : parsed.executed
          check.skipped = Array.isArray(parsed) ? [] : parsed.skipped
          check.status = run.exitCode === 0 || check.issues.length > 0 ? 'complete' : 'failed'
          if (check.status === 'failed') check.reason = 'nonzero exit without attributable diagnostics'
          if (check.skipped.length) { check.status = 'failed'; check.reason = 'selected tests contain skipped/pending evidence' }
          if (kind === 'typecheck' && check.issues.some((i) => /\|TS(?:18003|5083|6053|6305|6310)\|/.test(i))) { check.status = 'failed'; check.reason = 'compiler configuration or reference outputs cannot verify source' }
        }
      }
    }
  }
  return checks
}
