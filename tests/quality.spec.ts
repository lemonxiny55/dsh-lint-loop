import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownerFromActor } from '../src/baseline.js'
import { applyConfig, getConfig } from '../src/config.js'
import { invalidateProbes } from '../src/detect.js'
import { clearGateState, handleTurnEnded, handleTurnStopping, markDirty, steeringCountFor } from '../src/gate.js'
import { disposeAllManagers } from '../src/manager.js'
import { issueDelta, prepareQualityBaseline, verifyQuality, qualityReceipt, disposeQuality } from '../src/quality.js'
import { parseTestReport, parseTypecheck } from '../src/quality-checks.js'
import { discoverQualityPlan, selectImpactedTests } from '../src/quality-plan.js'
import { prepareMutation, recordSuccessfulToolMutation } from '../src/regression.js'
import { repairTurn } from '../src/repair.js'
import { tools } from '../src/tools.js'
import { qualityCallView, qualityResultView } from '../src/quality-view.js'
import { fakeLinterPath, makeFixtureRepo, type FixtureRepo } from './helpers/fixtures.js'

const FAKE = fakeLinterPath()
const fakeQuality = await readFile(new URL('./helpers/fakeQuality.mjs', import.meta.url), 'utf8')
afterEach(async () => { clearGateState(); disposeQuality(); await disposeAllManagers(); invalidateProbes(); applyConfig(); delete process.env.QUALITY_RUN_LOG })
async function packageAt(repo: FixtureRepo, prefix = '') {
  const p = (f: string) => prefix ? `${prefix}/${f}` : f
  await repo.write(p('package.json'), JSON.stringify({ type: 'module', scripts: { test: 'vitest run' } }))
  await repo.write(p('tsconfig.json'), '{}')
  await repo.write(p('node_modules/typescript/package.json'), '{"type":"module"}')
  await repo.write(p('node_modules/typescript/bin/tsc'), fakeQuality)
  await repo.write(p('node_modules/vitest/vitest.mjs'), fakeQuality)
}
async function fixture() {
  applyConfig({ linterPath: { eslint: FAKE }, qualityTimeoutMs: 10_000 })
  const repo = await makeFixtureRepo()
  await packageAt(repo)
  await repo.write('eslint.config.mjs', 'export default []')
  const file = await repo.write('src/a.ts', 'export const a = 1\n')
  await repo.write('tests/a.spec.ts', 'import { a } from "../src/a.js"\n// case: a PASS\n')
  await repo.write('src/b.ts', 'export const b = 1\n')
  await repo.write('tests/b.spec.ts', 'import { b } from "../src/b.js"\n// case: b PASS\n')
  const session = { id: `quality-${repo.root}`, header: { cwd: repo.root } }
  const actor = { agent: { session } }
  const owner = ownerFromActor(actor)!
  return { repo, file, actor, owner, session }
}
async function edit(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  await prepareMutation(f.file, f.actor)
  await f.repo.write('src/a.ts', text)
  await recordSuccessfulToolMutation(f.file, f.actor)
  markDirty(f.file, f.owner)
}

describe('Quality Loop evidence', () => {
  it.each(['error', 'cancelled'])('resets a %s turn without a stopping checkpoint and keeps its receipt', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2\n// type: TS2322 unfinished error\n')
    const agent = { id: 'interrupted', session: f.session, steer: vi.fn() }
    await handleTurnStopping({ agent, turn: 1 })
    const previous = qualityReceipt(f.repo.root, f.owner)!
    expect(previous.finalVerdict).toBe('regression')
    expect(steeringCountFor(agent.id, 1)).toBe(1)
    handleTurnEnded(f.session)
    expect(qualityReceipt(f.repo.root, f.owner)).toEqual(previous)
    expect(steeringCountFor(agent.id, 1)).toBe(0)
    await edit(f, 'export const a = 3\n// type: TS2322 unfinished error\n')
    const next = await verifyQuality(f.repo.root, f.owner)
    expect(next.finalVerdict).toBe('clean')
    expect(next.ignoredHistoricalDebt.map((i) => i.check)).toEqual(['typecheck:.'])
    expect(next.agentFixed).toEqual([])
    expect(next.repairRounds).toBe(0)
    expect(next.continuationRounds).toBe(0)
    await edit(f, 'export const a = 3\n// type: TS2322 unfinished error\n// type: TS2345 new error\n')
    await handleTurnStopping({ agent, turn: 2 })
    expect(agent.steer).toHaveBeenCalledTimes(2)
  })

  it('cancels in-flight evidence at turn end without overwriting the next receipt', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2\n')
    const previous = await verifyQuality(f.repo.root, f.owner)
    await f.repo.write('src/a.ts', 'export const a = 2\n// hang\n')
    const pending = verifyQuality(f.repo.root, f.owner)
    await vi.waitFor(async () => {
      const snapshot = qualityReceipt(f.repo.root, f.owner)
      expect(snapshot).toEqual(previous)
    })
    handleTurnEnded(f.session)
    expect((await pending).finalVerdict).toBe('cancelled')
    expect(qualityReceipt(f.repo.root, f.owner)).toEqual(previous)
    await f.repo.write('src/a.ts', 'export const a = 2\n')
    await edit(f, 'export const a = 3\n')
    expect((await verifyQuality(f.repo.root, f.owner)).finalVerdict).toBe('clean')
  })
  it('does not block historical lint, typecheck or test debt', async () => {
    const f = await fixture()
    await f.repo.write('src/a.ts', 'export const a = 1 // lint: error old old debt\n// type: TS2322 old type debt\n')
    await f.repo.write('tests/a.spec.ts', 'import { a } from "../src/a.js"\n// case: old FAIL old assertion\n// case: working PASS\n')
    await edit(f, '\nexport const a = 2 // lint: error old old debt\n// type: TS2322 old type debt\n')
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt).toMatchObject({ lint: 'clean', typecheck: 'clean', tests: 'clean', finalVerdict: 'clean', changedFiles: ['src/a.ts'] })
    expect(receipt.newlyIntroducedRegressions).toEqual([])
    expect(receipt.ignoredHistoricalDebt.map((i) => i.check).sort()).toEqual(['lint', 'tests:.', 'typecheck:.'])
    expect(receipt.selection).toMatchObject({ strategy: 'dependency', files: ['tests/a.spec.ts'] })
    expect(receipt.checksExecuted.find((c) => c.kind === 'tests')!.executed).toEqual(['tests/a.spec.ts|old', 'tests/a.spec.ts|working'])
    expect(receipt.checksExecuted.find((c) => c.kind === 'lint')!.invocations![0].command).toBe(process.execPath)
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt)
  })

  it('detects new typecheck and test failures, including a changed failure in an old test', async () => {
    const f = await fixture()
    await f.repo.write('tests/a.spec.ts', 'import { a } from "../src/a.js"\n// case: old FAIL old symptom\n')
    await edit(f, 'export const a = 2\n// type: TS2322 new type error\n')
    await f.repo.write('tests/a.spec.ts', 'import { a } from "../src/a.js"\n// case: old FAIL new symptom\n// case: fresh FAIL new assertion\n')
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.finalVerdict).toBe('regression')
    expect(receipt.newlyIntroducedRegressions.map((i) => i.check)).toEqual(['typecheck:.', 'tests:.', 'tests:.'])
    expect(receipt.ignoredHistoricalDebt).toEqual([])
  })

  it('detects replacing a historical type error with the same diagnostic on different source', async () => {
    const f = await fixture()
    await f.repo.write('src/a.ts', 'export const a = 1\nconst old = 1 // type: TS2322 wrong type\n')
    await edit(f, 'export const a = 2\nconst fresh = 2 // type: TS2322 wrong type\n')
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.typecheck).toBe('regression')
    expect(receipt.newlyIntroducedRegressions.map((i) => i.check)).toEqual(['typecheck:.'])
    expect(receipt.ignoredHistoricalDebt).toEqual([])
  })

  it('retains all files across bounded gate retries and reports agent-fixed regressions', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2\n// type: TS2322 new type error\n')
    const agent = { id: 'gate-quality', session: f.session, steer: vi.fn() }
    await handleTurnStopping({ agent, turn: 1 })
    await handleTurnStopping({ agent, turn: 1 }) // no fresh dirty event: still verifies this turn
    expect(agent.steer).toHaveBeenCalledTimes(2)
    await f.repo.write('src/a.ts', 'export const a = 2\n')
    await handleTurnStopping({ agent, turn: 1 })
    const receipt = qualityReceipt(f.repo.root, f.owner)!
    expect(receipt.finalVerdict).toBe('clean')
    expect(receipt.agentFixed.map((i) => i.check)).toEqual(['typecheck:.'])
    expect(receipt.changedFiles).toEqual(['src/a.ts'])
    expect(agent.steer).toHaveBeenCalledTimes(2)
  })

  it('does not count an unavailable lint check as an agent fix just because another file passed', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2 // lint: error new regression\n')
    await verifyQuality(f.repo.root, f.owner)
    const b = path.join(f.repo.root, 'src/b.ts')
    await prepareMutation(b, f.actor)
    await recordSuccessfulToolMutation(b, f.actor)
    await f.repo.write('src/a.ts', 'export const a = 2 // lint: broken\n')
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.lint).toBe('incomplete')
    expect(receipt.agentFixed).toEqual([])
  })

  it('never turns an exhausted repair budget into a clean verdict', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2\n// type: TS2322 still broken\n')
    const agent = { id: 'exhausted', session: f.session, steer: vi.fn() }
    for (let n = 0; n < 3; n++) await handleTurnStopping({ agent, turn: 1 })
    expect(agent.steer).toHaveBeenCalledTimes(2)
    expect(qualityReceipt(f.repo.root, f.owner)!.finalVerdict).toBe('regression')
  })

  it('records safe autofix without sweeping historical code and bounds repeated repair calls', async () => {
    const f = await fixture()
    await f.repo.write('src/a.ts', 'export const a = 1 // lint: error old debt\n')
    await edit(f, 'export const a = 2 // lint: error old debt\nconst fresh = 1 // lint: error new new regression [fixable]\n')
    const repair = await repairTurn(f.repo.root, f.owner)
    expect(repair.autoFixed).toHaveLength(1)
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.autoFixed).toHaveLength(1)
    expect(receipt.repairRounds).toBe(1)
    expect(receipt.agentFixed).toEqual([])
    expect(await readFile(f.file, 'utf8')).toContain('// lint: error old debt')
    await f.repo.write('src/a.ts', 'export const a = 2 // lint: error old debt\nconst fresh = 1 // lint: error new cannot fix\n')
    await repairTurn(f.repo.root, f.owner)
    expect((await repairTurn(f.repo.root, f.owner)).rounds).toBe(0)
  })

  it('guards lint_fix when an authoritative baseline has historical fixable debt', async () => {
    const f = await fixture()
    await f.repo.write('src/a.ts', 'export const a = 1 // lint: error old debt [fixable]\n')
    await edit(f, 'export const a = 2 // lint: error old debt [fixable]\nconst fresh = 1 // lint: error new new [fixable]\n')
    const before = await readFile(f.file, 'utf8')
    const result = await tools.find((t) => t.name === 'lint_fix')!.execute({ file_path: f.file }, f.actor as never) as { fixed: boolean }
    expect(result.fixed).toBe(false)
    expect(await readFile(f.file, 'utf8')).toBe(before)
  })

  it('marks missing pre-edit baselines and malformed evidence incomplete', async () => {
    const f = await fixture()
    expect((await verifyQuality(f.repo.root, f.owner, { files: [f.file] })).finalVerdict).toBe('incomplete')
    await edit(f, 'export const a = 2\n// invalid\n')
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.finalVerdict).toBe('incomplete')
    expect(receipt.tests).toBe('incomplete')
    expect(receipt.checksExecuted.filter((c) => c.kind !== 'lint').every((c) => c.status === 'failed')).toBe(true)
    expect(receipt.checksExecuted.find((c) => c.kind === 'typecheck')!.unparsedOutput).toEqual({ exitCode: 2, stdout: 'not a report\n', stderr: '' })
  })

  it('never blocks an old lint failure when the modern pre-edit probe was unavailable', async () => {
    const f = await fixture()
    await f.repo.write('src/a.ts', 'export const a = 1 // lint: error old debt\n// lint: broken\n')
    await edit(f, 'export const a = 2 // lint: error old debt\n')
    const before = await readFile(f.file, 'utf8')
    expect((await repairTurn(f.repo.root, f.owner)).stoppedBecause).toBe('baseline-unavailable')
    expect(await readFile(f.file, 'utf8')).toBe(before)
    const agent = { id: 'unknown-lint', session: f.session, steer: vi.fn() }
    await handleTurnStopping({ agent, turn: 1 })
    expect(agent.steer).not.toHaveBeenCalled()
    const receipt = qualityReceipt(f.repo.root, f.owner)!
    expect(receipt.lint).toBe('incomplete')
    expect(receipt.newlyIntroducedRegressions).toEqual([])
  })

  it('cancels running checks, kills the child, and leaves an honest receipt', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2\n// hang\n')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 250)
    const receipt = await verifyQuality(f.repo.root, f.owner, { signal: controller.signal })
    expect(receipt.finalVerdict).toBe('cancelled')
    expect(receipt.checksExecuted.some((c) => c.status === 'cancelled')).toBe(true)
    expect(receipt.elapsedMs).toBeLessThan(5000)
  })

  it('bounds the total completion budget and does not claim a timeout is clean', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2\n// hang\n')
    applyConfig({ linterPath: { eslint: FAKE }, qualityTimeoutMs: 1000 })
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.finalVerdict).toBe('incomplete')
    expect(receipt.elapsedMs).toBeLessThan(5000)
    expect(receipt.checksExecuted.some((c) => ['timeout', 'cancelled'].includes(c.status))).toBe(true)
  })

  it('disposes pending work and remounts with no stale baseline or receipt', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2\n// hang\n')
    const pending = verifyQuality(f.repo.root, f.owner)
    setTimeout(disposeQuality, 150)
    expect((await pending).finalVerdict).toBe('cancelled')
    expect(qualityReceipt(f.repo.root, f.owner)).toBeUndefined()
    await f.repo.write('src/a.ts', 'export const a = 3\n')
    await prepareQualityBaseline(f.repo.root, f.owner)
    expect((await verifyQuality(f.repo.root, f.owner)).finalVerdict).toBe('clean')
  })

  it('shares concurrent verification and returns detached receipt snapshots', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2\n')
    const [a, b] = await Promise.all([verifyQuality(f.repo.root, f.owner), verifyQuality(f.repo.root, f.owner)])
    expect(a).toEqual(b)
    a.changedFiles.length = 0
    expect(qualityReceipt(f.repo.root, f.owner)!.changedFiles).toEqual(['src/a.ts'])
  })

  it('renders the native Quality Bar with replayable receipt details and honest failure states', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2\n')
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(qualityCallView().title).toContain('running')
    const view = qualityResultView({}, { content: [{ type: 'text', text: JSON.stringify(receipt) }], isError: false })
    expect(view.title).toBe('Quality · clean · 1 changed · lint clean / types clean / tests clean')
    expect('content' in view && JSON.stringify(view.content)).toContain('Quality Receipt')
    expect(qualityResultView({}, { content: [{ type: 'text', text: JSON.stringify({ ...receipt, finalVerdict: 'incomplete' }) }], isError: false }).title).toContain('failed')
    expect(qualityResultView({}, { content: [], isError: true }).title).toBe('Quality · failed')
  })

  it('skips full checks explicitly in fast and preserves advanced overrides', async () => {
    const f = await fixture()
    applyConfig({ mode: 'fast', linterPath: { eslint: FAKE } })
    await edit(f, 'export const a = 2\n')
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt).toMatchObject({ mode: 'fast', typecheck: 'skipped', tests: 'skipped', finalVerdict: 'incomplete' })
    applyConfig({ mode: 'strict', completionChecks: false, qualityTimeoutMs: 7000, gateMaxSteers: 1 })
    expect(getConfig()).toMatchObject({ mode: 'strict', completionChecks: false, qualityTimeoutMs: 7000, gateMaxSteers: 1 })
    applyConfig({ mode: 'bogus' as never, qualityMaxFiles: -1, qualityMaxChecks: 0 })
    expect(getConfig()).toMatchObject({ mode: 'balanced', qualityMaxFiles: 2000, qualityMaxChecks: 32 })
  })
})

describe('impacted tests and protocol boundaries', () => {
  it('follows transitive imports and excludes unrelated tests', async () => {
    const f = await fixture()
    await f.repo.write('src/reexport.ts', 'export { a } from "./a.js"')
    await f.repo.write('tests/transitive.spec.ts', 'import { a } from "../src/reexport.js"\n// case: transitive PASS')
    const selection = await selectImpactedTests(await discoverQualityPlan(f.repo.root), [f.file])
    expect(selection.strategy).toBe('dependency')
    expect(selection.files.map((p) => path.basename(p))).toEqual(['a.spec.ts', 'transitive.spec.ts'])
  })
  it('runs changed tests directly and falls back for unknown source relationships', async () => {
    const f = await fixture()
    const plan = await discoverQualityPlan(f.repo.root)
    expect((await selectImpactedTests(plan, [path.join(f.repo.root, 'tests/a.spec.ts')])).files).toEqual([path.join(f.repo.root, 'tests/a.spec.ts')])
    const orphan = await f.repo.write('src/orphan.ts', 'export const orphan = 1')
    expect((await selectImpactedTests(await discoverQualityPlan(f.repo.root), [orphan])).strategy).toBe('package-fallback')
    expect((await selectImpactedTests(plan, [path.join(f.repo.root, 'tsconfig.json')])).strategy).toBe('repository-fallback')
  })
  it('falls back for dynamic imports and unrecognized aliases', async () => {
    const f = await fixture()
    await f.repo.write('src/dynamic.ts', 'const dynamic = import(variable)')
    expect((await selectImpactedTests(await discoverQualityPlan(f.repo.root), [f.file])).strategy).toBe('repository-fallback')
    await f.repo.write('src/dynamic.ts', 'import { a } from "@workspace/core"')
    expect((await selectImpactedTests(await discoverQualityPlan(f.repo.root), [f.file])).strategy).toBe('repository-fallback')
  })
  it('scopes monorepo fallbacks to changed packages and expands cross-package dependencies', async () => {
    const repo = await makeFixtureRepo()
    await packageAt(repo, 'packages/a'); await packageAt(repo, 'packages/b')
    const a = await repo.write('packages/a/src/orphan.ts', 'export const a = 1')
    await repo.write('packages/a/tests/a.spec.ts', '// case: a PASS')
    await repo.write('packages/b/tests/b.spec.ts', '// case: b PASS')
    let selection = await selectImpactedTests(await discoverQualityPlan(repo.root), [a])
    expect(selection.strategy).toBe('package-fallback')
    expect(selection.files.map((p) => path.basename(p))).toEqual(['a.spec.ts'])
    await repo.write('packages/b/tests/b.spec.ts', 'import { a } from "@workspace/a"\n// case: b PASS')
    selection = await selectImpactedTests(await discoverQualityPlan(repo.root), [a])
    expect(selection.strategy).toBe('repository-fallback')
    expect(selection.files).toHaveLength(2)
  })

  it('executes the Jest adapter in a package path containing spaces', async () => {
    const repo = await makeFixtureRepo()
    await packageAt(repo, 'packages/a space')
    await repo.write('packages/a space/package.json', '{"type":"module","scripts":{"test":"jest --runInBand"}}')
    await repo.write('packages/a space/node_modules/jest/package.json', '{"type":"module"}')
    await repo.write('packages/a space/node_modules/jest/bin/jest.js', fakeQuality)
    const file = await repo.write('packages/a space/src/a.ts', 'export const a = 1')
    await repo.write('packages/a space/tests/a.spec.ts', 'import { a } from "../src/a.js"\n// case: a PASS')
    const owner = 'jest-package'
    await prepareQualityBaseline(repo.root, owner)
    const receipt = await verifyQuality(repo.root, owner, { files: [file] })
    const check = receipt.checksExecuted.find((c) => c.kind === 'tests')!
    expect(check.scope).toBe('packages/a space')
    expect(check.status).toBe('complete')
    expect(check.args.slice(1)).toEqual(['--runInBand', '--json', '--runTestsByPath', path.join(repo.root, 'packages/a space/tests/a.spec.ts')])
    expect(check.executed).toEqual(['tests/a.spec.ts|a'])
  })
  it('reports discovery/check budget exhaustion and unsupported custom runners', async () => {
    const f = await fixture()
    applyConfig({ qualityMaxFiles: 1 })
    expect((await discoverQualityPlan(f.repo.root)).complete).toBe(false)
    applyConfig({ linterPath: { eslint: FAKE }, qualityMaxChecks: 1 })
    await edit(f, 'export const a = 2\n')
    expect((await verifyQuality(f.repo.root, f.owner)).finalVerdict).toBe('incomplete')
    await f.repo.write('package.json', '{"scripts":{"test":"custom-test-wrapper"}}')
    const plan = await discoverQualityPlan(f.repo.root)
    expect(plan.scopes[0].testEntry).toBeUndefined()
  })
  it('normalizes Windows diagnostic paths, tracks duplicate debt and rejects unparsed failures', () => {
    expect(parseTypecheck('src\\a.ts(10,2): error TS2322: wrong type\n')).toEqual(['src/a.ts|TS2322|wrong type'])
    expect(issueDelta(['same'], ['same', 'same'])).toEqual({ introduced: ['same'], historical: ['same'] })
    expect(parseTypecheck('compiler crashed')).toBeNull()
    expect(parseTestReport('{"testResults":[],"numTotalTests":0}', process.cwd())).toBeNull()
  })
})
