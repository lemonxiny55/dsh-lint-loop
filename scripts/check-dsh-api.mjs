import assert from 'node:assert/strict'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const runtime = path.resolve(process.argv[2] ?? '.cache/dsh021')
const dir = path.resolve('.cache/api-check')
await mkdir(dir, { recursive: true })
const types = path.join(runtime, 'node_modules/@deepseek-ai/dsh-tools/lib/types')
const config = { extends: path.resolve('tsconfig.json'), include: [path.resolve('src/**/*.ts').replaceAll('\\', '/')], compilerOptions: { paths: {
  '@deepseek-ai/dsh-tools': [path.join(types, 'index.d.ts')], '@deepseek-ai/dsh-tools/presentation': [path.join(types, 'presentation.d.ts')],
} } }
await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify(config))
const run = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8', windowsHide: true })
assert.equal(run.status, 0, run.stdout + run.stderr)
await mkdir(path.join(runtime, 'bundle'), { recursive: true })
await copyFile('dist/index.js', path.join(runtime, 'bundle/candidate.mjs'))
const smoke = spawnSync(process.execPath, ['scripts/compat-smoke.mjs', path.join(runtime, 'bundle/candidate.mjs')], { encoding: 'utf8', windowsHide: true })
assert.equal(smoke.status, 0, smoke.stdout + smoke.stderr)
console.log('Published DSH 0.2.1-rc.2: declaration typecheck and runtime import/dispose smoke passed')
