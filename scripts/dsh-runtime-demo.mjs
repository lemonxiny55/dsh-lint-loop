// Reproducible actual DSH AgentLoop + fs tools + ESLint/TS/Vitest demo.
// Model input is deterministic; no verification results or lifecycle events are fabricated.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export async function runDemo(ctx, { runtime, dependencies, output, bundle, mount = true, evidenceRequired = true }) {
  const load = (name) => import(pathToFileURL(path.join(runtime, 'node_modules', '@deepseek-ai', name, 'lib/index.js')).href)
  const llm = await load('dsh-llm')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-evidence-demo-')))
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'tests'))
  await symlink(path.join(dependencies, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const files = {
    'package.json': '{"type":"module","scripts":{"test":"vitest run"}}',
    'tsconfig.json': '{"compilerOptions":{"allowJs":true,"checkJs":true,"noEmit":true,"target":"ES2023","module":"ESNext","skipLibCheck":true},"include":["src"]}',
    'eslint.config.mjs': 'export default [{files:["**/*.js"],rules:{"no-unused-vars":"error",semi:["error","always"]}}];',
    'vitest.config.mjs': 'export default {test:{globals:true}};',
    'src/a.js': '/** @type {number} */\nexport const a = 1;\nconst old = 1;\n',
    'src/legacy.js': '/** @type {number} */\nexport const oldType = "historical";\n',
    'tests/a.test.js': 'import {a} from "../src/a.js"; test("a",()=>expect(a).toBe(1)); test("historical",()=>expect(1).toBe(0));',
    'tests/b.test.js': 'test("unrelated",()=>expect(1).toBe(1));',
    'dirty.txt': 'pre-existing uncommitted bytes\n',
  }
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, file), text)
  if (!evidenceRequired) execFileSync('git', ['init', '--quiet', root], { windowsHide: true })
  await mkdir(output, { recursive: true })
  if (mount) {
    for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent']) await ctx.plugin((await load(name)).default)
    await ctx.plugin((await load('dsh-fs-local')).default, { cwd: root })
    await ctx.plugin((await load('dsh-working-directory')).default, { defaultDirectory: root })
    await ctx.plugin((await load('dsh-tool-fs')), { readImage: false })
    await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] })
    await ctx.plugin(await import(pathToFileURL(bundle).href), { autoInject: false, gate: true, qualityTimeoutMs: 30000 })
  }
  let sequence = 0
  const call = (name, args) => {
    const id = `evidence-${++sequence}`, json = JSON.stringify(args)
    return [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
  }
  const text = (value) => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const script = [
    call('read', { file_path: 'src/a.js' }),
    call('edit', { file_path: 'src/a.js', old_string: 'export const a = 1;', new_string: 'export const a = "new"' }),
    call('quality_verify', {}), call('lint_repair', { scope: 'turn' }), call('quality_verify', {}),
    call('read', { file_path: 'src/a.js' }), // real fs-observation policy requires a fresh read after fixer writes
    call('edit', { file_path: 'src/a.js', old_string: 'export const a = "new";', new_string: 'export const a = 1;' }),
    call('quality_verify', {}), call('quality_receipt', {}), text('Evidence demo completed.'),
  ]
  class ScriptedInput extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      options.signal?.throwIfAborted()
      const chunks = script.shift()
      assert(chunks, 'script exhausted: real lifecycle diverged')
      yield* chunks
    }
  }
  const provider = `evidence-demo-${crypto.randomUUID()}`
  const registration = ctx.llm.registerAdapter([provider], new ScriptedInput())
  const presets = !mount ? ctx.get('agentPresets') : undefined
  const handle = await ctx.agents.create({ sessionId: `evidence-${crypto.randomUUID()}`, meta: { cwd: root }, agentOptions: { provider, model: 'deterministic-input' },
    ...(presets ? { setup: async (agentCtx) => { await presets.mount(agentCtx, 'standard') } } : {}),
  })
  const { agent } = handle
  const receipts = [], outcomes = []
  const offResult = ctx.on('tools/result', (exec, result) => {
    if (exec.agent !== agent) return
    outcomes.push({ tool: exec.name, isError: result.isError, ...(result.isError ? { error: result.error } : {}) })
    if (exec.name === 'quality_verify' || exec.name === 'quality_receipt') receipts.push(structuredClone(result.value))
  })
  const end = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('real DSH demo timed out')), 120000)
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end') { clearTimeout(timer); resolve(event) }
    })
  })
  try {
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Run the deterministic evidence demo using real tools and checks.' }], source: { kind: 'user' } }))
    const completion = await end
    await writeFile(path.join(output, 'results.json'), JSON.stringify({ runtime: 'DSH 0.2.1-rc.2', node: process.version, modelInput: 'deterministic scripted adapter; actual AgentLoop and tools', root, outcomes, receipts, completion,
      events: agent.session.snapshotEvents().filter((event) => /^(?:tool\/|turn\/)/.test(event.type)),
    }, null, 2))
    assert(outcomes.every((r) => !r.isError), JSON.stringify(outcomes))
    assert(receipts.length >= 4, JSON.stringify(completion))
    assert.equal(receipts[0].finalVerdict, 'regression')
    assert.equal(receipts[1].lint, 'clean')
    assert.equal(receipts[2].finalVerdict, 'clean')
    if (evidenceRequired) assert.equal(receipts[2].evidenceCoverage.status, 'complete')
    assert.equal(receipts[2].ignoredHistoricalDebt.length, 3)
    assert.equal(await readFile(path.join(root, 'dirty.txt'), 'utf8'), files['dirty.txt'])
    assert.equal(await readFile(path.join(root, 'src/legacy.js'), 'utf8'), files['src/legacy.js'])
    assert.equal(await readFile(path.join(root, 'tests/a.test.js'), 'utf8'), files['tests/a.test.js'])
    console.log(JSON.stringify({ demo: 'passed', output, verdicts: receipts.map((r) => r.finalVerdict), debt: receipts[2].ignoredHistoricalDebt.length }))
    return { root, receipts, outcomes, completion }
  } finally { offResult(); registration(); await handle.dispose() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = path.resolve(process.argv[2] ?? '.cache/dsh021')
  const { Context } = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)
  const ctx = new Context()
  try { await runDemo(ctx, { runtime, dependencies: path.resolve('.cache/demo-v070'), output: path.resolve(process.argv[3] ?? '.cache/runtime-demo'), bundle: path.resolve(process.argv[4] ?? 'dist/index.js'), evidenceRequired: !process.argv.includes('--hotfix') }) }
  finally { await ctx.fiber.dispose() }
}
