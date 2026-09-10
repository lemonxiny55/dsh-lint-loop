/**
 * dsh-lint-loop — DeepSeek Harness bundle entry.
 *
 * Registers model-visible lint tools (lint_diagnostics / lint_workspace_errors
 * / lint_fix) backed by auto-detected linters (eslint / biome / ruff), and —
 * when autoInject is on — subscribes to the harness `fs/observed` event to
 * inject a compact "what your last edit broke" delta into the system prompt.
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
  on?(
    name: string,
    listener: (
      target: { displayPath?: string } | undefined,
      info: { kind?: string } | undefined,
      exec: unknown,
    ) => void,
  ): unknown
}

export const name = 'dsh-lint-loop'

// Public API surface (consumable by other bundles / tests).
export { tools } from './tools.js'
export { LintManager, disposeAllManagers, managerForRoot } from './manager.js'
export {
  LINTER_KEYS,
  linterFamilyForExt,
  resolveCommand,
  LINTER_SPECS,
  type LinterKey,
} from './linters.js'
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
export { parseEslintJson, parseBiomeJson, parseRuffJson } from './parse.js'
export { applyConfig, getConfig, type PluginConfig } from './config.js'
export { findRepoRoot } from './workspace.js'
export { createLintSection } from './section.js'

import { applyConfig, getConfig, type PluginConfig } from './config.js'
import { invalidateProbes, isLinterConfigBasename } from './detect.js'
import { disposeAllManagers } from './manager.js'
import { createLintSection } from './section.js'
import { tools } from './tools.js'

export const inject = ['tools', 'systemPrompt'] as const

export function apply(ctx: MinimalContext, pluginConfig?: PluginConfig) {
  applyConfig(pluginConfig)
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    console.log('[dsh-lint-loop] plugin loaded')
    for (const tool of tools) {
      disposers.push(ctx.tools.register(tool))
      console.log(`[dsh-lint-loop] registered tool: ${tool.name}`)
    }

    if (getConfig().autoInject) {
      const section = createLintSection()
      disposers.push(section.dispose)
      disposers.push(
        ctx.systemPrompt.section({
          name: 'lint:findings',
          order: 75, // right after lsp:diagnostics (70), before tool guidance (100–199)
          text: () => section.text(),
        }),
      )
      if (typeof ctx.on === 'function') {
        // fs/observed fires after read/read_image/write/edit commit — reads
        // of unchanged files produce an empty delta, so subscribing to all
        // of them is harmless and keeps the section's semantics simple.
        const off = ctx.on('fs/observed', (target, info) => {
          if (info?.kind !== 'present') return
          const displayPath = target?.displayPath
          // A linter config file just changed → the probe cache is stale.
          // Sync + infallible, same contract as the section listener.
          if (displayPath && isLinterConfigBasename(basenameOf(displayPath))) invalidateProbes()
          section.handleObserved(displayPath)
        }) as (() => void) | undefined
        if (off) disposers.push(off)
      } else {
        console.log(
          '[dsh-lint-loop] ctx.on unavailable — edit-triggered injection disabled (tools still work)',
        )
      }
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
      console.log('[dsh-lint-loop] plugin unloaded')
      if (errors.length > 0) throw new AggregateError(errors, 'failed to unload dsh-lint-loop')
    }
  })
}

function basenameOf(displayPath: string): string {
  const index = Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\'))
  return index === -1 ? displayPath : displayPath.slice(index + 1)
}
