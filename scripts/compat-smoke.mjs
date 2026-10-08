import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const entry = process.argv[2] ?? 'dist/index.js'
const plugin = await import(pathToFileURL(path.resolve(entry)).href)
const names = ['quality_verify', 'quality_receipt', 'lint_status', 'lint_repair', 'lint_diagnostics', 'lint_workspace_errors', 'lint_fix']
assert.deepEqual(plugin.tools.map((t) => t.name), names)
for (let mount = 0; mount < 2; mount++) {
  const registered = [], listeners = []
  let dispose, toolsDisposed = 0, listenersDisposed = 0, sectionsDisposed = 0
  plugin.apply({
    effect(fn) { dispose = fn() },
    tools: { register(tool) { registered.push(tool.name); return () => toolsDisposed++ } },
    systemPrompt: { section() { return () => sectionsDisposed++ } },
    on(name) { listeners.push(name); return () => listenersDisposed++ },
  })
  assert.deepEqual(registered, names)
  assert.equal(listeners.length, 6)
  assert.match(plugin.tools[0].presentCall({}).title, /running/)
  dispose()
  assert.equal(toolsDisposed, 7)
  assert.equal(listenersDisposed, 6)
  assert.equal(sectionsDisposed, 1)
}
console.log(`Compatibility smoke passed: ${entry}; seven tools; native presenter; dispose/remount; ${process.version}`)
