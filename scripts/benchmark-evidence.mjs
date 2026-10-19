// Protocol benchmark: actual file-tool wrapper + linter subprocess, deterministic fixtures.
// completionChecks=false isolates pre-edit tracking; full check costs are in demo receipts.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const entries = process.argv.slice(2)
const log = console.log
console.log = () => {}
const measuredCount = Number(process.env.DSH_BENCH_SAMPLES ?? 20)
const scenarios = (process.env.DSH_BENCH_SCENARIOS ?? 'continuous,shell-batch-lifecycle').split(',')
if (entries.length !== 2) throw new Error('Pass baseline and candidate built bundle paths in that order')
if (!Number.isInteger(measuredCount) || measuredCount < 1) throw new Error('DSH_BENCH_SAMPLES must be a positive integer')
const results = []
await mkdir(path.resolve('.cache', 'benchmark-fixtures'), { recursive: true })
const normalize = (value, root) => Array.isArray(value) ? value.map((item) => normalize(item, root))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['elapsedMs', 'verifiedAt'].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item, root)]))
    : typeof value === 'string' ? value.split(root).join('<ROOT>') : value
for (const entry of entries) for (const count of [100, 1000]) for (const scenario of scenarios) {
  const plugin = await import(pathToFileURL(path.resolve(entry)).href + `?files=${count}`)
  const samples = []
  const receiptSemantics = []
  for (let sample = 0; sample <= measuredCount; sample++) {
    const root = await mkdtemp(path.resolve('.cache', 'benchmark-fixtures', 'dsh-evidence-bench-'))
    let dispose
    try {
    await mkdir(path.join(root, '.git')); await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'eslint.config.mjs'), 'export default []')
    for (let index = 0; index < count; index++) await writeFile(path.join(root, 'src', `${index}.ts`), `export const x${index} = ${index}\n`)
    let execute
    const registered = []
    plugin.apply({ effect(fn) { dispose = fn() }, tools: { register(tool) { registered.push(tool); return () => {} } }, systemPrompt: { section() { return () => {} } },
      on(name, fn) { if (name === 'tools/execute') execute = fn; return () => {} },
    }, { autoInject: false, completionChecks: false, trackingTimeoutMs: 10000, linterPath: { eslint: path.resolve('tests/helpers/fakeLinter.mjs') } })
    const actor = scenario === 'continuous'
      ? { name: 'edit', arguments: { file_path: 'src/0.ts' }, agent: { session: { id: root, header: { cwd: root } } } }
      : { name: 'exec', arguments: { command: 'deterministic fixture batch' }, agent: { session: { id: root, header: { cwd: root } } } }
    const timings = []
    global.gc?.()
    const memoryStart = process.memoryUsage()
    let peakHeapDelta = 0, peakRssDelta = 0
    const sampleMemory = () => { const now = process.memoryUsage(); peakHeapDelta = Math.max(peakHeapDelta, now.heapUsed - memoryStart.heapUsed); peakRssDelta = Math.max(peakRssDelta, now.rss - memoryStart.rss) }
    const monitor = setInterval(sampleMemory, 5); monitor.unref()
    if (scenario === 'continuous') {
      for (let edit = 0; edit < 3; edit++) {
        const before = `export const x0 = ${edit}\n`, after = `export const x0 = ${edit + 1}\n`
        const started = performance.now()
        await execute(actor, async () => { await writeFile(path.join(root, 'src/0.ts'), after); return { isError: false, value: { path: path.join(root, 'src/0.ts'), before, after }, content: [] } })
        timings.push(performance.now() - started)
      }
    } else if (scenario === 'shell-batch-lifecycle') {
      const started = performance.now()
      await execute(actor, async () => {
        for (let index = 1; index <= 10; index++) await writeFile(path.join(root, 'src', `${index}.ts`), `export const x${index} = ${index + 1}\n`)
        await mkdir(path.join(root, 'renamed'))
        await writeFile(path.join(root, 'src', 'added.ts'), 'export const added = true\n')
        await rm(path.join(root, 'src', `${count - 1}.ts`))
        await rename(path.join(root, 'src', `${count - 2}.ts`), path.join(root, 'renamed', 'renamed.ts'))
        return { isError: false, value: { exitCode: 0, signal: null, aborted: false, timedOut: false }, content: [] }
      })
      timings.push(performance.now() - started, timings[0] ?? 0)
      timings[1] = timings[0]
    } else {
      throw new Error(`unknown benchmark scenario: ${scenario}`)
    }
    clearInterval(monitor); sampleMemory()
    const verify = registered.find((tool) => tool.name === 'quality_verify')
    const receipt = await verify.execute({ repoRoot: root }, actor)
    const coverage = receipt.evidenceCoverage
    const validContinuous = scenario === 'continuous' && coverage?.status === 'complete' && coverage.checkpoints >= 6
      && coverage.changes.some((change) => change.file === 'src/0.ts' && change.operation === 'modified' && change.attribution === 'tool-target')
    const observedPaths = new Set(coverage?.changes.map((change) => `${change.file}:${change.operation}:${change.attribution}`) ?? [])
    const validBatch = scenario === 'shell-batch-lifecycle' && coverage?.status === 'incomplete'
      && coverage.reasons.some((reason) => reason.includes('no confined filesystem mutation contract'))
      && [
        ...Array.from({ length: 10 }, (_, index) => `src/${index + 1}.ts:modified:unattributed`),
        'src/added.ts:added:unattributed', `src/${count - 1}.ts:deleted:unattributed`, `src/${count - 2}.ts:deleted:unattributed`,
        'renamed/renamed.ts:added:unattributed',
      ].every((path) => observedPaths.has(path))
    if (!coverage || coverage.checkpoints < (scenario === 'continuous' ? 6 : 2) || coverage.bytesHashed <= 0 || !(validContinuous || validBatch)) {
      throw new Error(`benchmark sample did not produce complete edit evidence: ${JSON.stringify(coverage)}`)
    }
    const normalizedReceipt = normalize(receipt, root)
    receiptSemantics.push(createHash('sha256').update(JSON.stringify(normalizedReceipt)).digest('hex'))
    if (sample) samples.push({ firstEditMs: timings[0], repeatEditMs: scenario === 'continuous' ? (timings[1] + timings[2]) / 2 : timings[0], peakHeapDeltaBytes: peakHeapDelta, peakRssDeltaBytes: peakRssDelta })
    } finally {
      dispose?.(); await plugin.disposeAllManagers(); await rm(root, { recursive: true, force: true })
    }
  }
  const percentile = (key, p) => { const sorted = samples.map((s) => s[key]).sort((a, b) => a - b); const rank = (sorted.length - 1) * p; const lo = Math.floor(rank), hi = Math.ceil(rank); return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo) }
  results.push({ entry, files: count, scenario, measuredSamples: samples.length, warmups: 1, receiptSemantics,
    firstEditMedianMs: percentile('firstEditMs', 0.5), firstEditP95Ms: percentile('firstEditMs', 0.95),
    repeatEditMedianMs: percentile('repeatEditMs', 0.5), repeatEditP95Ms: percentile('repeatEditMs', 0.95),
    peakHeapDeltaMedianBytes: percentile('peakHeapDeltaBytes', 0.5), peakHeapDeltaP95Bytes: percentile('peakHeapDeltaBytes', 0.95),
    peakRssDeltaMedianBytes: percentile('peakRssDeltaBytes', 0.5), peakRssDeltaP95Bytes: percentile('peakRssDeltaBytes', 0.95), samples })
}
for (const count of [100, 1000]) for (const scenario of scenarios) {
  const baseline = results.find((result) => result.entry === entries[0] && result.files === count && result.scenario === scenario)
  const candidate = results.find((result) => result.entry === entries[1] && result.files === count && result.scenario === scenario)
  assert.deepEqual(baseline?.receiptSemantics, candidate?.receiptSemantics, `Quality Receipt semantics differ for ${count} files`)
}
const report = { node: process.version, platform: process.platform, protocol: `one warmup + ${measuredCount} samples; scenarios=${scenarios.join(',')}; Quality Receipt scope assertions and before/after semantics equality; 5ms memory sampling; completionChecks=false`, results }
await writeFile(process.env.DSH_BENCH_OUTPUT ?? '.cache/benchmark-evidence-results.json', JSON.stringify(report, null, 2))
log(JSON.stringify({ ...report, results: report.results.map(({ receiptSemantics, samples, ...summary }) => ({ ...summary, receiptSemanticsMatches: true })) }, null, 2))

