/** Plugin configuration: merged once at apply time, read wherever needed. */

import type { LinterKey } from './linters.js'

export interface PluginConfig {
  /** Set false to disable the auto-injected findings section (and the fs/observed listener). */
  autoInject?: boolean
  /** Hard cap on findings surfaced by tools and the injected section (token-cost guard). */
  maxFindings?: number
  /** Force specific linters (e.g. ['biome']) instead of the auto-detected set. Unknown keys are warned once. */
  linters?: LinterKey[]
  /** Optional override of the linter binary path, per linter ('eslint' | 'biome' | 'ruff'). A path ending in .js/.mjs/.cjs runs under the current Node — the seam the test fakes use. */
  linterPath?: Record<string, string>
  /** How long the injected post-edit delta stays in the prompt (ms, min 1000) — stale news is dropped. */
  sectionTtlMs?: number
  /** Per-run linter process timeout (ms, min 1000). A timed-out run is killed and reported, never hangs the loop. */
  timeoutMs?: number
}

interface EffectiveConfig {
  autoInject: boolean
  maxFindings: number
  linters: LinterKey[]
  linterPath: Record<string, string>
  sectionTtlMs: number
  timeoutMs: number
}

const DEFAULTS: EffectiveConfig = {
  autoInject: true,
  maxFindings: 50,
  linters: [],
  linterPath: {},
  sectionTtlMs: 30_000,
  timeoutMs: 10_000,
}

const state: { current: EffectiveConfig } = { current: { ...DEFAULTS } }

/** Merge a plugin-provided partial config over the defaults (idempotent). */
export function applyConfig(partial?: PluginConfig): void {
  state.current = {
    ...DEFAULTS,
    ...(partial ?? {}),
    linters:
      partial?.linters && partial.linters.length > 0
        ? [...partial.linters].filter((key): key is LinterKey =>
            (LINTER_KEYS as readonly string[]).includes(key),
          )
        : [],
    linterPath: { ...partial?.linterPath },
  }
  if (
    partial?.linters &&
    partial.linters.length > 0 &&
    state.current.linters.length !== partial.linters.length
  ) {
    console.warn(
      `[dsh-lint-loop] ignoring unknown linter keys in config (valid: ${LINTER_KEYS.join(', ')})`,
    )
  }
  // Coerce obviously wrong inputs.
  if (!Number.isFinite(state.current.maxFindings) || state.current.maxFindings < 1) {
    state.current.maxFindings = DEFAULTS.maxFindings
  }
  if (!Number.isFinite(state.current.sectionTtlMs) || state.current.sectionTtlMs < 1_000) {
    state.current.sectionTtlMs = DEFAULTS.sectionTtlMs
  }
  if (!Number.isFinite(state.current.timeoutMs) || state.current.timeoutMs < 1_000) {
    state.current.timeoutMs = DEFAULTS.timeoutMs
  }
}

export function getConfig(): Readonly<EffectiveConfig> {
  return state.current
}

import { LINTER_KEYS } from './linters.js'
