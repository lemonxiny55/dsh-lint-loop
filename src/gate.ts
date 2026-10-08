/** Awaited Completion Lane checkpoint. A continuation retains the original turn scope. */
import path from 'node:path'
import { clearAllBaselines, clearBaseline, ownerFromAgent, type BaselineOwner } from './baseline.js'
import { getConfig } from './config.js'
import { clearQualityTurn, disposeQuality, verifyQuality } from './quality.js'
import { findRepoRoot, resolveFileInRoot } from './workspace.js'

interface SteerableAgent { id?: string; session?: object; steer(message: unknown): void }
export interface TurnStoppingPayload { agent: SteerableAgent; turn: number; signal?: AbortSignal }
const dirty = new Set<string>()
const dirtyByOwner = new Map<BaselineOwner, Set<string>>()
const steers = new Map<string, number>()
const turns = new Map<BaselineOwner, number>()
const budgets = new Map<BaselineOwner, number>()
const steerKeys = new Map<BaselineOwner, Set<string>>()

/** Durable turn/end also fires for errors and cancellation, which bypass stopping. */
export function handleTurnEnded(session: object): void {
  const owner = ownerFromAgent({ session })
  if (!owner) return
  dirtyByOwner.delete(owner)
  clearBaseline(owner)
  clearQualityTurn(owner)
  for (const key of steerKeys.get(owner) ?? []) steers.delete(key)
  steerKeys.delete(owner)
  turns.delete(owner)
  budgets.delete(owner)
}

export function markDirty(displayPath: string | undefined, owner?: BaselineOwner): void {
  if (!displayPath) return
  if (!owner) { dirty.add(displayPath); return }
  const files = dirtyByOwner.get(owner) ?? new Set<string>()
  files.add(displayPath)
  dirtyByOwner.set(owner, files)
}
export async function handleTurnStopping(payload: TurnStoppingPayload): Promise<string | undefined> {
  try {
    const owner = ownerFromAgent(payload.agent)
    const owned = owner ? dirtyByOwner.get(owner) : undefined
    const trackingOwner = owned ? owner : undefined
    const identity = owner ?? 'gate:global'
    const oldTurn = turns.get(identity)
    if (oldTurn !== undefined && oldTurn !== payload.turn) { steers.delete(`${payload.agent.id ?? 'session'}::${oldTurn}`); budgets.delete(identity) }
    turns.set(identity, payload.turn)
    const files = [...new Set([...dirty, ...(owned ?? [])])]
    if (!files.length) return undefined
    const byRoot = new Map<string, string[]>()
    for (const file of files) {
      const root = await findRepoRoot(path.dirname(file))
      const abs = root && resolveFileInRoot(root, file)
      if (!root || !abs) continue
      const group = byRoot.get(root) ?? []
      group.push(abs); byRoot.set(root, group)
    }
    const config = getConfig()
    const used = budgets.get(identity) ?? 0
    const receipts = []
    for (const [root, group] of byRoot) receipts.push(await verifyQuality(root, trackingOwner, { files: group, signal: payload.signal, continuationRounds: used, continuationLimit: config.gateMaxSteers }))
    const regressions = receipts.flatMap((r) => r.newlyIntroducedRegressions)
    const key = `${payload.agent.id ?? 'session'}::${payload.turn}`
    const maySteer = config.gate && used < config.gateMaxSteers && !payload.signal?.aborted
    if (regressions.length && maySteer) {
      steers.set(key, used + 1)
      const keys = steerKeys.get(identity) ?? new Set<string>()
      keys.add(key); steerKeys.set(identity, keys)
      budgets.set(identity, used + 1)
      const body = regressions.slice(0, config.maxFindings).map((r) => `${r.check}: ${r.identity}`).join('\n')
      const text = `quality: this turn cannot finish cleanly — ${regressions.length} new regression(s).\n${body}\nFix only this turn's regressions (lint_repair performs safe autofix), then finish. Use quality_receipt for evidence. Continuation ${used + 1}/${config.gateMaxSteers}.`
      payload.agent.steer({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-lint-loop' } })
      return text
    }
    dirty.clear()
    if (owner) dirtyByOwner.delete(owner)
    clearBaseline(trackingOwner)
    clearQualityTurn(trackingOwner)
    return undefined
  } catch { return undefined }
}
export function steeringCountFor(sessionId: string, turn: number): number { return steers.get(`${sessionId}::${turn}`) ?? 0 }
export function clearGateState(): void {
  dirty.clear(); dirtyByOwner.clear(); steers.clear(); steerKeys.clear(); turns.clear(); budgets.clear(); clearAllBaselines(); disposeQuality()
}
