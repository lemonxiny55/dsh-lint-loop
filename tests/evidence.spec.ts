import path from 'node:path'
import { access, chmod, mkdir, readFile, rename, rm, symlink } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { apply } from '../src/index.js'
import { ownerFromActor, turnEditedFiles } from '../src/baseline.js'
import { applyConfig } from '../src/config.js'
import { auditCoverage, beginCheckpoint, endCheckpoint, snapshotWorkspace, snapshotChanges, snapshotDigest } from '../src/evidence.js'
import { clearGateState, handleTurnEnded } from '../src/gate.js'
import { disposeAllManagers, managerForRoot } from '../src/manager.js'
import { currentQualityReceipt, prepareQualityBaseline, qualityReceipt, verifyQuality } from '../src/quality.js'
import { staticImpactProvider } from '../src/quality-plan.js'
import { prepareMutation, recordSuccessfulToolMutation } from '../src/regression.js'
import { repairTurn } from '../src/repair.js'
import { runProcess } from '../src/runner.js'
import { tools } from '../src/tools.js'
import { fakeLinterPath, makeFixtureRepo } from './helpers/fixtures.js'

const fakeQuality = await readFile(new URL('./helpers/fakeQuality.mjs', import.meta.url), 'utf8')
afterEach(async () => { clearGateState(); await disposeAllManagers(); applyConfig(); vi.restoreAllMocks() })
async function fixture(git = true) {
  const repo = await makeFixtureRepo()
  if (!git) await rm(path.join(repo.root, '.git'), { recursive: true })
  await repo.write('package.json', '{"type":"module","scripts":{"test":"vitest run"}}')
  await repo.write('eslint.config.mjs', 'export default []')
  await repo.write('tsconfig.json', '{}')
  await repo.write('node_modules/typescript/package.json', '{"type":"module"}')
  await repo.write('node_modules/typescript/bin/tsc', fakeQuality)
  await repo.write('node_modules/vitest/vitest.mjs', fakeQuality)
  const file = await repo.write('src/a.ts', 'export const a = 1\n// lint: error old historical debt\n')
  await repo.write('tests/a.spec.ts', 'import { a } from "../src/a.js"\n// case: a PASS\n')
  const actor = { agent: { session: { id: repo.root, header: { cwd: repo.root } } } }
  applyConfig({ linterPath: { eslint: fakeLinterPath() } })
  return { repo, file, actor, owner: ownerFromActor(actor)! }
}
function mount() {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  let dispose: (() => void) | undefined
  apply({
    effect(fn) { dispose = fn() || undefined }, tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    on(name, listener) { listeners.set(name, listener); return () => {} },
  }, { autoInject: false, linterPath: { eslint: fakeLinterPath() } })
  return { execute: listeners.get('tools/execute')!, dispose: () => dispose?.() }
}
async function edit(f: Awaited<ReturnType<typeof fixture>>, content = 'export const a = 2\n// lint: error old historical debt\n') {
  await prepareMutation(f.file, f.actor)
  await f.repo.write('src/a.ts', content)
  await recordSuccessfulToolMutation(f.file, f.actor)
}
describe('bounded read-only evidence', () => {
  it.each([true, false])('preserves pre-existing dirty bytes with git=%s and proves direct edits', async (git) => {
    const f = await fixture(git)
    const old = await f.repo.write('dirty.txt', 'pre-existing unsaved work')
    const alias = process.platform === 'win32' ? f.repo.root.toUpperCase() : path.join(f.repo.root, '.')
    const physical = await snapshotWorkspace(f.repo.root), aliased = await snapshotWorkspace(alias)
    expect(aliased.complete).toBe(true)
    expect(snapshotDigest(aliased)).toBe(snapshotDigest(physical))
    await edit(f)
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.finalVerdict).toBe('clean')
    expect(receipt.evidenceCoverage.status).toBe('complete')
    expect(receipt.changedFiles).toEqual(['src/a.ts'])
    expect(receipt.evidenceCoverage.changes[0]).toMatchObject({ file: 'src/a.ts', attribution: 'tool-target', operation: 'modified' })
    expect(receipt.evidenceCoverage.changes[0].before).not.toBe(receipt.evidenceCoverage.changes[0].after)
    expect(await readFile(old, 'utf8')).toBe('pre-existing unsaved work')
    expect(receipt.ignoredHistoricalDebt).toHaveLength(1)
  })
  it('covers additions, deletions, cross-directory renames and mode changes without Git', async () => {
    const f = await fixture(false)
    const before = await snapshotWorkspace(f.repo.root)
    await mkdir(path.join(f.repo.root, 'other'))
    await rename(f.file, path.join(f.repo.root, 'other/renamed.ts'))
    await f.repo.write('new.txt', 'new')
    const changes = snapshotChanges(before, await snapshotWorkspace(f.repo.root))
    expect(changes.map(({ file, operation }) => ({ file, operation }))).toEqual([
      { file: 'new.txt', operation: 'added' }, { file: 'other/renamed.ts', operation: 'added' }, { file: 'src/a.ts', operation: 'deleted' },
    ])
    expect(snapshotDigest(before)).toMatch(/^[a-f0-9]{64}$/)
  })
  it('establishes an authoritative empty lint baseline for a genuinely new direct-write target', async () => {
    const f = await fixture(false)
    const created = path.join(f.repo.root, 'src/created.ts')
    await prepareMutation(created, f.actor)
    await f.repo.write('src/created.ts', 'export const created = 1\n')
    await recordSuccessfulToolMutation(created, f.actor)
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.finalVerdict).toBe('clean')
    expect(receipt.evidenceCoverage.changes[0]).toMatchObject({ file: 'src/created.ts', operation: 'added', attribution: 'tool-target' })
  })
  it('does not blame or repair concurrent external changes during a direct call', async () => {
    const f = await fixture()
    await prepareMutation(f.file, f.actor)
    await f.repo.write('src/a.ts', 'export const a = 2\n// lint: error fresh new [fixable]\n')
    const external = await f.repo.write('external.ts', '// type: TS2322 external modification\n')
    await recordSuccessfulToolMutation(f.file, f.actor)
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.finalVerdict).toBe('incomplete')
    expect(receipt.newlyIntroducedRegressions).toEqual([])
    expect(receipt.unattributedFindings.length).toBeGreaterThan(0)
    expect(receipt.changedFiles).toEqual(['external.ts', 'src/a.ts'])
    expect(turnEditedFiles(f.owner)).toEqual([f.file])
    expect((await repairTurn(f.repo.root, f.owner)).stoppedBecause).toBe('baseline-unavailable')
    expect(await readFile(external, 'utf8')).toContain('external modification')
  })
  it('connects the baseline to the first dispatch instead of blaming an intervening writer', async () => {
    const f = await fixture()
    await prepareQualityBaseline(f.repo.root, f.owner)
    await f.repo.write('src/a.ts', 'export const a = 1\n// type: TS2322 external before dispatch\n')
    await edit(f, 'export const a = 2\n// type: TS2322 external before dispatch\n')
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.finalVerdict).toBe('incomplete')
    expect(receipt.newlyIntroducedRegressions).toEqual([])
    expect(receipt.evidenceCoverage.reasons).toContain('workspace changed outside an observed execution')
  })
  it('does not credit an external repair or reuse a stale CLEAN receipt', async () => {
    const f = await fixture()
    await edit(f, 'export const a = 2\n// type: TS2322 new error\n')
    expect((await verifyQuality(f.repo.root, f.owner)).finalVerdict).toBe('regression')
    await f.repo.write('src/a.ts', 'export const a = 1\n')
    const receipt = await verifyQuality(f.repo.root, f.owner)
    expect(receipt.finalVerdict).toBe('incomplete')
    expect(receipt.agentFixed).toEqual([])
    expect(receipt.evidenceCoverage.changes.at(-1)).toMatchObject({ attribution: 'unattributed', tool: 'between-checkpoints' })
  })
  it('invalidates a saved CLEAN receipt before a new verification runs', async () => {
    const f = await fixture()
    await edit(f)
    expect((await verifyQuality(f.repo.root, f.owner)).finalVerdict).toBe('clean')
    await f.repo.write('src/a.ts', 'external write')
    expect((await currentQualityReceipt(f.repo.root, f.owner))!.finalVerdict).toBe('incomplete')
    expect(qualityReceipt(f.repo.root, f.owner)!.finalVerdict).toBe('clean') // historical immutable evidence
  })
  it('refuses CLEAN when files change during the final verification sweep', async () => {
    const f = await fixture()
    await edit(f)
    const receipt = await verifyQuality(f.repo.root, f.owner, { provider: { async select(plan, files) {
      await f.repo.write('concurrent.txt', 'changed during checks')
      return staticImpactProvider.select(plan, files)
    } } })
    expect(receipt.finalVerdict).toBe('incomplete')
    expect(receipt.evidenceCoverage.reasons.join(' ')).toContain('throughout verification')
  })
  it('rejects symlinks and never modifies their targets', async () => {
    const f = await fixture(), outside = await makeFixtureRepo()
    const external = await outside.write('a.ts', 'external bytes')
    await symlink(outside.root, path.join(f.repo.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const snapshot = await snapshotWorkspace(f.repo.root)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.files.has('linked/a.ts')).toBe(false)
    await expect(managerForRoot(f.repo.root).fixFile(path.join(f.repo.root, 'linked/a.ts'))).rejects.toThrow(/symlink/)
    expect(await readFile(external, 'utf8')).toBe('external bytes')
  })
  it('records real OS permission denial without changing workspace permissions', async () => {
    const f = await fixture()
    if (process.platform !== 'win32') {
      await chmod(f.file, 0)
      try { expect((await snapshotWorkspace(f.repo.root)).complete).toBe(false) }
      finally { await chmod(f.file, 0o600) }
    } else {
      const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[0-9-]+/)![0]
      execFileSync('icacls', [f.file, '/deny', `*${sid}:(R)`])
      try {
        const snapshot = await snapshotWorkspace(f.repo.root)
        expect(snapshot.complete).toBe(false)
        expect(snapshot.reasons.join(' ')).toContain('unreadable')
      } finally { execFileSync('icacls', [f.file, '/remove:d', `*${sid}`]) }
    }
  })
  it.each(['entries', 'bytes', 'file-bytes', 'cancel'])('fails closed on %s budget exhaustion', async (budget) => {
    const f = await fixture()
    if (budget === 'entries') applyConfig({ qualityMaxFiles: 1 })
    if (budget === 'bytes') applyConfig({ trackingMaxBytes: 1 })
    if (budget === 'file-bytes') applyConfig({ trackingMaxFileBytes: 1 })
    const controller = new AbortController()
    if (budget === 'cancel') controller.abort()
    const snapshot = await snapshotWorkspace(f.repo.root, controller.signal)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.reasons.length).toBeGreaterThan(0)
    expect(snapshot.bytes).toBeLessThanOrEqual(budget === 'bytes' ? 1 : 32 * 1024 * 1024)
  })
  it('marks overlapping executions uncertain and isolates sessions/workspaces', async () => {
    const f = await fixture(), other = await fixture()
    const a = await beginCheckpoint(f.repo.root, f.owner, 'edit', f.file)
    const b = await beginCheckpoint(f.repo.root, 'other-session', 'bash')
    const overlap = await beginCheckpoint(f.repo.root, f.owner, 'edit', f.file)
    await f.repo.write('src/a.ts', 'export const a = 3')
    await endCheckpoint(overlap, 'success'); await endCheckpoint(a, 'success'); await endCheckpoint(b, 'success')
    expect((await auditCoverage(f.repo.root, f.owner)).status).toBe('incomplete')
    await edit(other)
    expect((await verifyQuality(other.repo.root, other.owner)).finalVerdict).toBe('clean')
    expect((await auditCoverage(other.repo.root, f.owner)).changes).toEqual([])
  })
  it('isolates checkpoints for two real Git worktrees sharing one session id', async () => {
    const f = await fixture()
    const git = (args: string[]) => execFileSync('git', args, { cwd: f.repo.root, windowsHide: true, stdio: 'pipe' })
    git(['init', '--quiet'])
    git(['add', 'src/a.ts'])
    git(['-c', 'user.name=Evidence Fixture', '-c', 'user.email=evidence@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
    const worktree = f.repo.root + '-worktree'
    git(['worktree', 'add', '--detach', worktree, 'HEAD'])
    try {
      const a = await beginCheckpoint(f.repo.root, f.owner, 'edit', f.file)
      const otherFile = path.join(worktree, 'src/a.ts')
      const b = await beginCheckpoint(worktree, f.owner, 'edit', otherFile)
      await f.repo.write('src/a.ts', 'first worktree')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(otherFile, 'second worktree')
      await endCheckpoint(a, 'success'); await endCheckpoint(b, 'success')
      expect((await auditCoverage(f.repo.root, f.owner)).status).toBe('complete')
      expect((await auditCoverage(worktree, f.owner)).status).toBe('complete')
      expect(await readFile(f.file, 'utf8')).toBe('first worktree')
      expect(await readFile(otherFile, 'utf8')).toBe('second worktree')
    } finally {
      // These are newly created test fixtures. Do not run worktree remove/reset on user checkouts.
      await rm(worktree, { recursive: true, force: true })
    }
  })
  it('disposes in-flight checkpoints and retains final receipt only through turn/end', async () => {
    const f = await fixture()
    await edit(f)
    const receipt = await verifyQuality(f.repo.root, f.owner)
    const pending = await beginCheckpoint(f.repo.root, f.owner, 'bash')
    handleTurnEnded(f.actor.agent.session)
    await endCheckpoint(pending, 'cancelled')
    expect(qualityReceipt(f.repo.root, f.owner)).toEqual(receipt)
    await edit(f, 'export const a = 4')
    expect((await verifyQuality(f.repo.root, f.owner)).finalVerdict).toBe('clean')
  })
  it('does not report CLEAN with no tracked mutation or an out-of-root request', async () => {
    const f = await fixture()
    await prepareQualityBaseline(f.repo.root, f.owner)
    expect((await verifyQuality(f.repo.root, f.owner)).finalVerdict).toBe('incomplete')
    await edit(f)
    const receipt = await verifyQuality(f.repo.root, f.owner, { files: ['../escape.ts'] })
    expect(receipt.finalVerdict).toBe('incomplete')
    expect(receipt.evidenceCoverage.reasons).toContain('requested file outside workspace scope')
  })
  it('requires canonical commit bytes and rejects concurrent overwrite of the same target', async () => {
    const f = await fixture(), mounted = mount()
    try {
      const before = await readFile(f.file, 'utf8')
      const after = 'export const a = 2\n'
      await mounted.execute({ ...f.actor, name: 'edit', arguments: { file_path: 'src/a.ts' } }, async () => {
        await f.repo.write('src/a.ts', after)
        // A concurrent writer wins after the tool committed its own bytes.
        await f.repo.write('src/a.ts', '// type: TS2322 external writer\n')
        return { isError: false, value: { path: f.file, before, after }, content: [] }
      })
      const receipt = await verifyQuality(f.repo.root, f.owner)
      expect(receipt.finalVerdict).toBe('incomplete')
      expect(receipt.newlyIntroducedRegressions).toEqual([])
      expect(receipt.evidenceCoverage.reasons.join(' ')).toContain('canonical commit bytes disagree')
      expect((await repairTurn(f.repo.root, f.owner)).stoppedBecause).toBe('baseline-unavailable')
    } finally { mounted.dispose() }
  })
  it('uses tools/result when a post-dispatch policy fails after a successful file commit', async () => {
    const f = await fixture()
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    let dispose: (() => void) | undefined
    apply({ effect(fn) { dispose = fn() || undefined }, tools: { register() { return () => {} } }, systemPrompt: { section() { return () => {} } },
      on(name, fn) { listeners.set(name, fn); return () => {} },
    }, { autoInject: false, linterPath: { eslint: fakeLinterPath() } })
    const execution = { ...f.actor, name: 'edit', arguments: { file_path: 'src/a.ts' } }
    const before = await readFile(f.file, 'utf8'), after = 'export const a = 3\n'
    try {
      await listeners.get('tools/execute')!(execution, async () => {
        await f.repo.write('src/a.ts', after)
        return { isError: false, value: { path: f.file, before, after } }
      })
      listeners.get('tools/result')!(execution, { isError: true })
      const receipt = await verifyQuality(f.repo.root, f.owner)
      expect(receipt.finalVerdict).toBe('incomplete')
      expect(receipt.evidenceCoverage.changes[0]).toMatchObject({ attribution: 'unattributed', outcome: 'failure' })
      expect(await readFile(f.file, 'utf8')).toBe(after)
    } finally { dispose?.() }
  })
  it('bounds accumulated event records', async () => {
    const f = await fixture()
    applyConfig({ qualityMaxFiles: 12, completionChecks: false })
    for (let i = 0; i < 14; i++) {
      const checkpoint = await beginCheckpoint(f.repo.root, f.owner, 'edit', f.file)
      await f.repo.write('src/a.ts', String(i))
      await endCheckpoint(checkpoint, 'success')
    }
    const coverage = await auditCoverage(f.repo.root, f.owner)
    expect(coverage.changes.length).toBeLessThanOrEqual(12)
    expect(coverage.reasons).toContain('change evidence event budget exceeded')
  })
})

describe('real shell execution windows', () => {
  const shells = process.platform === 'win32'
    ? [['pwsh', 'pwsh', '-NoProfile'], ['bash', 'C:/Program Files/Git/bin/bash.exe', '-c'], ['shell', 'pwsh', '-NoProfile']]
    : [['bash', 'bash', '-c'], ['shell', 'bash', '-c'], ['pwsh', 'pwsh', '-NoProfile']]
  for (const [tool, binary, flag] of shells) it.each(['success', 'failure', 'cancelled'])(`${tool} preserves effects after %s`, async (outcome) => {
    const f = await fixture(), mounted = mount(), controller = new AbortController()
    const script = binary.includes('pwsh')
      ? `Set-Content -LiteralPath './created.ts' -Value 'export const created = 1'; ${outcome === 'cancelled' ? 'Start-Sleep -Seconds 20' : outcome === 'failure' ? 'exit 7' : 'exit 0'}`
      : `printf 'export const created = 1' > created.ts; ${outcome === 'cancelled' ? 'sleep 20' : outcome === 'failure' ? 'exit 7' : 'exit 0'}`
    const execution = { ...f.actor, name: tool, arguments: { command: script }, signal: controller.signal }
    let poll: ReturnType<typeof setInterval> | undefined, fallback: ReturnType<typeof setTimeout> | undefined
    try {
      await mounted.execute(execution, async () => {
        if (outcome === 'cancelled') {
          poll = setInterval(() => { void access(path.join(f.repo.root, 'created.ts')).then(() => controller.abort()).catch(() => {}) }, 50)
          fallback = setTimeout(() => controller.abort(), 10000)
        }
        const args = flag === '-NoProfile' ? [flag, '-Command', script] : [flag, script]
        const result = await runProcess(binary, args, { cwd: f.repo.root, timeoutMs: 15000, signal: controller.signal })
        clearInterval(poll); clearTimeout(fallback)
        expect(result.spawnError).toBeUndefined()
        if (outcome === 'cancelled') expect(result.cancelled).toBe(true)
        else expect(result.exitCode).toBe(outcome === 'failure' ? 7 : 0)
        return { isError: outcome !== 'success', content: [] }
      })
      const receipt = await verifyQuality(f.repo.root, f.owner)
      expect(receipt.finalVerdict).toBe('incomplete')
      expect(receipt.changedFiles).toContain('created.ts')
      expect(receipt.evidenceCoverage.changes).toContainEqual(expect.objectContaining({ file: 'created.ts', attribution: 'unattributed', outcome }))
      expect(turnEditedFiles(f.owner)).toEqual([])
    } finally { clearInterval(poll); clearTimeout(fallback); mounted.dispose() }
  })
  it('tracks a throwing custom script and background promotion conservatively', async () => {
    const f = await fixture(), mounted = mount()
    try {
      await expect(mounted.execute({ ...f.actor, name: 'custom_script', arguments: {} }, async () => {
        await f.repo.write('partial.ts', 'partial effect')
        throw new Error('script failed')
      })).rejects.toThrow('script failed')
      await mounted.execute({ ...f.actor, name: 'pwsh', arguments: { run_in_background: true } }, async () => ({ isError: false, value: { kind: 'background' } }))
      expect((await verifyQuality(f.repo.root, f.owner)).finalVerdict).toBe('incomplete')
    } finally { mounted.dispose() }
  })
  it('records a canonical nonzero shell exit as failure even when tool dispatch succeeded', async () => {
    const f = await fixture(), mounted = mount()
    try {
      await mounted.execute({ ...f.actor, name: 'pwsh', arguments: {} }, async () => {
        await f.repo.write('partial.js', 'export const partial = 1')
        return { isError: false, value: { kind: 'foreground', exitCode: 7, aborted: false, timedOut: false } }
      })
      const receipt = await verifyQuality(f.repo.root, f.owner)
      expect(receipt.finalVerdict).toBe('incomplete')
      expect(receipt.evidenceCoverage.changes[0]).toMatchObject({ file: 'partial.js', outcome: 'failure', attribution: 'unattributed' })
    } finally { mounted.dispose() }
  })
})
