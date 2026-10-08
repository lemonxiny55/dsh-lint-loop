/** Plugin configuration: merged once at apply time, read wherever needed. */

import type { Severity } from './findings.js'
import { LINTER_KEYS, type LinterKey } from './linters.js'

export interface PluginConfig {
  /** Quality Loop preset. Advanced fields override the preset. */
  mode?: 'fast' | 'balanced' | 'strict'
  /** Completion checks; fast intentionally skips typecheck and tests. */
  completionChecks?: boolean
  /** Total budget for each baseline/completion sweep, including all packages. */
  qualityTimeoutMs?: number
  /** Bound repository discovery and the number of executed package checks. */
  qualityMaxFiles?: number
  qualityMaxChecks?: number
  /** Set false to disable the auto-injected findings section (and the fs/observed listener). */
  autoInject?: boolean
  /** Hard cap on findings surfaced by tools and the injected section (token-cost guard). */
  maxFindings?: number
  /** Force specific linters (e.g. ['biome']) instead of the auto-detected set. Unknown keys are warned once. */
  linters?: LinterKey[]
  /** Optional override of the linter binary path, per linter ('eslint' | 'biome' | 'ruff' | 'golangci' | 'clippy'). A path ending in .js/.mjs/.cjs runs under the current Node — the seam the test fakes use. */
  linterPath?: Record<string, string>
  /** How long the injected post-edit delta stays in the prompt (ms, min 1000) — stale news is dropped. */
  sectionTtlMs?: number
  /** Per-run linter process timeout (ms, min 1000). A timed-out run is killed and reported, never hangs the loop. */
  timeoutMs?: number
  /** Severity the injected section reports (default 'error' — warnings stay out of the prompt). */
  sectionSeverity?: Severity
  /** Quiet period after the last edit before the section re-lints (ms, min 100). */
  settleMs?: number
  /** Completion gate: block turn-stopping while edited files still carry errors (default true). */
  gate?: boolean
  /** Max forced continuations per turn before the gate admits the turn (min 0). */
  gateMaxSteers?: number
  /** Severity the completion gate enforces (default 'error'). */
  gateSeverity?: Severity
  /** Attach a source code frame to rendered findings (default true). */
  codeFrames?: boolean
  /** Lines of context above/below a framed finding (min 0). */
  frameLines?: number
  /** Max findings that get a code frame (token guard, min 0). */
  frameLimit?: number
}

interface EffectiveConfig {
  mode: 'fast' | 'balanced' | 'strict'
  completionChecks: boolean
  qualityTimeoutMs: number
  qualityMaxFiles: number
  qualityMaxChecks: number
  autoInject: boolean
  maxFindings: number
  linters: LinterKey[]
  linterPath: Record<string, string>
  sectionTtlMs: number
  timeoutMs: number
  sectionSeverity: Severity
  settleMs: number
  gate: boolean
  gateMaxSteers: number
  gateSeverity: Severity
  codeFrames: boolean
  frameLines: number
  frameLimit: number
}

const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info']

function asSeverity(value: Severity | undefined, fallback: Severity): Severity {
  return value !== undefined && (SEVERITIES as readonly string[]).includes(value) ? value : fallback
}

const DEFAULTS: EffectiveConfig = {
  mode: 'balanced',
  completionChecks: true,
  qualityTimeoutMs: 60_000,
  qualityMaxFiles: 2_000,
  qualityMaxChecks: 32,
  autoInject: true,
  maxFindings: 50,
  linters: [],
  linterPath: {},
  sectionTtlMs: 30_000,
  timeoutMs: 10_000,
  sectionSeverity: 'error',
  settleMs: 600,
  gate: true,
  gateMaxSteers: 2,
  gateSeverity: 'error',
  codeFrames: true,
  frameLines: 1,
  frameLimit: 5,
}

const state: { current: EffectiveConfig } = { current: { ...DEFAULTS } }

function coerceInt(value: number | undefined, fallback: number, min: number): number {
  return value !== undefined && Number.isFinite(value) && value >= min ? Math.trunc(value) : fallback
}

/** Merge a plugin-provided partial config over the defaults (idempotent). */
export function applyConfig(partial?: PluginConfig): void {
  const mode = ['fast', 'balanced', 'strict'].includes(partial?.mode ?? '') ? partial!.mode! : 'balanced'
  const preset = { ...DEFAULTS, mode, completionChecks: mode !== 'fast', qualityTimeoutMs: mode === 'strict' ? 120_000 : 60_000 }
  const forced = partial?.linters
  state.current = {
    ...preset,
    ...(partial ?? {}),
    linters:
      forced && forced.length > 0
        ? [...forced].filter((key): key is LinterKey => (LINTER_KEYS as readonly string[]).includes(key))
        : [],
    linterPath: { ...partial?.linterPath },
  }
  state.current.mode = mode
  state.current.completionChecks = partial?.completionChecks ?? preset.completionChecks
  state.current.qualityTimeoutMs = coerceInt(partial?.qualityTimeoutMs, preset.qualityTimeoutMs, 1_000)
  state.current.qualityMaxFiles = coerceInt(partial?.qualityMaxFiles, preset.qualityMaxFiles, 1)
  state.current.qualityMaxChecks = coerceInt(partial?.qualityMaxChecks, preset.qualityMaxChecks, 1)
  if (forced && forced.length > 0 && state.current.linters.length !== forced.length) {
    console.warn(
      `[dsh-lint-loop] ignoring unknown linter keys in config (valid: ${LINTER_KEYS.join(', ')})`,
    )
  }
  state.current.maxFindings = coerceInt(partial?.maxFindings, DEFAULTS.maxFindings, 1)
  state.current.sectionTtlMs = coerceInt(partial?.sectionTtlMs, DEFAULTS.sectionTtlMs, 1_000)
  state.current.timeoutMs = coerceInt(partial?.timeoutMs, DEFAULTS.timeoutMs, 1_000)
  state.current.settleMs = coerceInt(partial?.settleMs, DEFAULTS.settleMs, 100)
  state.current.gateMaxSteers = coerceInt(partial?.gateMaxSteers, DEFAULTS.gateMaxSteers, 0)
  state.current.frameLines = coerceInt(partial?.frameLines, DEFAULTS.frameLines, 0)
  state.current.frameLimit = coerceInt(partial?.frameLimit, DEFAULTS.frameLimit, 0)
  state.current.autoInject = partial?.autoInject ?? DEFAULTS.autoInject
  state.current.gate = partial?.gate ?? DEFAULTS.gate
  state.current.codeFrames = partial?.codeFrames ?? DEFAULTS.codeFrames
  state.current.sectionSeverity = asSeverity(partial?.sectionSeverity, DEFAULTS.sectionSeverity)
  state.current.gateSeverity = asSeverity(partial?.gateSeverity, DEFAULTS.gateSeverity)
}

export function getConfig(): Readonly<EffectiveConfig> {
  return state.current
}
