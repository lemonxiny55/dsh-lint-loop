import { fileURLToPath } from 'node:url'
import { makeFixtureRepo } from './helpers/fixtures.js'
import { describe, expect, it } from 'vitest'
import { runProcess, schedule } from '../src/runner.js'
import { slowLinterPath } from './helpers/fixtures.js'

const NODE = process.execPath

describe('schedule (serial pool lanes)', () => {
  it('cancels a queued job without executing it and keeps the lane alive', async () => {
    let release!: () => void
    const first = schedule('cancel-queue', () => new Promise<void>((resolve) => { release = resolve }))
    await Promise.resolve()
    const controller = new AbortController()
    let executed = false
    const second = schedule('cancel-queue', async () => { executed = true }, controller.signal)
    controller.abort()
    await expect(second).rejects.toThrow('cancelled')
    release(); await first
    await schedule('cancel-queue', async () => undefined)
    expect(executed).toBe(false)
  })
  it('runs same-key jobs strictly one after another', async () => {
    const events: string[] = []
    const job = (name: string, ms: number) => async () => {
      events.push(`start:${name}`)
      await new Promise((resolve) => setTimeout(resolve, ms))
      events.push(`end:${name}`)
    }
    const lane = 'root::eslint'
    const first = schedule(lane, job('a', 40))
    const second = schedule(lane, job('b', 0))
    await Promise.all([first, second])
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })

  it('runs different keys in parallel and survives a failed job', async () => {
    const events: string[] = []
    const failing = schedule('laneA', async () => {
      events.push('a')
      throw new Error('boom')
    })
    const other = schedule('laneB', async () => {
      events.push('b')
    })
    await expect(failing).rejects.toThrow('boom')
    await other
    expect(events).toEqual(['a', 'b'])

    const after = schedule('laneA', async () => events.push('a2'))
    await after
    expect(events).toEqual(['a', 'b', 'a2']) // failed job did not poison the lane
  })
})

describe('cancellable and Windows-safe processes', () => {
  it('does not spawn when already cancelled', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await runProcess('missing-binary', [], { timeoutMs: 1000, signal: controller.signal })).toMatchObject({ cancelled: true, exitCode: null })
  })
  it('preserves arguments with spaces and shell metacharacters', async () => {
    const values = ['hello world', 'a&b', '汉字 path']
    const run = await runProcess(NODE, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...values], { timeoutMs: 3000 })
    expect(JSON.parse(run.stdout)).toEqual(values)
    if (process.platform === 'win32') {
      const repo = await makeFixtureRepo()
      const shim = await repo.write('safe runner.cmd', `@echo off\r\n"${NODE}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`)
      const shellRun = await runProcess(shim, values, { timeoutMs: 3000 })
      expect(JSON.parse(shellRun.stdout)).toEqual(values)
      expect((await runProcess(shim, ['%PATH%'], { timeoutMs: 3000 })).spawnError?.message).toContain('unsafe Windows shell argument')
    }
  })
})

describe('runProcess', () => {
  it('uses Electron Node mode for self-spawned checks without changing the parent environment', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
    const inherited = process.env.ELECTRON_RUN_AS_NODE
    Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })
    try {
      const outcome = await runProcess(NODE, ['-p', 'process.env.ELECTRON_RUN_AS_NODE'], { timeoutMs: 5_000 })
      expect(outcome.exitCode).toBe(0)
      expect(outcome.stdout.trim()).toBe('1')
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe(inherited)
    } finally {
      if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor)
      else Reflect.deleteProperty(process.versions, 'electron')
    }
  })

  it('captures stdout, stderr, and the exit code', async () => {
    const outcome = await runProcess(NODE, ['-e', 'console.log("out"); console.error("err"); process.exit(1)'], {
      timeoutMs: 5_000,
    })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.stdout).toContain('out')
    expect(outcome.stderr).toContain('err')
    expect(outcome.timedOut).toBe(false)
    expect(outcome.spawnError).toBeUndefined()
  })

  it('kills a hanging linter at the timeout and reports it', async () => {
    const outcome = await runProcess(NODE, [slowLinterPath()], { timeoutMs: 500 })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.stdout).not.toContain('too')
  }, 15_000)

  it('reports a missing binary as a spawn error', async () => {
    const outcome = await runProcess('/nonexistent/linter-under-test-xyz', [], { timeoutMs: 5_000 })
    expect(outcome.spawnError).toBeDefined()
    expect(outcome.spawnError?.code).toBe('ENOENT')
  })

  it('resolves cwd relative to the workspace root', async () => {
    const cwd = fileURLToPath(new URL('.', import.meta.url))
    const outcome = await runProcess(NODE, ['-e', 'console.log(process.cwd())'], { cwd, timeoutMs: 5_000 })
    expect(outcome.stdout.trim()).toBe(cwd.replace(/[\\/]+$/, ''))
  })
})
