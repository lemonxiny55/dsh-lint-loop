/** Completion Lane: immutable pre-edit evidence, bounded checks and honest receipts. */
import path from 'node:path'
import { classifyFindings, hasAuthoritativeBaseline, turnEditedFiles, type BaselineOwner } from './baseline.js'
import { getConfig } from './config.js'
import { findingFingerprint, type Finding } from './findings.js'
import { extOf, linterFamilyForExt } from './linters.js'
import { managerForRoot } from './manager.js'
import { executeChecks, type CheckEvidence } from './quality-checks.js'
import { discoverQualityPlan, staticImpactProvider, type ImpactProvider, type TestSelection } from './quality-plan.js'
import { normalizeDrive, resolveFileInRoot, toRelative } from './workspace.js'

export type QualityStatus = 'clean' | 'regression' | 'incomplete' | 'skipped'
export interface QualityIssue { check: string; identity: string }
export interface QualityReceipt {
  schemaVersion: 1
  mode: 'fast' | 'balanced' | 'strict'
  root: string
  changedFiles: string[]
  newlyIntroducedRegressions: QualityIssue[]
  autoFixed: QualityIssue[]
  agentFixed: QualityIssue[]
  ignoredHistoricalDebt: QualityIssue[]
  lint: QualityStatus
  typecheck: QualityStatus
  tests: QualityStatus
  selection: TestSelection
  checksExecuted: CheckEvidence[]
  baselineChecks: CheckEvidence[]
  repairRounds: number
  continuationRounds: number
  elapsedMs: number
  finalVerdict: 'clean' | 'regression' | 'incomplete' | 'cancelled'
  reasons: string[]
}
interface State {
  controller: AbortController
  baseline?: Promise<CheckEvidence[]>
  receipt?: QualityReceipt
  seen: QualityIssue[]
  autoFixed: QualityIssue[]
  repairRounds: number
  pending?: Promise<QualityReceipt>
}
const states = new Map<BaselineOwner, Map<string, State>>()
const GLOBAL = 'quality:global'
let generation = 0
function getState(root: string, owner?: BaselineOwner): State {
  const key = owner ?? GLOBAL
  let roots = states.get(key)
  if (!roots) { roots = new Map(); states.set(key, roots) }
  root = normalizeDrive(path.resolve(root))
  let state = roots.get(root)
  if (!state) { state = { controller: new AbortController(), seen: [], autoFixed: [], repairRounds: 0 }; roots.set(root, state) }
  return state
}
function boundedSignal(parent: AbortSignal, caller?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of [parent, caller]) {
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })
  }
  const timer = setTimeout(abort, getConfig().qualityTimeoutMs)
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); caller?.removeEventListener('abort', abort) } }
}
/** Must be awaited BEFORE the first mutation. Never rewinds or edits user files. */
export async function prepareQualityBaseline(root: string, owner?: BaselineOwner, caller?: AbortSignal): Promise<void> {
  const state = getState(root, owner)
  if (!getConfig().completionChecks || state.baseline) { await state.baseline; return }
  state.baseline = (async () => {
    const budget = boundedSignal(state.controller.signal, caller)
    const deadline = Date.now() + getConfig().qualityTimeoutMs
    try { return await executeChecks(await discoverQualityPlan(root), undefined, budget.signal, deadline) }
    finally { budget.dispose() }
  })()
  await state.baseline
}
/** Multisets preserve duplicate diagnostics; line shifts do not erase historical debt. */
export function issueDelta(before: readonly string[], after: readonly string[]): { introduced: string[]; historical: string[] } {
  const counts = new Map<string, number>()
  for (const key of before) counts.set(key, (counts.get(key) ?? 0) + 1)
  const introduced: string[] = [], historical: string[] = []
  for (const key of after) {
    const count = counts.get(key) ?? 0
    if (count) { historical.push(key); counts.set(key, count - 1) } else introduced.push(key)
  }
  return { introduced, historical }
}
const lintIssue = (f: Finding): QualityIssue => ({ check: 'lint', identity: findingFingerprint(f) })
const issueKey = (i: QualityIssue): string => `${i.check}|${i.identity}`
function union(a: QualityIssue[], b: QualityIssue[]): QualityIssue[] {
  const counts = new Map<string, number>()
  for (const item of a) counts.set(issueKey(item), (counts.get(issueKey(item)) ?? 0) + 1)
  const seen = new Map<string, number>()
  const result = [...a]
  for (const item of b) {
    const key = issueKey(item), count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count > (counts.get(key) ?? 0)) result.push(item)
  }
  return result
}
export function recordQualityRepair(root: string, owner: BaselineOwner | undefined, fixed: Finding[], rounds: number): void {
  const state = getState(root, owner)
  state.autoFixed.push(...fixed.map(lintIssue))
  state.repairRounds += rounds
}
export function qualityRepairRounds(root: string, owner?: BaselineOwner): number { return getState(root, owner).repairRounds }
export function qualityReceipt(root: string, owner?: BaselineOwner): QualityReceipt | undefined {
  // Detached JSON snapshot: a consumer cannot mutate the gate's stored evidence.
  const receipt = getState(root, owner).receipt
  return receipt ? structuredClone(receipt) : undefined
}
export function clearQualityTurn(owner?: BaselineOwner): void {
  const roots = states.get(owner ?? GLOBAL)
  // Keep the final receipt; drop turn-specific baselines and repair accounting.
  for (const [root, state] of roots ?? []) {
    state.controller.abort()
    // Detach in-flight work so its late result cannot populate the next turn.
    roots!.set(root, { controller: new AbortController(), receipt: state.receipt, seen: [], autoFixed: [], repairRounds: 0 })
  }
}
export function disposeQuality(): void {
  generation++
  for (const roots of states.values()) for (const state of roots.values()) state.controller.abort()
  states.clear()
}

export async function verifyQuality(root: string, owner?: BaselineOwner, options: { files?: readonly string[]; signal?: AbortSignal; provider?: ImpactProvider; continuationRounds?: number; continuationLimit?: number } = {}): Promise<QualityReceipt> {
  root = normalizeDrive(path.resolve(root))
  const state = getState(root, owner)
  // One verification owns a root/session. Concurrent callers share its immutable result.
  if (state.pending) return structuredClone(await state.pending)
  const epoch = generation
  state.pending = (async () => {
    const started = Date.now(), config = getConfig()
    const files = [...new Set([...(options.files ?? []), ...turnEditedFiles(owner)])].map((f) => resolveFileInRoot(root, f)).filter((f): f is string => !!f).sort()
    const receipt: QualityReceipt = {
      schemaVersion: 1, mode: config.mode, root, changedFiles: files.map((f) => toRelative(f, root)),
      newlyIntroducedRegressions: [], autoFixed: [...state.autoFixed], agentFixed: [], ignoredHistoricalDebt: [],
      lint: 'clean', typecheck: 'skipped', tests: 'skipped', selection: { strategy: 'dependency', files: [], reasons: [], complete: true },
      checksExecuted: [], baselineChecks: [], repairRounds: state.repairRounds, continuationRounds: options.continuationRounds ?? 0, elapsedMs: 0, finalVerdict: 'clean', reasons: [],
    }
    const budget = boundedSignal(state.controller.signal, options.signal)
    const deadline = started + config.qualityTimeoutMs
    try {
      for (const file of files) {
        if (!linterFamilyForExt(extOf(file))) continue
        const check: CheckEvidence = { id: `lint:${toRelative(file, root)}`, kind: 'lint', scope: toRelative(file, root), command: 'configured linter', args: [file], status: 'complete', issues: [], executed: [], elapsedMs: 0 }
        receipt.checksExecuted.push(check)
        const begin = Date.now()
        try {
          if (budget.signal.aborted) throw new Error('verification cancelled or timed out')
          check.invocations = []
          const findings = await managerForRoot(root).lintFile(file, budget.signal, (run) => { check.command = run.command; check.args = run.args; check.invocations!.push(run) })
          const delta = classifyFindings(owner, file, findings)
          // A failed modern pre-edit probe cannot prove any finding is new.
          // Keep the owner-less legacy markDirty seam's original behavior.
          if (hasAuthoritativeBaseline(owner, file) || owner === undefined) receipt.newlyIntroducedRegressions.push(...[...delta.introduced, ...delta.changed].filter((f) => f.severity === config.gateSeverity).map(lintIssue))
          receipt.ignoredHistoricalDebt.push(...delta.preexisting.map(lintIssue))
          check.issues = findings.map(findingFingerprint)
          if (!hasAuthoritativeBaseline(owner, file)) { receipt.lint = 'incomplete'; receipt.reasons.push(`lint baseline unavailable: ${toRelative(file, root)}`) }
        } catch (error) { check.status = budget.signal.aborted ? 'cancelled' : 'failed'; check.reason = String(error); receipt.lint = 'incomplete'; receipt.reasons.push(`lint unavailable: ${toRelative(file, root)}`) }
        check.elapsedMs = Date.now() - begin
      }
      if (receipt.newlyIntroducedRegressions.some((i) => i.check === 'lint')) receipt.lint = 'regression'
      if (config.completionChecks && files.length) {
        const plan = await discoverQualityPlan(root)
        receipt.selection = await (options.provider ?? staticImpactProvider).select(plan, files)
        receipt.selection.files = receipt.selection.files.map((f) => toRelative(f, root))
        const selectionForRun = { ...receipt.selection, files: receipt.selection.files.map((f) => path.resolve(root, f)) }
        receipt.baselineChecks = await state.baseline ?? []
        const checks = await executeChecks(plan, selectionForRun, budget.signal, deadline)
        receipt.checksExecuted.push(...checks)
        for (const kind of ['typecheck', 'tests'] as const) {
          const relevant = checks.filter((c) => c.kind === kind)
          receipt[kind] = relevant.length ? 'clean' : 'incomplete'
          if (!relevant.length) receipt.reasons.push(`${kind}: no supported checks executed`)
          if (!plan.complete || !receipt.selection.complete) receipt[kind] = 'incomplete'
          for (const check of relevant) {
            const baseline = receipt.baselineChecks.find((c) => c.id === check.id)
            if (check.status !== 'complete' || baseline?.status !== 'complete') {
              receipt[kind] = 'incomplete'; receipt.reasons.push(`${check.id}: ${check.reason ?? 'pre-edit baseline unavailable'}`); continue
            }
            const delta = issueDelta(baseline.issues, check.issues)
            receipt.newlyIntroducedRegressions.push(...delta.introduced.map((identity) => ({ check: check.id, identity })))
            receipt.ignoredHistoricalDebt.push(...delta.historical.map((identity) => ({ check: check.id, identity })))
            if (delta.introduced.length) receipt[kind] = 'regression'
          }
        }
      }
      if (!config.completionChecks) receipt.reasons.push('fast mode or completionChecks=false: typecheck/tests intentionally skipped')
      const resolved = issueDelta([...receipt.newlyIntroducedRegressions, ...state.autoFixed].map(issueKey), state.seen.map(issueKey)).introduced
      const resolvedCounts = new Map<string, number>()
      for (const key of resolved) resolvedCounts.set(key, (resolvedCounts.get(key) ?? 0) + 1)
      receipt.agentFixed = state.seen.filter((issue) => {
        const key = issueKey(issue), count = resolvedCounts.get(key) ?? 0
        if (!count) return false
        resolvedCounts.set(key, count - 1)
        return receipt.checksExecuted.some((check) => {
          if (check.status !== 'complete') return false
          if (issue.check === 'lint') return check.kind === 'lint' && issue.identity.startsWith(check.scope + '|') && hasAuthoritativeBaseline(owner, path.resolve(root, check.scope))
          if (check.id !== issue.check || receipt.baselineChecks.find((b) => b.id === check.id)?.status !== 'complete') return false
          return check.kind !== 'tests' || check.executed.some((test) => issue.identity.startsWith(test + '|'))
        })
      })
      state.seen = union(state.seen, receipt.newlyIntroducedRegressions)
      receipt.finalVerdict = options.signal?.aborted || state.controller.signal.aborted ? 'cancelled'
        : receipt.newlyIntroducedRegressions.length ? 'regression'
          : [receipt.lint, receipt.typecheck, receipt.tests].some((s) => s === 'incomplete' || s === 'skipped') ? 'incomplete' : 'clean'
      if (receipt.finalVerdict === 'regression' && options.continuationLimit !== undefined && receipt.continuationRounds >= options.continuationLimit) receipt.reasons.push('continuation budget exhausted; the agent may stop but the change is still a regression')
      return receipt
    } catch (error) { receipt.finalVerdict = 'incomplete'; receipt.reasons.push(String(error)); return receipt }
    finally {
      budget.dispose()
      receipt.elapsedMs = Date.now() - started
      if (epoch === generation) state.receipt = structuredClone(receipt)
    }
  })()
  try { return structuredClone(await state.pending) } finally { state.pending = undefined }
}
