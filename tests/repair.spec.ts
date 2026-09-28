import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { clearAllBaselines, classifyFindings, ensureBaseline } from '../src/baseline.js'
import { applyConfig } from '../src/config.js'
import { invalidateProbes } from '../src/detect.js'
import { disposeAllManagers, managerForRoot } from '../src/manager.js'
import { REPAIR_MAX_ROUNDS, repairStatus, repairTurn } from '../src/repair.js'
import { prepareMutation, recordSuccessfulToolMutation } from '../src/regression.js'
import { tools } from '../src/tools.js'
import { fakeLinterPath, makeFixtureRepo } from './helpers/fixtures.js'

const FAKE = fakeLinterPath()
const lintRepair = tools.find((tool) => tool.name === 'lint_repair')!

function expectLosslessJson(value: unknown, location = 'receipt'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    expect(Number.isFinite(value), location).toBe(true)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectLosslessJson(item, `${location}[${index}]`))
    return
  }
  expect(value && typeof value === 'object', location).toBe(true)
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    expect(item, `${location}.${key}`).not.toBeUndefined()
    expectLosslessJson(item, `${location}.${key}`)
  }
}

afterEach(async () => {
  clearAllBaselines()
  await disposeAllManagers()
  invalidateProbes()
  applyConfig()
  delete process.env.FAKE_FIX_INTRODUCES
  delete process.env.FAKE_FIX_BREAKS
  delete process.env.FAKE_PACKAGE_TOUCH_OTHER
  delete process.env.FAKE_RUN_LOG
})

describe('lint_repair turn scope', () => {
  it('does not expand turn scope from tool-established baselines alone', async () => {
    const repo = await makeFixtureRepo()
    const file = await repo.write('src/observed.ts', 'const broken = 1 // lint: error old issue\n')
    const session = {}
    ensureBaseline(session, file, [])
    const receipt = await repairTurn(repo.root, session)
    expect(receipt.stoppedBecause).toBe('no-turn-files')
    expect(receipt.regressionsFound).toEqual([])
  })

  it('refreshes the current turn in lint_status and labels old debt separately', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/status.ts', 'const old = 1 // lint: error old-rule historical debt\n')
    applyConfig({ linterPath: { eslint: FAKE } })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    await repo.write('src/status.ts', 'const old = 1 // lint: error old-rule historical debt\nconst fresh = 2 // lint: error new-rule new regression\n')
    await recordSuccessfulToolMutation(file, { agent: { session } })

    const status = await repairStatus(repo.root, session)
    expect(status.files).toEqual(['src/status.ts'])
    expect(status.introducedOrChanged.map((f) => f.rule)).toEqual(['new-rule'])
    expect(status.preExistingIgnored.map((f) => f.rule)).toEqual(['old-rule'])
  })

  it('fixes only introduced regressions and reports ignored historical debt', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/edited.ts', 'const old = 1 // lint: error old-rule old debt\n')
    const untouched = await repo.write('src/untouched.ts', 'const legacy = 1 // lint: error legacy-rule old workspace debt\n')
    applyConfig({ linterPath: { eslint: FAKE } })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    await repo.write('src/edited.ts', 'const old = 1 // lint: error old-rule old debt\nconst fresh = 2 // lint: error new-rule introduced [fixable]\n')
    await recordSuccessfulToolMutation(file, { agent: { session } })

    const execute = lintRepair.execute as (args: unknown, ctx: unknown) => Promise<Record<string, unknown>>
    const receipt = await execute({ scope: 'turn' }, { agent: { session: Object.assign(session, { header: { cwd: repo.root } }) } })
    expectLosslessJson(receipt)
    expect(receipt).toMatchObject({ scope: 'turn', rounds: 1, stoppedBecause: 'clean' })
    expect((receipt.regressionsFound as unknown[])).toHaveLength(1)
    expect((receipt.autoFixed as unknown[])).toHaveLength(1)
    expect(receipt.remaining).toEqual([])
    expect((receipt.preExistingIssuesIgnored as Array<Record<string, unknown>>).map((f) => f.rule)).toEqual(['old-rule'])
    expect(receipt.affectedFiles).toEqual(['src/edited.ts'])
    expect((receipt.fixerRuns as Array<Record<string, unknown>>)[0]).toMatchObject({
      linter: 'eslint', modifiedFiles: ['src/edited.ts'], changedFiles: ['src/edited.ts'], rolledBackFiles: [],
    })
    expect(await readFile(untouched, 'utf8')).toContain('legacy-rule')
  })

  it('transactionally rolls back a file-local fixer that adds a new finding', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/unsafe.ts', 'const clean = 1\n')
    applyConfig({ linterPath: { eslint: FAKE } })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    await repo.write('src/unsafe.ts', 'const fresh = 1 // lint: error original original regression [fixable]\n')
    await recordSuccessfulToolMutation(file, { agent: { session } })
    process.env.FAKE_FIX_INTRODUCES = '1'

    const receipt = await repairTurn(repo.root, session)
    expect(receipt.fixerIntroducedRegressions.map((f) => f.rule)).toContain('fixer-regression')
    expect(receipt.fixerRuns[0].modifiedFiles).toEqual(['src/unsafe.ts'])
    expect(receipt.fixerRuns[0].rolledBackFiles).toEqual(['src/unsafe.ts'])
    expect(receipt.fixerRuns[0].changedFiles).toEqual([])
    expect(await readFile(file, 'utf8')).toContain('original regression [fixable]')
    expect(receipt.remaining.map((f) => f.rule)).toEqual(['original'])
    expect(receipt.stoppedBecause).toBe('no-progress')
    expect(receipt.rounds).toBeLessThanOrEqual(REPAIR_MAX_ROUNDS)
  })

  it('skips a file-local fixer when it would sweep up historical auto-fixable debt', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/historical.ts', 'const old = 1 // lint: error old-rule old debt [fixable]\n')
    applyConfig({ linterPath: { eslint: FAKE } })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    await repo.write('src/historical.ts', 'const old = 1 // lint: error old-rule old debt [fixable]\nconst fresh = 2 // lint: error new-rule regression [fixable]\n')
    await recordSuccessfulToolMutation(file, { agent: { session } })

    const receipt = await repairTurn(repo.root, session)
    expect(receipt.remaining.map((f) => f.rule)).toEqual(['new-rule'])
    expect(receipt.preExistingIssuesIgnored.map((f) => f.rule)).toEqual(['old-rule'])
    expect(receipt.fixerRuns[0].modifiedFiles).toEqual([])
    expect(receipt.skippedFixers[0]).toContain('broad fixer skipped')
    expect(await readFile(file, 'utf8')).toContain('old-rule old debt [fixable]')
    expect(await readFile(file, 'utf8')).toContain('new-rule regression [fixable]')
  })

  it('restores a file-local fixer result that cannot be re-linted', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/unverifiable.ts', 'const clean = 1\n')
    applyConfig({ linterPath: { eslint: FAKE } })
    const session = {}
    await prepareMutation(file, { agent: { session } })
    const edited = 'const fresh = 1 // lint: error original regression [fixable]\n'
    await repo.write('src/unverifiable.ts', edited)
    await recordSuccessfulToolMutation(file, { agent: { session } })
    process.env.FAKE_FIX_BREAKS = '1'

    const receipt = await repairTurn(repo.root, session)
    expect(receipt.fixerRuns[0].rolledBackFiles).toEqual(['src/unverifiable.ts'])
    expect(receipt.fixerErrors.join('\n')).toContain('post-fix lint verification failed')
    expect(await readFile(file, 'utf8')).toBe(edited)
    expect(receipt.remaining.map((f) => f.rule)).toEqual(['original'])
  })

  it('does not run a package fixer that could clean unrelated pre-existing debt', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('.golangci.yml', 'linters:\n  enable: []\n')
    const edited = await repo.write('main.go', 'package main\nvar old = 1 // lint: error old-go historical\n')
    const neighbor = await repo.write('other.go', 'package main\nvar fixable = 2 // lint: warning fixable neighbor warning [fixable]\n')
    applyConfig({ linterPath: { golangci: FAKE } })
    const session = {}
    await prepareMutation(edited, { agent: { session } })
    await repo.write('main.go', 'package main\nvar old = 1 // lint: error old-go historical\nvar fresh = 3 // lint: error new-go regression [fixable]\n')
    await recordSuccessfulToolMutation(edited, { agent: { session } })

    const receipt = await repairTurn(repo.root, session)
    expect(receipt.remaining.map((f) => f.rule)).toEqual(['new-go'])
    expect(receipt.preExistingIssuesIgnored.map((f) => f.rule).sort()).toEqual(['fixable', 'old-go'])
    expect(receipt.fixerRuns[0].linter).toBe('golangci')
    expect(receipt.fixerRuns[0].attemptedFiles).toEqual(['main.go'])
    expect(receipt.fixerRuns[0].modifiedFiles).toEqual([])
    expect(receipt.skippedFixers[0]).toContain('broad fixer skipped')
    expect(await readFile(neighbor, 'utf8')).toContain('[fixable]')
    const current = await managerForRoot(repo.root).lintFile(edited)
    expect(classifyFindings(session, edited, current).preexisting.map((f) => f.rule)).toEqual(['old-go'])
  })

  it('reports every file changed by a safe package fixer batch', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('.golangci.yml', 'linters:\n  enable: []\n')
    const edited = await repo.write('main.go', 'package main\nvar value = 1\n')
    const neighbor = await repo.write('other.go', 'package main\nvar other = 2\n')
    applyConfig({ linterPath: { golangci: FAKE } })
    const session = {}
    await prepareMutation(edited, { agent: { session } })
    await repo.write('main.go', 'package main\nvar value = 1 // lint: error new-go regression [fixable]\n')
    await recordSuccessfulToolMutation(edited, { agent: { session } })
    process.env.FAKE_PACKAGE_TOUCH_OTHER = '1'

    const receipt = await repairTurn(repo.root, session)
    expect(receipt.remaining).toEqual([])
    expect(receipt.fixerRuns[0].modifiedFiles).toContain('main.go')
    expect(receipt.fixerRuns[0].modifiedFiles).toContain('other.go')
    expect(receipt.fixerRuns[0].changedFiles).toContain('other.go')
    expect(receipt.affectedFiles).toContain('other.go')
    expect(await readFile(neighbor, 'utf8')).toContain('touched by package fixer')
  })
})
