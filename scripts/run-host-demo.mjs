import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises'
import path from 'node:path'
const host = process.argv[2] ?? 'web'
assert(['web', 'desktop'].includes(host))
const dir = path.resolve('.cache/host-demo-' + host)
await mkdir(dir, { recursive: true })
try {
  const previous = path.join(dir, 'output'), archived = path.join(dir, 'attempt-' + Date.now())
  assert.equal(path.dirname(previous), dir); assert.equal(path.dirname(archived), dir)
  await access(previous); await rename(previous, archived)
} catch (error) { if (error.code !== 'ENOENT') throw error }
const home = path.resolve('.cache/dsh-home-' + (host === 'web' ? 'v070' : 'desktop-v070'))
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: path.resolve('.cache/demo-agents'), COREPACK_HOME: path.resolve('.cache/corepack') }
// Other Electron applications' crash-handler handles must not be inherited.
for (const key of Object.keys(env)) if (/CRASHPAD|CRASHDUMP/i.test(key)) delete env[key]
delete env.ELECTRON_RUN_AS_NODE
const executable = host === 'web' ? process.execPath : path.resolve('.cache/desktop021/DeepSeek Harness.exe')
const args = host === 'web'
  ? [path.resolve('.cache/dsh021/node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'evidence-web', '--patch', path.join(dir, 'overlay.yml'), '--no-open', '--port', '0']
  : [`--user-data-dir=${path.join(dir, 'electron-user-data')}`]
const child = spawn(executable, args, { env, cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = '', exit
const scrub = (text) => text.replace(/([?&]token=)[A-Za-z0-9_.%~-]+/g, '$1<redacted>')
child.stdout.on('data', (chunk) => { output = (output + scrub(chunk.toString())).slice(-80000) })
child.stderr.on('data', (chunk) => { output = (output + scrub(chunk.toString())).slice(-80000) })
child.on('exit', (code) => { exit = code })
try {
  const deadline = Date.now() + 150000
  for (;;) {
    await writeFile(path.join(dir, 'host.log'), output)
    let result, failure, completed
    try { result = JSON.parse(await readFile(path.join(dir, 'output/results.json'), 'utf8')) } catch {}
    try { failure = JSON.parse(await readFile(path.join(dir, 'output/failure.json'), 'utf8')) } catch {}
    try { completed = JSON.parse(await readFile(path.join(dir, 'output/completed.json'), 'utf8')) } catch {}
    if (failure) throw new Error(JSON.stringify(failure))
    if (result && completed?.passed && completed.agentDisposed) {
      assert.equal(result.receipts[2].finalVerdict, 'clean')
      assert.equal(result.receipts[2].evidenceCoverage.status, 'complete')
      await writeFile(path.join(dir, 'acceptance.json'), JSON.stringify({ host, executable, args, node: result.node, pid: child.pid, installedCandidate: '0.7.0-rc.0', result: 'passed', verdicts: result.receipts.map((r) => r.finalVerdict), capturedAt: new Date().toISOString(), shutdown: 'agent handle disposed normally; app process tree stopped by acceptance supervisor' }, null, 2))
      console.log(`${host} actual app installation/runtime demo passed: ${dir}`)
      break
    }
    if (exit !== undefined) throw new Error(`${host} exited ${exit}: ${output.slice(-8000)}`)
    if (Date.now() > deadline) throw new Error(`${host} timed out: ${output.slice(-8000)}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
} finally {
  await writeFile(path.join(dir, 'host.log'), output)
  if (exit === undefined && child.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGTERM')
  }
}
