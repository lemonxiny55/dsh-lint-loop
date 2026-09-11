/**
 * Bounded source-line cache + code-frame rendering.
 *
 * Frames are the Aider trick: show the offending line in context so the model
 * does not have to re-read the file to fix a finding. Lines are recorded
 * during a lint run (the file is already on disk then) and looked up later by
 * the synchronous render path — so replaying an old result without a cache
 * simply omits frames instead of failing.
 */

const MAX_CACHED_FILES = 256

const cache = new Map<string, string[]>()

/** Record a file's current lines under its repo-relative path. */
export function recordFileLines(relFile: string, content: string): void {
  if (!relFile) return
  if (!cache.has(relFile) && cache.size >= MAX_CACHED_FILES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(relFile, content.split('\n'))
}

/**
 * Render `contextLines` lines around `line` with the offending line marked:
 *
 * ```
 *   2 | const y = 1
 *   3 | const x = 2  █
 * ```
 *
 * Returns undefined when the file was never cached (replay / unreadable).
 */
export function frameFor(relFile: string, line: number, contextLines: number): string | undefined {
  const lines = cache.get(relFile)
  if (!lines || line < 1 || line > lines.length) return undefined
  const start = Math.max(1, line - contextLines)
  let end = Math.min(lines.length, line + contextLines)
  // A trailing blank context row is noise (files end with a newline).
  while (end > line && lines[end - 1] === '') end--
  const width = String(end).length
  const out: string[] = []
  for (let n = start; n <= end; n++) {
    const marker = n === line ? '  █' : ''
    out.push(`  ${String(n).padStart(width)} | ${lines[n - 1]}${marker}`)
  }
  return out.join('\n')
}

export function clearFrameCache(): void {
  cache.clear()
}
