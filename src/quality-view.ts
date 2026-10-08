/** Native DSH tool-card presenters: pure, replayable and optional on older UIs. */
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
import type { QualityReceipt } from './quality.js'

export function qualityCallView(): ToolCallView {
  return { card: 'generic', kind: 'execute', title: 'Quality · running · lint / typecheck / tests' }
}
export function qualityResultView(_args: unknown, result: { content: unknown[]; isError: boolean }): ToolResultView {
  try {
    const text = result.content.find((block): block is { type: string; text: string } => !!block && typeof block === 'object' && (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')?.text
    const receipt = JSON.parse(text ?? '') as QualityReceipt
    if (receipt.schemaVersion !== 1 || !Array.isArray(receipt.changedFiles)) throw new Error('not a receipt')
    const state = receipt.finalVerdict === 'clean' ? 'clean' : receipt.finalVerdict === 'regression' ? 'regression' : 'failed'
    return { card: 'generic', title: `Quality · ${state} · ${receipt.changedFiles.length} changed · lint ${receipt.lint} / types ${receipt.typecheck} / tests ${receipt.tests}`,
      content: [{ type: 'text', text: `Changed files: ${receipt.changedFiles.join(', ') || '(none)'}\n\nQuality Receipt\n\n${JSON.stringify(receipt, null, 2)}` }] }
  } catch { return { card: 'generic', title: result.isError ? 'Quality · failed' : 'Quality · receipt unavailable' } }
}
