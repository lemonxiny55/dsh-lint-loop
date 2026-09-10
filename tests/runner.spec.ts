import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runProcess, schedule } from '../src/runner.js'
import { slowLinterPath } from './helpers/fixtures.js'

const NODE = process.execPath

describe('schedule (serial pool lanes)', () => {
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

describe('runProcess', () => {
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
    expect(outcome.stdout.trim()).toBe(cwd.replace(/\/$/, ''))
  })
})
