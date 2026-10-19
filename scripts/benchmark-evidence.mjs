// Protocol benchmark: actual file-tool wrapper + linter subprocess, deterministic fixtures.
// completionChecks=false isolates pre-edit tracking; full check costs are in demo receipts.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const entries = process.argv.slice(2)
const log = console.log
console.log = () => {}
if (!entries.length) throw new Error('Pass baseline and candidate built bundle paths')
const results = []
for (const entry of entries) for (const count of [100, 1000]) {
  const plugin = await import(pathToFileURL(path.resolve(entry)).href + `?files=${count}`)
  const samples = []
  for (let sample = 0; sample < 6; sample++) {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-bench-'))
    await mkdir(path.join(root, '.git')); await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'eslint.config.mjs'), 'export default []')
    for (let index = 0; index < count; index++) await writeFile(path.join(root, 'src', `${index}.ts`), `export const x${index} = ${index}\n`)
    let execute, dispose
    plugin.apply({ effect(fn) { dispose = fn() }, tools: { register() { return () => {} } }, systemPrompt: { section() { return () => {} } },
      on(name, fn) { if (name === 'tools/execute') execute = fn; return () => {} },
    }, { autoInject: false, completionChecks: false, trackingTimeoutMs: 10000, linterPath: { eslint: path.resolve('tests/helpers/fakeLinter.mjs') } })
    const actor = { name: 'edit', arguments: { file_path: 'src/0.ts' }, agent: { session: { id: root, header: { cwd: root } } } }
    const timings = []
    for (let edit = 0; edit < 3; edit++) {
      const before = `export const x0 = ${edit}\n`, after = `export const x0 = ${edit + 1}\n`
      const started = performance.now()
      await execute(actor, async () => { await writeFile(path.join(root, 'src/0.ts'), after); return { isError: false, value: { path: path.join(root, 'src/0.ts'), before, after }, content: [] } })
      timings.push(performance.now() - started)
    }
    dispose(); await plugin.disposeAllManagers()
    if (sample) samples.push({ firstEditMs: timings[0], repeatEditMs: (timings[1] + timings[2]) / 2 })
  }
  const median = (key) => samples.map((s) => s[key]).sort((a, b) => a - b)[2]
  results.push({ entry, files: count, firstEditMedianMs: median('firstEditMs'), repeatEditMedianMs: median('repeatEditMs'), samples })
}
log(JSON.stringify({ node: process.version, platform: process.platform, protocol: 'one warmup + five samples; three edits; actual protocol linter, completionChecks=false', results }, null, 2))
