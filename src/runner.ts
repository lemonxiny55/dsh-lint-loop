/**
 * Linter process execution: spawn → capture → timeout-kill, plus a serial
 * queue so a save storm never runs N linters concurrently per (root, linter).
 */

import { spawn } from 'node:child_process'

export interface RunOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  /** spawn(2) failure — ENOENT for a missing binary, EACCES, … */
  spawnError?: { code?: string; message: string }
  /** The run exceeded its timeout and was killed. */
  timedOut: boolean
}

const OUTPUT_CAP_BYTES = 2 * 1024 * 1024

/** Spawn a one-shot linter process. Never throws — every failure lands in the outcome. */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // npm global shims on Windows are .cmd files — shell keeps them resolvable.
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let graceTimer: NodeJS.Timeout | undefined

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += chunk
    })
    child.stdout?.on('error', () => undefined)
    child.stderr?.on('error', () => undefined)

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      graceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
      graceTimer.unref?.()
    }, options.timeoutMs)
    timer.unref?.()

    const finish = (spawnError?: { code?: string; message: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      resolve({ exitCode: child.exitCode, stdout, stderr, spawnError, timedOut })
    }

    child.once('error', (error) => {
      // A failed spawn never produces a process.
      finish({ code: (error as NodeJS.ErrnoException).code, message: error.message })
    })
    child.once('close', () => finish())
  })
}

/** True when the process never started (binary missing) or the shell says so. */
export function isMissingBinary(outcome: RunOutcome): boolean {
  if (outcome.spawnError) {
    const code = outcome.spawnError.code
    return code === undefined || code === 'ENOENT' || code === 'EACCES'
  }
  // Windows shell mode: a missing command never reaches spawn errors — the
  // shell prints "is not recognized" and exits non-zero.
  return (
    outcome.exitCode !== 0 &&
    outcome.stdout.trim() === '' &&
    /is not recognized|command not found|not found/i.test(outcome.stderr)
  )
}

/**
 * Serial work queue, one lane per key (root+linter). Jobs run in submission
 * order; a failed job never blocks the next one.
 */
const lanes = new Map<string, Promise<unknown>>()

export function schedule<T>(key: string, job: () => Promise<T>): Promise<T> {
  const tail = lanes.get(key) ?? Promise.resolve()
  const result = tail.then(job, job)
  // Store a never-rejecting tail so the lane survives failed jobs.
  lanes.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  )
  return result
}
