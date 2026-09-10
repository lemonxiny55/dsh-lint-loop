import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { applyConfig } from '../src/config.js'
import { invalidateProbes } from '../src/detect.js'
import { disposeAllManagers, managerForRoot } from '../src/manager.js'
import { tools } from '../src/tools.js'
import {
  fakeLinterPath,
  makeFixtureRepo,
  slowLinterPath,
  SAMPLE_PY,
  SAMPLE_TS,
  type FixtureRepo,
} from './helpers/fixtures.js'

const FAKE = fakeLinterPath()
const lintDiagnostics = tools.find((tool) => tool.name === 'lint_diagnostics')!
const lintWorkspaceErrors = tools.find((tool) => tool.name === 'lint_workspace_errors')!
const lintFix = tools.find((tool) => tool.name === 'lint_fix')!

let repo: FixtureRepo

afterEach(async () => {
  await disposeAllManagers()
  invalidateProbes()
  applyConfig()
})

/** Point every linter at the fake and create a fresh fixture repo. */
async function freshRepo(configFile?: { name: string; content: string }): Promise<FixtureRepo> {
  applyConfig({ linterPath: { eslint: FAKE, biome: FAKE, ruff: FAKE } })
  const created = await makeFixtureRepo()
  if (configFile) await created.write(configFile.name, configFile.content)
  return created
}

/** Tool-shaped execute: `(args, exec) → canonical JSON value`. */
async function run(tool: ToolDefinition, args: Record<string, unknown>, root: string): Promise<unknown> {
  const execute = tool.execute as (a: unknown, exec: unknown) => Promise<unknown>
  return execute(args, { agent: { session: { header: { cwd: root } } } })
}

/** Tool-shaped render: canonical value → joined text blocks. */
function render(tool: ToolDefinition, value: unknown): string {
  const renderFn = tool.output.render as (args: unknown, value: JsonValue) => Array<{ text: string }>
  return renderFn({}, value as JsonValue).map((block) => block.text).join('\n')
}

const ESLINT_CONFIG = { name: 'eslint.config.mjs', content: 'export default []\n' }

describe('lint_diagnostics', () => {
  it('returns canonical findings for an edited file and renders the table', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write('src/a.ts', SAMPLE_TS)

    const value = await run(lintDiagnostics, { file: 'src/a.ts' }, repo.root) as Array<Record<string, unknown>>
    const errors = value.filter((entry) => entry.severity === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      file: 'src/a.ts', line: 2, col: 10, severity: 'error',
      rule: 'no-debugger', message: 'no debugger statements allowed', fixable: false, linter: 'eslint',
    })
    const fixable = value.find((entry) => entry.fixable === true)
    expect(fixable).toMatchObject({ rule: 'semi', line: 3 })

    const rendered = render(lintDiagnostics, value)
    expect(rendered).toContain('# lint findings (1 error, 2 warnings)')
    expect(rendered).toMatch(/src\/a\.ts:2:\d+\s+error\s+no-debugger\s+no debugger statements allowed/)
    expect(rendered).toMatch(/warn\s+semi\s+missing semicolon\s+\[fixable\]/)
  })

  it('picks up new findings after the file changes on disk (the edit loop)', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write('src/loop.ts', 'const clean = 1\n')

    const before = await run(lintDiagnostics, { file: 'src/loop.ts' }, repo.root)
    expect(before).toEqual([])

    await repo.write('src/loop.ts', 'const x = 1 // lint: error no-unused-vars x is never used\n')
    const after = await run(lintDiagnostics, { file: 'src/loop.ts' }, repo.root) as Array<Record<string, unknown>>
    expect(after.filter((entry) => entry.severity === 'error')).toHaveLength(1)
  })

  it('filters by severity and caps at max with a truncation note', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write(
      'src/many.ts',
      Array.from({ length: 5 }, (_, i) => `const v${i} = ${i} // lint: error rule-${i} error number ${i}`).join('\n') + '\n',
    )

    const capped = await run(lintDiagnostics, { file: 'src/many.ts', max: 2 }, repo.root) as Array<Record<string, unknown>>
    expect(capped).toHaveLength(3) // 2 findings + 1 note
    expect(capped[2]).toEqual({ note: '+3 more suppressed — raise the max parameter or maxFindings config' })

    const warnings = await run(lintDiagnostics, { file: 'src/many.ts', severity: 'warning' }, repo.root)
    expect(warnings).toEqual([])
  })

  it('omitting file lists every file the linters have seen', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write('src/a.ts', 'const a = 1 // lint: error rule-a err-a\n')
    await repo.write('src/b.ts', 'const b = 2 // lint: error rule-b err-b\n')

    await run(lintDiagnostics, { file: 'src/a.ts' }, repo.root)
    await run(lintDiagnostics, { file: 'src/b.ts' }, repo.root)

    const all = await run(lintDiagnostics, {}, repo.root) as Array<Record<string, unknown>>
    const files = all.filter((entry) => entry.file).map((entry) => entry.file).sort()
    expect(files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('returns a friendly error for files outside the workspace', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    const value = await run(lintDiagnostics, { file: '/etc/hostname' }, repo.root) as Array<Record<string, unknown>>
    expect(value).toHaveLength(1)
    expect(String(value[0].error)).toContain('outside the workspace root')
  })

  it('returns a friendly error for unsupported file types', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write('README.md', '# hi\n')
    const value = await run(lintDiagnostics, { file: 'README.md' }, repo.root) as Array<Record<string, unknown>>
    expect(String(value[0].error)).toContain('no linter for ".md"')
  })

  it('returns the install hint when the linter binary is missing', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    applyConfig({ linterPath: { eslint: '/nonexistent/eslint-under-test', biome: FAKE, ruff: FAKE } })
    await repo.write('a.ts', 'const a = 1\n')
    const value = await run(lintDiagnostics, { file: 'a.ts' }, repo.root) as Array<Record<string, unknown>>
    expect(String(value[0].error)).toContain('"eslint"')
    expect(String(value[0].error)).toContain('npm i -D eslint')
  })

  it('returns the init hint when the repo has no linter configuration', async () => {
    repo = await freshRepo()
    await repo.write('a.ts', 'const a = 1 // lint: error x y\n')
    const value = await run(lintDiagnostics, { file: 'a.ts' }, repo.root) as Array<Record<string, unknown>>
    expect(String(value[0].error)).toContain('no usable linter configuration')
    expect(String(value[0].error)).toContain('npx eslint --init')
    expect(String(value[0].error)).toContain('biome init')
  })

  it('degrades gracefully when the linter times out', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    applyConfig({ linterPath: { eslint: slowLinterPath(), biome: FAKE, ruff: FAKE }, timeoutMs: 500 })
    await repo.write('a.ts', 'const a = 1\n')
    const value = await run(lintDiagnostics, { file: 'a.ts' }, repo.root) as Array<Record<string, unknown>>
    expect(String(value[0].error)).toContain('timed out after')
  }, 15_000)

  it('retries without --no-warn-ignored on legacy eslint (< 8.22) and remembers', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write('src/legacy.ts', 'const l = 1 // lint: error legacy-rule legacy eslint still lints\n')

    process.env.FAKE_ESLINT_LEGACY = '1'
    try {
      const first = await run(lintDiagnostics, { file: 'src/legacy.ts' }, repo.root) as Array<Record<string, unknown>>
      expect(first[0]).toMatchObject({ rule: 'legacy-rule', linter: 'eslint' })
      // The memo persists: a second call still succeeds without the flag.
      const second = await run(lintDiagnostics, { file: 'src/legacy.ts' }, repo.root) as Array<Record<string, unknown>>
      expect(second[0]).toMatchObject({ rule: 'legacy-rule' })
    } finally {
      delete process.env.FAKE_ESLINT_LEGACY
    }
  })

  it('returns a friendly error when no git repository exists', async () => {
    applyConfig({ linterPath: { eslint: FAKE, biome: FAKE, ruff: FAKE } })
    const value = await run(lintDiagnostics, { file: 'x.ts', repoRoot: '/tmp' }, '/tmp') as Array<Record<string, unknown>>
    expect(String(value[0].error)).toContain('no git repository found')
  })
})

describe('extension routing through real tool calls', () => {
  it('routes .ts to biome when only a biome config exists', async () => {
    repo = await freshRepo({ name: 'biome.json', content: '{}\n' })
    await repo.write('src/b.ts', 'const b = 2 // lint: warning style-rule biome says hi\n')

    const value = await run(lintDiagnostics, { file: 'src/b.ts' }, repo.root) as Array<Record<string, unknown>>
    expect(value.filter((entry) => entry.file)).toHaveLength(1)
    expect(value[0]).toMatchObject({ rule: 'lint/correctness/style-rule', linter: 'biome', severity: 'warning' })
  })

  it('routes .py to ruff when a ruff config exists', async () => {
    repo = await freshRepo({ name: 'ruff.toml', content: 'line-length = 88\n' })
    await repo.write('mod.py', SAMPLE_PY)

    const value = await run(lintDiagnostics, { file: 'mod.py' }, repo.root) as Array<Record<string, unknown>>
    expect(value[0]).toMatchObject({ rule: 'F401', linter: 'ruff', severity: 'error', fixable: false })
    expect(value[1]).toMatchObject({ rule: 'E501', fixable: true })
  })

  it('refuses a .py file when no ruff config exists even with eslint present', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write('mod.py', 'x = 1\n')
    const value = await run(lintDiagnostics, { file: 'mod.py' }, repo.root) as Array<Record<string, unknown>>
    expect(String(value[0].error)).toContain('no usable linter configuration')
    expect(String(value[0].error)).toContain('eslint') // detected linters are named
  })

  it('re-probes after the linter config file changes (biome added later)', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write('src/c.ts', 'const c = 3 // lint: error who-lints c broken\n')

    const before = await run(lintDiagnostics, { file: 'src/c.ts' }, repo.root) as Array<Record<string, unknown>>
    expect(before[0]).toMatchObject({ linter: 'eslint' })

    await repo.write('biome.json', '{}\n')
    invalidateProbes() // what the fs/observed listener does on a config change

    const after = await run(lintDiagnostics, { file: 'src/c.ts' }, repo.root) as Array<Record<string, unknown>>
    expect(after[0]).toMatchObject({ linter: 'eslint' }) // eslint still wins the tie
  })
})

describe('lint_workspace_errors', () => {
  it('aggregates errors across every seen file and renders them', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write('src/a.ts', 'const a = 1 // lint: error rule-a err-a\n// lint: warning rule-w warn-w\n')
    await repo.write('src/b.ts', 'const b = 2 // lint: error rule-b err-b\n')
    await run(lintDiagnostics, { file: 'src/a.ts' }, repo.root)
    await run(lintDiagnostics, { file: 'src/b.ts' }, repo.root)

    const value = await run(lintWorkspaceErrors, {}, repo.root) as Array<Record<string, unknown>>
    expect(value.filter((entry) => entry.file)).toHaveLength(2)

    const rendered = render(lintWorkspaceErrors, value)
    expect(rendered).toContain('# lint findings (2 errors)')
    expect(rendered).toContain('err-a')
    expect(rendered).toContain('err-b')
    expect(rendered).not.toContain('warn-w')
  })

  it('is empty before any file has been linted', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    const value = await run(lintWorkspaceErrors, {}, repo.root)
    expect(value).toEqual([])
  })
})

describe('lint_fix', () => {
  it('rewrites the file, reports the diff, and re-lints for remaining findings', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write('src/fix.ts', SAMPLE_TS)

    const value = await run(lintFix, { file: 'src/fix.ts' }, repo.root) as Record<string, unknown>
    expect(value.fixed).toBe(true)
    expect(value.changedLines).toEqual({ added: 1, removed: 1 })
    expect(value.linter).toBe('eslint')
    const remaining = value.remaining as Array<Record<string, unknown>>
    // The fixable [fixable] marker was stripped; the two non-fixable findings remain.
    expect(remaining.filter((entry) => entry.rule)).toHaveLength(2)
    expect(remaining.some((entry) => entry.rule === 'semi')).toBe(false)

    const rendered = render(lintFix, value)
    expect(rendered).toContain('# lint_fix (eslint) — src/fix.ts')
    expect(rendered).toContain('fixed: yes (+1/-1 lines)')
    expect(rendered).toContain('remaining: 1 error, 1 warning')
    expect(rendered).not.toContain('more suppressed')
  })

  it('reports fixed=false when nothing was fixable', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write('src/stuck.ts', 'debugger // lint: error no-debugger no debugger statements allowed\n')

    const value = await run(lintFix, { file: 'src/stuck.ts' }, repo.root) as Record<string, unknown>
    expect(value.fixed).toBe(false)
    expect(value.changedLines).toEqual({ added: 0, removed: 0 })
    expect((value.remaining as unknown[]).filter((entry) => (entry as Record<string, unknown>).rule)).toHaveLength(1)
  })

  it('works through the biome fix path (--write) when biome is the chosen linter', async () => {
    repo = await freshRepo({ name: 'biome.json', content: '{}\n' })
    await repo.write('src/bfix.ts', 'let b = 1 // lint: error style/biome-fix biome can fix this [fixable]\n')

    const value = await run(lintFix, { file: 'src/bfix.ts' }, repo.root) as Record<string, unknown>
    expect(value.linter).toBe('biome')
    expect(value.fixed).toBe(true)
    expect(value.remaining).toEqual([])
  })

  it('caps remaining findings with a suppression note', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    await repo.write(
      'src/caps.ts',
      'debugger\n'.repeat(4).split('\n').map((line, i) => (line ? `${line} // lint: error r${i} boom ${i}` : '')).join('\n') + '\n',
    )

    const value = await run(lintFix, { file: 'src/caps.ts', max: 2 }, repo.root) as Record<string, unknown>
    const remaining = value.remaining as Array<Record<string, unknown>>
    expect(remaining.filter((entry) => entry.rule)).toHaveLength(2)
    expect(remaining.at(-1)).toEqual({ note: '+2 more suppressed — raise the max parameter or maxFindings config' })
    const rendered = render(lintFix, value)
    expect(rendered).toContain('(+2 more suppressed')
  })

  it('refuses files outside the workspace root', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    const value = await run(lintFix, { file: '/etc/hostname' }, repo.root) as Record<string, unknown>
    expect(String(value.error)).toContain('outside the workspace root')
  })

  it('propagates the init hint when no linter is configured', async () => {
    repo = await freshRepo()
    await repo.write('src/f.ts', 'const f = 1 // lint: error x y [fixable]\n')
    const value = await run(lintFix, { file: 'src/f.ts' }, repo.root) as Record<string, unknown>
    expect(String(value.error)).toContain('no usable linter configuration')
  })
})

describe('manager store', () => {
  it('keeps findings fresh per file and aggregates allFindings', async () => {
    repo = await freshRepo(ESLINT_CONFIG)
    const file = await repo.write('src/store.ts', 'const s = 1 // lint: error rule-s err-s\n')
    const manager = managerForRoot(repo.root)
    expect(manager.seenFileCount).toBe(0)

    await manager.lintFile(file)
    expect(manager.seenFileCount).toBe(1)
    expect(manager.findingsFor(file)).toHaveLength(1)

    await manager.lintFile(file) // same file again — replaced, not duplicated
    expect(manager.findingsFor(file)).toHaveLength(1)
    expect(manager.allFindings()).toHaveLength(1)
  })
})
