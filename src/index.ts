/**
 * dsh-lint-loop — DeepSeek Harness bundle entry.
 *
 * Registers model-visible lint tools (lint_diagnostics / lint_workspace_errors
 * / lint_fix) backed by auto-detected linters (eslint / biome / ruff /
 * golangci-lint / cargo clippy), injects
 * a compact "what your last edit broke" delta into the system prompt, and —
 * when the completion gate is on — steers the agent for another step while
 * files it just edited still carry lint errors.
 */

type Disposer = void | (() => void)

/** Minimal structural Context; the real @deepseek-ai/cordis type is a
 *  runtime dependency we intentionally do not import in the bundle entry. */
interface MinimalContext {
  effect(fn: () => Disposer): void
  tools: { register(t: unknown): () => void }
  systemPrompt: {
    section(section: {
      name: string
      order: number
      text: string | ((context: unknown) => string)
    }): () => void
  }
  /** Cordis core event service — present on every live harness context. */
  on?(name: string, listener: (...args: unknown[]) => unknown): unknown
}

export const name = 'dsh-lint-loop'

// Public API surface (consumable by other bundles / tests).
export { applyConfig, getConfig, type PluginConfig } from './config.js'
export {
  chooseLinter,
  detectLinters,
  invalidateProbes,
  isLinterConfigBasename,
  probeLinters,
  usableLinters,
  type DetectedLinters,
} from './detect.js'
export {
  capFindings,
  findingKey,
  filterFindings,
  renderFindings,
  sortFindings,
  type Finding,
  type Severity,
} from './findings.js'
export { clearFrameCache, frameFor, recordFileLines } from './frames.js'
export { handleTurnStopping, markDirty, steeringCountFor, clearGateState, type TurnStoppingPayload } from './gate.js'
export {
  LINTER_KEYS,
  linterFamilyForExt,
  resolveCommand,
  LINTER_SPECS,
  type LinterKey,
  type LinterScope,
} from './linters.js'
export { LintManager, disposeAllManagers, managerForRoot } from './manager.js'
export { parseEslintJson, parseBiomeJson, parseRuffJson, parseGolangciJson, parseCargoClippyJson } from './parse.js'
export { createLintSection } from './section.js'
export { tools } from './tools.js'
export { findRepoRoot } from './workspace.js'

import { applyConfig, getConfig, type PluginConfig } from './config.js'
import { invalidateProbes, isLinterConfigBasename } from './detect.js'
import { clearFrameCache } from './frames.js'
import { clearGateState, handleTurnStopping, markDirty, type TurnStoppingPayload } from './gate.js'
import { disposeAllManagers } from './manager.js'
import { createLintSection } from './section.js'
import { tools } from './tools.js'

export const inject = ['tools', 'systemPrompt'] as const

export function apply(ctx: MinimalContext, pluginConfig?: PluginConfig) {
  applyConfig(pluginConfig)
  ctx.effect(() => {
    const config = getConfig()
    // The gate needs the fs/observed listener, which autoInject:false turns
    // off. Keep the 0.1 behavior (autoInject:false = tools only) unless the
    // user asks for the gate explicitly.
    const gateEnabled = config.gate && (config.autoInject || pluginConfig?.gate === true)
    const disposers: Array<() => void> = []
    console.log('[dsh-lint-loop] plugin loaded')
    for (const tool of tools) {
      disposers.push(ctx.tools.register(tool))
      console.log(`[dsh-lint-loop] registered tool: ${tool.name}`)
    }

    const section = config.autoInject ? createLintSection() : null
    if (section) {
      disposers.push(section.dispose)
      disposers.push(
        ctx.systemPrompt.section({
          name: 'lint:findings',
          order: 75, // right after lsp:diagnostics (70), before tool guidance (100–199)
          text: () => section.text(),
        }),
      )
    }

    const listenerNeeded = section !== null || gateEnabled
    if (listenerNeeded && typeof ctx.on === 'function') {
      // fs/observed fires after read/read_image/write/edit commit — reads of
      // unchanged files produce an empty delta, so subscribing to all of them
      // is harmless and keeps the section's semantics simple.
      const off = ctx.on('fs/observed', (...args: unknown[]) => {
        const target = args[0] as { displayPath?: string } | undefined
        const info = args[1] as { kind?: string } | undefined
        if (info?.kind !== 'present') return
        const displayPath = target?.displayPath
        if (process.env.DSH_LINT_DEBUG === '1') console.log('[dsh-lint-loop][debug] fs/observed', info?.kind, displayPath)
        // A linter config file just changed → the probe cache is stale.
        if (displayPath && isLinterConfigBasename(basenameOf(displayPath))) invalidateProbes()
        section?.handleObserved(displayPath)
        markDirty(displayPath)
      }) as (() => void) | undefined
      if (off) disposers.push(off)

      if (gateEnabled) {
        const offTurn = ctx.on('agent/turn-stopping', (...args: unknown[]) => {
          const payload = args[0] as TurnStoppingPayload | undefined
          // The seam is an awaited serial checkpoint: return the promise so the
          // harness waits for the lint + steer before it commits the boundary.
          // A fire-and-forget call races the turn close and the steer is lost.
          if (payload?.agent) return handleTurnStopping(payload).then(() => undefined)
        }) as (() => void) | undefined
        if (offTurn) {
          disposers.push(offTurn)
          console.log('[dsh-lint-loop] completion gate armed (agent/turn-stopping)')
        } else {
          console.log(
            '[dsh-lint-loop] agent/turn-stopping unavailable — completion gate disabled (tools and section still work)',
          )
        }
      }
    } else if (gateEnabled) {
      console.log(
        '[dsh-lint-loop] ctx.on unavailable — completion gate and edit-triggered injection disabled (tools still work)',
      )
    }

    return () => {
      const errors: unknown[] = []
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      clearGateState()
      clearFrameCache()
      void disposeAllManagers().catch((error) => {
        console.log(`[dsh-lint-loop] store cleanup error: ${(error as Error).message}`)
      })
      console.log('[dsh-lint-loop] plugin unloaded')
      if (errors.length > 0) throw new AggregateError(errors, 'failed to unload dsh-lint-loop')
    }
  })
}

function basenameOf(displayPath: string): string {
  const index = Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\'))
  return index === -1 ? displayPath : displayPath.slice(index + 1)
}
