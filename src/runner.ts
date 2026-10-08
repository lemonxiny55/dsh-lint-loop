/**
 * Linter process execution: spawn → capture → timeout-kill, plus a serial
 * queue so a save storm never runs N linters concurrently per (root, linter).
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

export interface RunOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  /** spawn(2) failure — ENOENT for a missing binary, EACCES, … */
  spawnError?: { code?: string; message: string }
  /** The run exceeded its timeout and was killed. */
  timedOut: boolean
  cancelled?: boolean
  truncated?: boolean
}

const OUTPUT_CAP_BYTES = 2 * 1024 * 1024

/** Spawn a one-shot linter process. Never throws — every failure lands in the outcome. */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true })
      return
    }
    const shell = process.platform === 'win32' && needsWindowsShell(command)
    // cmd expands these even inside quotes. Fail closed for shell shims;
    // quality checks use Node + local JS entry points and never need a shell.
    if (shell && [command, ...args].some((arg) => /["%!\r\n]/.test(arg))) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false,
        spawnError: { message: 'unsafe Windows shell argument; use an absolute executable or JS entry point' } })
      return
    }
    const shellCommand = [`"${command}"`, ...args.map((arg) => `"${arg}"`)].join(' ')
    const child = spawn(shell ? shellCommand : command, shell ? [] : args, {
      cwd: options.cwd,
      // Desktop hosts embed Node in Electron: execPath is the GUI executable.
      // Self-spawned JS checks must use its supported Node mode, otherwise
      // Chromium/app startup output can replace or contaminate check evidence.
      env: command === process.execPath && process.versions.electron
        ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        : undefined,
      // npm global shims on Windows are .cmd files — shell keeps them resolvable.
      shell,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let cancelled = false
    let truncated = false
    let graceTimer: NodeJS.Timeout | undefined

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > OUTPUT_CAP_BYTES) truncated = true
      stdout = (stdout + chunk).slice(0, OUTPUT_CAP_BYTES)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length + chunk.length > OUTPUT_CAP_BYTES) truncated = true
      stderr = (stderr + chunk).slice(0, OUTPUT_CAP_BYTES)
    })
    child.stdout?.on('error', () => undefined)
    child.stderr?.on('error', () => undefined)

    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.on('error', () => child.kill('SIGKILL'))
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      }
      child.kill('SIGTERM')
      graceTimer = setTimeout(() => {
        if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
        else child.kill('SIGKILL')
      }, 1_000)
      graceTimer.unref?.()
    }
    const abort = () => { cancelled = true; stop() }
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    timer.unref?.()

    const finish = (spawnError?: { code?: string; message: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      options.signal?.removeEventListener('abort', abort)
      resolve({ exitCode: child.exitCode, stdout, stderr, spawnError, timedOut, cancelled, truncated })
    }

    child.once('error', (error) => {
      // A failed spawn never produces a process.
      finish({ code: (error as NodeJS.ErrnoException).code, message: error.message })
    })
    child.once('close', () => {
      // Windows shell mode reports a missing executable through cmd.exe's
      // stderr instead of spawn('error'). Normalize it to the same outcome
      // as a direct ENOENT so tools can return the install hint.
      const shellMissing = process.platform === 'win32'
        && child.exitCode !== 0
        && stdout.trim() === ''
        && /is not recognized|cannot find the path specified|command not found|not found/i.test(stderr)
      finish(shellMissing ? { code: 'ENOENT', message: stderr.trim() } : undefined)
    })
  })
}

function needsWindowsShell(command: string): boolean {
  if (process.platform !== 'win32') return false
  if (/\.cmd$/i.test(command)) return true
  // Absolute .exe/node overrides must bypass cmd.exe; shell concatenation can
  // corrupt quoted `-e` arguments and hides direct ENOENT diagnostics.
  return !path.isAbsolute(command)
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
    /is not recognized|cannot find the path specified|command not found|not found/i.test(outcome.stderr)
  )
}

/**
 * Serial work queue, one lane per key (root+linter). Jobs run in submission
 * order; a failed job never blocks the next one.
 */
const lanes = new Map<string, Promise<unknown>>()

export function schedule<T>(key: string, job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const tail = lanes.get(key) ?? Promise.resolve()
  let started = false
  let rejectQueued: ((error: Error) => void) | undefined
  const abort = () => { if (!started) rejectQueued?.(new Error('queued run cancelled')) }
  const execute = () => {
    started = true
    signal?.removeEventListener('abort', abort)
    if (signal?.aborted) throw new Error('queued run cancelled')
    return job()
  }
  const work = tail.then(execute, execute)
  const result = signal ? Promise.race([work, new Promise<T>((_resolve, reject) => {
    rejectQueued = reject
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })]) : work
  // Store a never-rejecting tail so the lane survives failed jobs.
  const next = work.then(
      () => undefined,
      () => undefined,
    )
  lanes.set(key, next)
  void next.then(() => { if (lanes.get(key) === next) lanes.delete(key) })
  return result
}
