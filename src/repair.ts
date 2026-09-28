/** Turn-scoped, regression-only auto-repair orchestration. */

import path from 'node:path'
import { turnEditedFiles, classifyFindings, type BaselineOwner } from './baseline.js'
import type { Finding } from './findings.js'
import { matchFindings } from './findings.js'
import { managerForRoot, type BatchFixResult } from './manager.js'
import { normalizeDrive } from './workspace.js'

export const REPAIR_MAX_ROUNDS = 2

export interface RepairReceipt {
  scope: 'turn'
  rounds: number
  regressionsFound: Finding[]
  autoFixed: Finding[]
  remaining: Finding[]
  affectedFiles: string[]
  fixerRuns: Array<Pick<BatchFixResult,
    'linter' | 'scope' | 'attemptedFiles' | 'modifiedFiles' | 'changedFiles' | 'rolledBackFiles' | 'error' | 'skippedBecause'>>
  skippedFixers: string[]
  fixerIntroducedRegressions: Finding[]
  fixerErrors: string[]
  preExistingIssuesIgnored: Finding[]
  stoppedBecause: 'clean' | 'no-progress' | 'round-limit' | 'no-turn-files'
}

function regressionSet(root: string, owner: BaselineOwner | undefined, current: Map<string, Finding[]>): Finding[] {
  const out: Finding[] = []
  for (const [abs, findings] of current) {
    if (!path.relative(root, abs).startsWith('..')) {
      const delta = classifyFindings(owner, abs, findings)
      out.push(...delta.introduced, ...delta.changed)
    }
  }
  return out
}

function toRelative(root: string, abs: string): string {
  return path.relative(root, abs).replaceAll('\\', '/')
}

function isUnder(file: string, dir: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Repair only introduced/changed findings against the current turn's baseline. */
export async function repairTurn(root: string, owner: BaselineOwner | undefined): Promise<RepairReceipt> {
  const normalizedRoot = path.resolve(root)
  const manager = managerForRoot(normalizedRoot)
  const files = turnEditedFiles(owner).filter((abs) => {
    const rel = path.relative(normalizedRoot, abs)
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  })
  const empty = (stoppedBecause: RepairReceipt['stoppedBecause']): RepairReceipt => ({
    scope: 'turn', rounds: 0, regressionsFound: [], autoFixed: [], remaining: [],
    affectedFiles: [], fixerRuns: [], fixerIntroducedRegressions: [], fixerErrors: [], skippedFixers: [],
    preExistingIssuesIgnored: [], stoppedBecause,
  })
  if (files.length === 0) return empty('no-turn-files')

  const original = await manager.lintMany(files)
  const regressionsFound = regressionSet(normalizedRoot, owner, original)
  const preExistingIssuesIgnored = [...original].flatMap(([abs, findings]) =>
    classifyFindings(owner, abs, findings).preexisting,
  )
  let current = original
  let remaining = regressionsFound
  const allRuns: RepairReceipt['fixerRuns'] = []
  const affected = new Set(files.map((abs) => toRelative(normalizedRoot, abs)))
  const fixerIntroduced: Finding[] = []
  const fixerErrors: string[] = []
  const skippedFixers: string[] = []
  let rounds = 0
  let stoppedBecause: RepairReceipt['stoppedBecause'] = remaining.length === 0 ? 'clean' : 'round-limit'

  while (remaining.length > 0 && rounds < REPAIR_MAX_ROUNDS) {
    const candidateFiles = [...new Set(remaining.map((finding) => path.resolve(normalizedRoot, finding.file)))]
    rounds++
    const results = await manager.fixMany(candidateFiles, remaining)
    for (const result of results) {
      const { before, after, fixerIntroducedRegressions: introducedByFixer, ...run } = result
      allRuns.push(run)
      if (run.error) fixerErrors.push(`${run.linter} (${run.scope}): ${run.error}`)
      if (run.skippedBecause) {
        skippedFixers.push(`${run.linter} (${run.scope}): ${run.skippedBecause}`)
        const scopeDir = path.resolve(normalizedRoot, run.scope)
        const allowed = remaining.filter((finding) => isUnder(path.resolve(normalizedRoot, finding.file), scopeDir))
        const ignoredHere = matchFindings(allowed, before).unmatchedCurrent.map((index) => before[index])
        preExistingIssuesIgnored.push(
          ...matchFindings(preExistingIssuesIgnored, ignoredHere).unmatchedCurrent.map((index) => ignoredHere[index]),
        )
      }
      for (const file of [...run.modifiedFiles, ...run.changedFiles, ...run.rolledBackFiles]) affected.add(file)
      fixerIntroduced.push(...introducedByFixer)
    }
    current = await manager.lintMany(files)
    const next = regressionSet(normalizedRoot, owner, current)
    if (next.length === 0) {
      remaining = []
      stoppedBecause = 'clean'
      break
    }
    remaining = next
    if (allRuns.every((run) => run.changedFiles.length === 0)) {
      stoppedBecause = 'no-progress'
      break
    }
    if (rounds >= REPAIR_MAX_ROUNDS) stoppedBecause = 'round-limit'
    // A fixer can change source while yielding the same diagnostics; the fixed
    // round count is the hard bound, and unchanged findings are retained.
  }

  const finalRegression = regressionSet(normalizedRoot, owner, current)
  const resolved = matchFindings(regressionsFound, finalRegression).unmatchedPrevious
    .map((index) => regressionsFound[index])
  return {
    scope: 'turn',
    rounds,
    regressionsFound,
    autoFixed: resolved,
    remaining: finalRegression,
    affectedFiles: [...affected].sort(),
    fixerRuns: allRuns,
    fixerIntroducedRegressions: fixerIntroduced,
    fixerErrors,
    skippedFixers,
    preExistingIssuesIgnored,
    stoppedBecause,
  }
}

export async function repairStatus(root: string, owner: BaselineOwner | undefined): Promise<{
  scope: 'turn'
  files: string[]
  introducedOrChanged: Finding[]
  preExistingIgnored: Finding[]
}> {
  const normalizedRoot = normalizeDrive(path.resolve(root))
  const introducedOrChanged: Finding[] = []
  const preExistingIgnored: Finding[] = []
  const tracked = turnEditedFiles(owner)
  const files = tracked.filter((abs) => {
    const relative = path.relative(path.resolve(root), path.resolve(abs))
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  })
  const currentByFile = await managerForRoot(root).lintMany(files)
  for (const [abs, current] of currentByFile) {
    if (!normalizeDrive(path.resolve(abs)).startsWith(`${normalizedRoot}${path.sep}`)) continue
    const delta = classifyFindings(owner, abs, current)
    introducedOrChanged.push(...delta.introduced, ...delta.changed)
    preExistingIgnored.push(...delta.preexisting)
  }
  return { scope: 'turn', files: files.map((abs) => toRelative(root, abs)).sort(), introducedOrChanged, preExistingIgnored }
}
