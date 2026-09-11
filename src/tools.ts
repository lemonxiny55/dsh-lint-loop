/** Model-visible tools: lint_diagnostics, lint_workspace_errors, lint_fix. */

import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { getConfig } from './config.js'
import { capFindings, filterFindings, renderFindings, sortFindings, type Finding, type Severity } from './findings.js'
import { frameFor } from './frames.js'
import { LintManager, managerForRoot, type FixResult } from './manager.js'
import { findRepoRoot, resolveFileInRoot } from './workspace.js'

/** Minimal structural types for the harness surfaces we touch. */
interface ToolCwdContext {
  agent?: {
    session?: { header?: { cwd?: string } }
  }
}
type ToolRunExec = ToolCwdContext & { signal?: AbortSignal }

interface TextBlock {
  type: 'text'
  text: string
}

/** Canonical output element: a finding, a truncation note, or an error. */
type FindingValue = Finding | { note: string } | { error: string }

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFindingValue(value: JsonValue): boolean {
  return (
    isRecord(value)
    && typeof value.file === 'string'
    && typeof value.line === 'number'
    && typeof value.col === 'number'
    && typeof value.rule === 'string'
    && typeof value.message === 'string'
    && (value.severity === 'error' || value.severity === 'warning' || value.severity === 'info')
  )
}

/** A per-render resolver that frames at most `frameLimit` findings. */
function frameResolver(): ((finding: Finding) => string | undefined) | undefined {
  const config = getConfig()
  if (!config.codeFrames || config.frameLimit <= 0) return undefined
  let used = 0
  return (finding) => {
    if (used >= config.frameLimit) return undefined
    used++
    return frameFor(finding.file, finding.line, config.frameLines)
  }
}

/** Render canonical output into the compact findings table (one text block). */
function renderFindingValue(value: JsonValue[]): TextBlock[] {
  const only = value.length === 1 ? value[0] : undefined
  if (only && isRecord(only) && typeof only.error === 'string') {
    return [{ type: 'text', text: `lint: ${only.error}` }]
  }
  const notes = value.filter(
    (element): element is { note: string } => isRecord(element) && typeof element.note === 'string',
  )
  const findings = value.filter(isFindingValue) as unknown as Finding[]
  const dropped = notes.reduce((sum, note) => {
    const match = /^\+(\d+) more/.exec(note.note)
    return sum + (match ? Number(match[1]) : 0)
  }, 0)
  return [{ type: 'text', text: renderFindings(findings, dropped, frameResolver()) }]
}

/** Canonical array + a truncation note when the cap bit. */
function toCanonical(findings: readonly Finding[], dropped: number): JsonValue[] {
  const value: JsonValue[] = findings.map((finding) => finding as unknown as JsonValue)
  if (dropped > 0) {
    value.push({ note: `+${dropped} more suppressed — raise the max parameter or maxFindings config` })
  }
  return value
}

function friendlyMessage(error: unknown): string {
  return (error as Error).message ?? String(error)
}

/** Resolve the workspace root for a tool call (explicit arg → session cwd → process cwd). */
async function resolveRoot(arg: string | undefined, exec: ToolRunExec): Promise<string> {
  const cwd = exec.agent?.session?.header?.cwd
  const base = arg ?? cwd ?? process.cwd()
  const root = await findRepoRoot(base)
  if (!root) throw new Error(`no git repository found from ${path.resolve(base)}`)
  return root
}

async function resolveFile(root: string, file: string): Promise<string> {
  const abs = resolveFileInRoot(root, file)
  if (!abs) throw new Error(`"${file}" is outside the workspace root ${root}`)
  return abs
}

function resolveMax(max: number | undefined): number {
  const configured = max ?? getConfig().maxFindings
  return Number.isFinite(configured) && configured >= 1 ? Math.trunc(configured) : getConfig().maxFindings
}

function countDropped(elements: readonly JsonValue[]): number {
  return elements.filter(isRecord).reduce((sum, element) => {
    const match = /^\+(\d+) more/.exec(typeof element.note === 'string' ? element.note : '')
    return sum + (match ? Number(match[1]) : 0)
  }, 0)
}

function renderFixResult(value: Record<string, JsonValue>): TextBlock[] {
  const remaining: JsonValue[] = Array.isArray(value.remaining) ? value.remaining : []
  const findings = remaining.filter(isFindingValue) as unknown as Finding[]
  const dropped = countDropped(remaining)
  const fixed = value.fixed === true
  const changed = isRecord(value.changedLines) ? value.changedLines : {}
  const added = typeof changed.added === 'number' ? changed.added : 0
  const removed = typeof changed.removed === 'number' ? changed.removed : 0
  const status = fixed ? `+${added}/-${removed} lines` : 'no changes applied'
  const errors = findings.filter((f) => f.severity === 'error').length
  const warnings = findings.filter((f) => f.severity === 'warning').length
  const header = [
    `# lint_fix (${String(value.linter)}) — ${String(value.file)}`,
    `fixed: ${fixed ? 'yes' : 'no'} (${status})`,
  ]
  if (findings.length === 0 && dropped === 0) {
    header.push('remaining: none — file is clean')
  } else {
    header.push(`remaining: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`)
  }
  return [{ type: 'text', text: [...header, renderFindings(findings, dropped, frameResolver())].join('\n') }]
}

function fixResultToCanonical(result: FixResult): Record<string, JsonValue> {
  const remaining: JsonValue[] = result.remaining.map((finding) => finding as unknown as JsonValue)
  if (result.dropped > 0) {
    remaining.push({ note: `+${result.dropped} more suppressed — raise the max parameter or maxFindings config` })
  }
  return {
    linter: result.linter,
    file: result.file,
    fixed: result.fixed,
    changedLines: { added: result.addedLines, removed: result.removedLines },
    remaining,
  }
}

export const tools = [
  defineTool({
    name: 'lint_diagnostics',
    description:
      'Lint findings (rule, file:line:col, message, fixable) for one file — or every file the linters have seen. '
      + 'Uses the repo\'s own eslint / biome / ruff config, zero setup. Call right after editing a file.',
    parameters: {
      file: {
        type: 'string',
        description:
          'File to lint (absolute or workspace-relative). Omit to list findings for all files seen this session.',
      },
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info'],
        description: 'Only return findings of this severity.',
      },
      max: {
        type: 'number',
        description: 'Max findings to return (default from maxFindings config, 50).',
      },
      repoRoot: {
        type: 'string',
        description: 'Optional absolute repo path; defaults to the session workspace root.',
      },
    },
    output: {
      schema: { type: 'array' },
      render: (_args, value: JsonValue[]): TextBlock[] => renderFindingValue(value),
    },
    async execute(
      args: { file?: string; severity?: Severity; max?: number; repoRoot?: string },
      exec: ToolRunExec,
    ): Promise<JsonValue[]> {
      try {
        const root = await resolveRoot(args.repoRoot, exec)
        const manager = managerForRoot(root)
        const max = resolveMax(args.max)
        let findings: Finding[]
        if (args.file) {
          const abs = await resolveFile(root, args.file)
          findings = sortFindings(filterFindings(await manager.lintFile(abs), args.severity))
        } else {
          findings = sortFindings(filterFindings(manager.allFindings(), args.severity))
        }
        const capped = capFindings(findings, max)
        return toCanonical(capped.result, capped.dropped)
      } catch (error) {
        return [{ error: friendlyMessage(error) }]
      }
    },
  }),

  defineTool({
    name: 'lint_workspace_errors',
    description:
      'All lint errors across the workspace — the "what is broken right now" view. '
      + 'Covers files linted during this session (a file joins the set the first time lint_diagnostics checks it).',
    parameters: {
      max: {
        type: 'number',
        description: 'Max errors to return (default from maxFindings config, 50).',
      },
      repoRoot: {
        type: 'string',
        description: 'Optional absolute repo path; defaults to the session workspace root.',
      },
    },
    output: {
      schema: { type: 'array' },
      render: (_args, value: JsonValue[]): TextBlock[] => renderFindingValue(value),
    },
    async execute(args: { max?: number; repoRoot?: string }, exec: ToolRunExec): Promise<JsonValue[]> {
      try {
        const root = await resolveRoot(args.repoRoot, exec)
        const manager = managerForRoot(root)
        const max = resolveMax(args.max)
        const errors = manager.allFindings().filter((finding) => finding.severity === 'error')
        const capped = capFindings(sortFindings(errors), max)
        return toCanonical(capped.result, capped.dropped)
      } catch (error) {
        return [{ error: friendlyMessage(error) }]
      }
    },
  }),

  defineTool({
    name: 'lint_fix',
    description:
      'Auto-fix lint problems in ONE file with the repo\'s own linter (eslint --fix / biome check --write / ruff check --fix). '
      + 'Returns what changed, remaining findings, and a line-change summary. Only works inside the workspace root.',
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: 'File to fix (absolute or workspace-relative).',
      },
      max: {
        type: 'number',
        description: 'Max remaining findings to return (default from maxFindings config, 50).',
      },
      repoRoot: {
        type: 'string',
        description: 'Optional absolute repo path; defaults to the session workspace root.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value: Record<string, JsonValue>): TextBlock[] => {
        if (typeof value.error === 'string') {
          return [{ type: 'text', text: `lint_fix: ${value.error}` }]
        }
        return renderFixResult(value)
      },
    },
    async execute(
      args: { file: string; max?: number; repoRoot?: string },
      exec: ToolRunExec,
    ): Promise<Record<string, JsonValue>> {
      try {
        const root = await resolveRoot(args.repoRoot, exec)
        const abs = await resolveFile(root, args.file)
        const manager: LintManager = managerForRoot(root)
        const result = await manager.fixFile(abs)
        const capped = capFindings(result.remaining, resolveMax(args.max))
        return fixResultToCanonical({ ...result, remaining: capped.result, dropped: capped.dropped })
      } catch (error) {
        return { error: friendlyMessage(error) }
      }
    },
  }),
]
