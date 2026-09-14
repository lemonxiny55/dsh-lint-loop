/**
 * Completion gate: at the turn-stopping boundary, if files edited during this
 * turn still carry lint errors, steer the agent for another step instead of
 * letting it finish.
 *
 * The harness `agent/turn-stopping` seam is a serial checkpoint with no
 * built-in loop guard (the first-party Claude Code bridge carries an explicit
 * TODO for exactly that), so this gate self-limits: a file is only considered
 * once per stopping, and each turn may force at most `gateMaxSteers`
 * continuations before admitting the turn.
 */

import path from 'node:path'
import { getConfig } from './config.js'
import { renderFindings, sortFindings, type Finding } from './findings.js'
import { linterFamilyForExt, extOf } from './linters.js'
import { managerForRoot } from './manager.js'
import { findRepoRoot, resolveFileInRoot } from './workspace.js'

interface SteerableAgent {
  id?: string
  steer(message: unknown): void
}

export interface TurnStoppingPayload {
  agent: SteerableAgent
  turn: number
  signal?: unknown
}

/** Files observed (written/edited) since the last gate evaluation. */
const dirty = new Set<string>()
/** Forced continuations per `${sessionId}::${turn}`. */
const steers = new Map<string, number>()

function debug(...args: unknown[]): void {
  if (process.env.DSH_LINT_DEBUG === '1') console.log('[dsh-lint-loop][debug]', ...args)
}

/** Queue a file from an fs/observed event. Synchronous, never throws. */
export function markDirty(displayPath: string | undefined): void {
  try {
    if (displayPath) {
      debug('markDirty', displayPath)
      dirty.add(displayPath)
    }
  } catch {
    // fs/observed listeners must be infallible.
  }
}

/** Lint every queued file (one run per package) and collect the gated severity. */
async function collectErrors(files: readonly string[]): Promise<Finding[]> {
  const config = getConfig()
  const byRoot = new Map<string, string[]>()
  for (const displayPath of files) {
    const root = await findRepoRoot(path.dirname(displayPath))
    if (!root) continue
    const abs = resolveFileInRoot(root, displayPath)
    if (!abs || !linterFamilyForExt(extOf(abs))) continue
    const list = byRoot.get(root) ?? []
    list.push(abs)
    byRoot.set(root, list)
  }
  const out: Finding[] = []
  for (const [root, absPaths] of byRoot) {
    try {
      const results = await managerForRoot(root).lintMany(absPaths)
      for (const findings of results.values()) {
        for (const finding of findings) {
          if (finding.severity === config.gateSeverity) out.push(finding)
        }
      }
    } catch {
      // No linter configured / unexpected failure: nothing to gate on.
    }
  }
  return out
}

function renderGateText(errors: readonly Finding[]): string {
  const config = getConfig()
  const sorted = sortFindings(errors)
  const shown = sorted.slice(0, config.maxFindings)
  const body = renderFindings(shown, sorted.length - shown.length)
  return (
    `lint: this turn cannot finish cleanly — ${sorted.length} error${sorted.length === 1 ? '' : 's'} `
    + `remain in file${new Set(sorted.map((f) => f.file)).size === 1 ? '' : 's'} you edited.\n`
    + `${body}\n`
    + '(fix them (lint_fix repairs what it can), then finish — this nudge is capped per turn)'
  )
}

function createSteerMessage(text: string): unknown {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-lint-loop' },
  }
}

/**
 * Handle the turn-stopping boundary. Never throws — a gate failure must not
 * break the turn. Returns the text it steered with, for tests.
 */
export async function handleTurnStopping(payload: TurnStoppingPayload): Promise<string | undefined> {
  try {
    const config = getConfig()
    const files = [...dirty]
    dirty.clear()
    debug('turn-stopping', 'gate=', config.gate, 'maxSteers=', config.gateMaxSteers, 'dirtyFiles=', files.length)
    if (!config.gate || config.gateMaxSteers <= 0) return undefined
    if (files.length === 0) return undefined

    const errors = await collectErrors(files)
    debug('turn-stopping errors=', errors.length)
    if (errors.length === 0) return undefined

    const key = `${payload.agent.id ?? 'session'}::${payload.turn}`
    const used = steers.get(key) ?? 0
    if (used >= config.gateMaxSteers) return undefined
    steers.set(key, used + 1)

    const text = renderGateText(errors)
    payload.agent.steer(createSteerMessage(text))
    return text
  } catch {
    return undefined
  }
}

/** Test/manual seam for the per-turn counter. */
export function steeringCountFor(sessionId: string, turn: number): number {
  return steers.get(`${sessionId}::${turn}`) ?? 0
}

export function clearGateState(): void {
  dirty.clear()
  steers.clear()
}
