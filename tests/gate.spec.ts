import { afterEach, describe, expect, it } from 'vitest'
import { applyConfig } from '../src/config.js'
import { invalidateProbes } from '../src/detect.js'
import { clearGateState, handleTurnStopping, markDirty, steeringCountFor } from '../src/gate.js'
import { disposeAllManagers } from '../src/manager.js'
import { fakeLinterPath, makeFixtureRepo } from './helpers/fixtures.js'

const FAKE = fakeLinterPath()
const CONFIG = { linterPath: { eslint: FAKE, biome: FAKE, ruff: FAKE } }

function fakeAgent(id = 'sess-1') {
  const steers: unknown[] = []
  return {
    id,
    steers,
    steer(message: unknown) {
      steers.push(message)
    },
  }
}

afterEach(async () => {
  await disposeAllManagers()
  invalidateProbes()
  clearGateState()
  applyConfig()
})

async function makeRepoWith(markers: string): Promise<string> {
  const repo = await makeFixtureRepo()
  await repo.write('eslint.config.mjs', 'export default []\n')
  return repo.write('src/a.ts', markers)
}

describe('handleTurnStopping (completion gate)', () => {
  it('steers when a file edited this turn still carries errors', async () => {
    applyConfig(CONFIG)
    const file = await makeRepoWith('const x = 1 // lint: error no-unused-vars x is unused\n')
    const agent = fakeAgent()

    markDirty(file)
    const text = await handleTurnStopping({ agent, turn: 1 })

    expect(agent.steers).toHaveLength(1)
    expect(text).toContain('cannot finish cleanly')
    expect(text).toContain('no-unused-vars')
    expect(String((agent.steers[0] as { content: Array<{ text: string }> }).content[0].text)).toContain('cannot finish cleanly')
  })

  it('admits the turn when the edited file is clean', async () => {
    applyConfig(CONFIG)
    const file = await makeRepoWith('const x = 1\n')
    const agent = fakeAgent()
    markDirty(file)
    expect(await handleTurnStopping({ agent, turn: 1 })).toBeUndefined()
    expect(agent.steers).toHaveLength(0)
  })

  it('does nothing when no file was observed', async () => {
    applyConfig(CONFIG)
    const agent = fakeAgent()
    expect(await handleTurnStopping({ agent, turn: 1 })).toBeUndefined()
    expect(agent.steers).toHaveLength(0)
  })

  it('caps forced continuations per turn (gateMaxSteers)', async () => {
    applyConfig({ ...CONFIG, gateMaxSteers: 2 })
    const file = await makeRepoWith('const x = 1 // lint: error no-unused-vars x is unused\n')
    const agent = fakeAgent()

    for (let i = 0; i < 5; i++) {
      markDirty(file)
      await handleTurnStopping({ agent, turn: 1 })
    }
    expect(agent.steers).toHaveLength(2)
    expect(steeringCountFor('sess-1', 1)).toBe(2)

    // A new turn gets a fresh budget.
    markDirty(file)
    await handleTurnStopping({ agent, turn: 2 })
    expect(agent.steers).toHaveLength(3)
  })

  it('does not steer when gate is disabled or the cap is zero', async () => {
    applyConfig({ ...CONFIG, gate: false })
    const file = await makeRepoWith('const x = 1 // lint: error no-unused-vars x is unused\n')
    const agent = fakeAgent()
    markDirty(file)
    expect(await handleTurnStopping({ agent, turn: 1 })).toBeUndefined()

    applyConfig({ ...CONFIG, gateMaxSteers: 0 })
    markDirty(file)
    expect(await handleTurnStopping({ agent, turn: 1 })).toBeUndefined()
    expect(agent.steers).toHaveLength(0)
  })

  it('skips files with no configured linter and never throws outside a repo', async () => {
    applyConfig(CONFIG)
    const repo = await makeFixtureRepo()
    const md = await repo.write('README.md', '# hi\n')
    const agent = fakeAgent()

    markDirty(md)
    markDirty('/tmp/definitely-not-a-repo-xyz/src/file.ts')
    expect(await handleTurnStopping({ agent, turn: 1 })).toBeUndefined()
    expect(agent.steers).toHaveLength(0)
  })
})
