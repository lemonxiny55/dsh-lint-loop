// Called inside actual Web/Desktop with their real standard-preset shell tool.
import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
export async function runShellDemo(ctx, { root, output }) {
  const presets = ctx.get('agentPresets'), shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  const cases = []
  for (const outcome of ['success', 'failure', 'cancelled']) {
    const handle = await ctx.agents.create({ sessionId: `evidence-shell-${crypto.randomUUID()}`, meta: { cwd: root }, setup: async agentCtx => { await presets.mount(agentCtx, 'standard') } })
    const agent = handle.agent, controller = new AbortController(), file = `shell-${outcome}.js`
    const command = shell === 'pwsh'
      ? `Set-Content -LiteralPath './${file}' -Value 'export const shellEvidence = 1;'; ${outcome === 'cancelled' ? 'Start-Sleep -Seconds 20' : outcome === 'failure' ? 'exit 7' : 'exit 0'}`
      : `printf 'export const shellEvidence = 1;' > '${file}'; ${outcome === 'cancelled' ? 'sleep 20' : outcome === 'failure' ? 'exit 7' : 'exit 0'}`
    let poll, fallback
    const off = ctx.on('tools/execute', async (exec, next) => {
      if (exec.agent === agent && exec.name === shell && outcome === 'cancelled') {
        // Wait for the actual shell effect before aborting, rather than cancelling the baseline.
        poll = setInterval(() => { access(path.join(root, file)).then(() => controller.abort()).catch(() => {}) }, 50)
        fallback = setTimeout(() => controller.abort(), 15000)
      }
      return next()
    })
    try {
      const result = await ctx.tools.execute({ callId: crypto.randomUUID(), name: shell, arguments: { command, description: `Evidence integrity ${outcome} fixture`, timeoutMs: 30000 }, agent, signal: controller.signal })
      clearInterval(poll); clearTimeout(fallback)
      const receiptResult = await ctx.tools.execute({ callId: crypto.randomUUID(), name: 'quality_verify', arguments: {}, agent, signal: new AbortController().signal })
      const receipt = receiptResult.value
      cases.push({ outcome, shell, isError: result.isError, ...(result.value !== undefined ? { value: result.value } : { error: result.error }), receipt })
      await writeFile(path.join(output, 'shell-results.json'), JSON.stringify({ runtime: 'actual DSH host shell tool', node: process.version, cases }, null, 2))
      assert.equal(receiptResult.isError, false)
      assert.equal(receipt.finalVerdict, 'incomplete')
      assert(receipt.changedFiles.includes(file), JSON.stringify(result))
      assert(receipt.evidenceCoverage.changes.some(c => c.file === file && c.attribution === 'unattributed' && c.outcome === outcome))
      if (outcome === 'failure') assert.equal(result.value?.exitCode, 7, JSON.stringify(result))
      if (outcome === 'cancelled') assert(controller.signal.aborted)
      assert((await readFile(path.join(root, file), 'utf8')).includes('shellEvidence'))
    } finally { clearInterval(poll); clearTimeout(fallback); off(); await handle.dispose() }
  }
  await writeFile(path.join(output, 'shell-completed.json'), JSON.stringify({ passed: true, cases: cases.length, shell }))
  console.log(`[evidence-demo] actual ${shell} success/failure/cancellation passed`)
}
