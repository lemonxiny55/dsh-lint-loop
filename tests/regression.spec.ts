import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyFindings, clearAllBaselines, ensureBaseline } from '../src/baseline.js'
import { applyConfig } from '../src/config.js'
import { invalidateProbes } from '../src/detect.js'
import { clearGateState, handleTurnStopping, markDirty } from '../src/gate.js'
import { type Finding, matchFindings } from '../src/findings.js'
import { disposeAllManagers, managerForRoot } from '../src/manager.js'
import { prepareMutation } from '../src/regression.js'
import { tools } from '../src/tools.js'
import { fakeLinterPath, makeFixtureRepo } from './helpers/fixtures.js'

const FAKE = fakeLinterPath()

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    rule: 'same-rule',
    file: 'src/a.ts',
    line: 3,
    col: 1,
    endLine: 3,
    endCol: 10,
    severity: 'error',
    message: 'same message',
    fixable: false,
    linter: 'eslint',
    ...overrides,
  }
}

const lintDiagnostics = tools.find((tool) => tool.name === 'lint_diagnostics')!
const lintFix = tools.find((tool) => tool.name === 'lint_fix')!

function exec(root: string, session: object) {
  Object.assign(session, { header: { cwd: root } })
  return { agent: { session } }
}

afterEach(async () => {
  clearAllBaselines()
  clearGateState()
  await disposeAllManagers()
  invalidateProbes()
  applyConfig()
})

describe('finding identity and matching', () => {
  it('matches a finding after lines are inserted before it', () => {
    const before = finding({ line: 3, context: 'const old = 1 // lint marker' })
    const after = finding({ line: 7, context: 'const old = 1 // lint marker' })
    const match = matchFindings([before], [after])
    expect(match.matches).toEqual([{ current: 0, previous: 0, exact: true, score: 4 }])
    expect(match.unmatchedCurrent).toEqual([])
  })

  it('pairs duplicate rule/message findings one-to-one using source context', () => {
    const before = [
      finding({ line: 2, context: 'const first = 1' }),
      finding({ line: 8, context: 'const second = 2' }),
    ]
    const after = [
      finding({ line: 12, context: 'const second = 2' }),
      finding({ line: 20, context: 'const new = 3' }),
    ]
    const match = matchFindings(before, after)
    expect(match.matches).toHaveLength(1)
    expect(match.matches[0].current).toBe(0)
    expect(match.unmatchedCurrent).toEqual([1])
    expect(match.unmatchedPrevious).toEqual([0])
  })

  it('reports changed diagnostics separately from introduced and resolved', () => {
    const owner = {}
    const file = 'C:/repo/src/a.ts'
    ensureBaseline(owner, file, [finding({ context: 'const x = 1' })])
    const delta = classifyFindings(owner, file, [finding({ message: 'changed message', context: 'const x = 1' })])
    expect(delta.changed).toHaveLength(1)
    expect(delta.introduced).toHaveLength(0)
    expect(delta.resolved).toHaveLength(0)
  })
})

describe('regression-aware manager, tools, and gate', () => {
  it('captures a pre-edit baseline and ignores historical errors after line drift', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/a.ts', 'const old = 1 // lint: error old-rule old debt\n')
    applyConfig({ linterPath: { eslint: FAKE } })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    await repo.write(
      'src/a.ts',
      'const header = 1\nconst old = 1 // lint: error old-rule old debt\nconst fresh = 2 // lint: error fresh-rule new regression\n',
    )

    const current = await managerForRoot(repo.root).lintFile(file)
    const delta = classifyFindings(session, file, current)
    expect(delta.preexisting.map((item) => item.rule)).toEqual(['old-rule'])
    expect(delta.introduced.map((item) => item.rule)).toEqual(['fresh-rule'])
    expect(delta.resolved).toEqual([])
  })

  it('keeps the first baseline across multiple edits in one turn', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/multi.ts', 'const old = 1 // lint: error old-rule old debt\n')
    applyConfig({ linterPath: { eslint: FAKE } })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    await repo.write('src/multi.ts', 'const old = 1 // lint: error old-rule old debt\nconst one = 1 // lint: error one-rule first\n')
    await managerForRoot(repo.root).lintFile(file)
    await repo.write('src/multi.ts', 'const old = 1 // lint: error old-rule old debt\nconst one = 1 // lint: error one-rule first\nconst two = 2 // lint: error two-rule second\n')
    const delta = classifyFindings(session, file, await managerForRoot(repo.root).lintFile(file))
    expect(delta.preexisting.map((item) => item.rule)).toEqual(['old-rule'])
    expect(delta.introduced.map((item) => item.rule)).toEqual(['one-rule', 'two-rule'])
  })

  it('gates only unresolved introduced errors, then admits after the agent fixes them', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/gated.ts', 'const old = 1 // lint: error old-rule old debt\n')
    applyConfig({ linterPath: { eslint: FAKE }, gateMaxSteers: 2 })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    await repo.write('src/gated.ts', 'const old = 1 // lint: error old-rule old debt\nconst fresh = 2 // lint: error fresh-rule new\n')
    const agent = { id: 'regression-session', session, steer: vi.fn() }
    markDirty(file, session)
    await handleTurnStopping({ agent, turn: 1 })
    expect(agent.steer).toHaveBeenCalledTimes(1)

    await repo.write('src/gated.ts', 'const old = 1 // lint: error old-rule old debt\nconst fresh = 2\n')
    markDirty(file, session)
    await handleTurnStopping({ agent, turn: 1 })
    expect(agent.steer).toHaveBeenCalledTimes(1)
  })

  it('exposes introduced and pre-existing scopes through lint_diagnostics', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/scopes.ts', 'const old = 1 // lint: error old-rule old debt\n')
    applyConfig({ linterPath: { eslint: FAKE } })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    await repo.write('src/scopes.ts', 'const old = 1 // lint: error old-rule old debt\nconst fresh = 2 // lint: error fresh-rule new\n')
    const execute = lintDiagnostics.execute as (args: unknown, context: unknown) => Promise<unknown>
    const introduced = await execute({ file_path: 'src/scopes.ts', scope: 'introduced' }, exec(repo.root, session)) as Array<Record<string, unknown>>
    const preexisting = await execute({ file_path: 'src/scopes.ts', scope: 'preexisting' }, exec(repo.root, session)) as Array<Record<string, unknown>>
    expect(introduced.map((item) => item.rule)).toEqual(['fresh-rule'])
    expect(introduced[0].scope).toBe('introduced')
    expect(preexisting.map((item) => item.rule)).toEqual(['old-rule'])
    expect(preexisting[0].scope).toBe('preexisting')
  })

  it('keeps lint_fix on the same baseline and reports resolved findings', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/fix.ts', 'const old = 1 // lint: error old-rule old debt\n')
    applyConfig({ linterPath: { eslint: FAKE } })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    await repo.write('src/fix.ts', 'const old = 1 // lint: error old-rule old debt\nconst fresh = 2 // lint: error fresh-rule new [fixable]\n')
    const execute = lintFix.execute as (args: unknown, context: unknown) => Promise<unknown>
    const result = await execute({ file_path: 'src/fix.ts' }, exec(repo.root, session)) as Record<string, unknown>
    expect(result.fixed).toBe(true)
    expect((result.remaining as Array<Record<string, unknown>>).map((item) => item.scope)).toEqual(['preexisting'])
    expect((result.resolved as Array<Record<string, unknown>>).map((item) => item.rule)).toEqual(['fresh-rule'])
    expect(result.baseline).toMatchObject({ introduced: 0, preexisting: 1, resolved: 1 })
  })

  it('treats a newly created file as an empty baseline', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = `${repo.root}/src/new.ts`
    applyConfig({ linterPath: { eslint: FAKE } })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    await repo.write('src/new.ts', 'const fresh = 1 // lint: error new-rule new file\n')
    const delta = classifyFindings(session, file, await managerForRoot(repo.root).lintFile(file))
    expect(delta.preexisting).toEqual([])
    expect(delta.introduced.map((item) => item.rule)).toEqual(['new-rule'])
  })

  it('keeps package-scoped batch results attached to each file baseline', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('.golangci.yml', 'linters:\n  enable: []\n')
    const main = await repo.write('main.go', 'package main\nvar old = 1 // lint: error old-go historical\n')
    const other = await repo.write('other.go', 'package main\nvar old = 2 // lint: error other-old historical\n')
    applyConfig({ linterPath: { golangci: FAKE } })
    const session = {}
    await prepareMutation(main, { agent: { session } })
    await prepareMutation(other, { agent: { session } })
    await repo.write('main.go', 'package main\nvar old = 1 // lint: error old-go historical\nvar fresh = 3 // lint: error main-new introduced\n')
    await repo.write('other.go', 'package main\nvar old = 2 // lint: error other-old historical\nvar fresh = 4 // lint: error other-new introduced\n')

    const manager = managerForRoot(repo.root)
    const batch = await manager.lintMany([main, other])
    const mainDelta = classifyFindings(session, main, batch.get(main) ?? [])
    const otherDelta = classifyFindings(session, other, batch.get(other) ?? [])
    expect(mainDelta.preexisting.map((item) => item.rule)).toEqual(['old-go'])
    expect(mainDelta.introduced.map((item) => item.rule)).toEqual(['main-new'])
    expect(otherDelta.preexisting.map((item) => item.rule)).toEqual(['other-old'])
    expect(otherDelta.introduced.map((item) => item.rule)).toEqual(['other-new'])
  })
})
