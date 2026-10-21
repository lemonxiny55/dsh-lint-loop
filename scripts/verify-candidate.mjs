import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
const output = path.resolve(process.argv[2] ?? '.cache/verification.json')
const record = { node: process.version, platform: process.platform, startedAt: new Date().toISOString(), checks: [] }
const checks = [
  ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['tests', ['node_modules/vitest/vitest.mjs', 'run']],
  ['build', ['node_modules/tsup/dist/cli-default.js']],
  ['compat-smoke', ['scripts/compat-smoke.mjs']],
]
await mkdir(path.dirname(output), { recursive: true })
for (const [name, args] of checks) {
  const start = performance.now()
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
  const result = { name, command: process.execPath, args, exitCode: run.status, elapsedMs: Math.round(performance.now() - start), stdout: run.stdout, stderr: run.stderr, ...(run.error ? { error: String(run.error) } : {}) }
  record.checks.push(result)
  await writeFile(output, JSON.stringify(record, null, 2) + '\n')
  console.log(`${name}: ${run.status === 0 ? 'passed' : 'FAILED'} (${result.elapsedMs}ms)`)
  if (run.status !== 0) { process.stderr.write(run.stdout + run.stderr); process.exit(run.status ?? 1) }
}
console.log(`Actual candidate verification saved: ${output}`)
