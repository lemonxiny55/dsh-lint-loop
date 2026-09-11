import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { applyConfig } from '../src/config.js'
import { disposeAllManagers, managerForRoot } from '../src/manager.js'
import { invalidateProbes, probeLinters } from '../src/detect.js'
import { clearGateState } from '../src/gate.js'
import { tools } from '../src/tools.js'
import { fakeLinterPath, makeFixtureRepo, type FixtureRepo } from './helpers/fixtures.js'

const FAKE = fakeLinterPath()
const PLUGIN_CONFIG = { linterPath: { eslint: FAKE, biome: FAKE, ruff: FAKE } }

type Listener = (target: unknown, info: unknown, exec: unknown) => void

interface Mounted {
  registered: string[]
  listenerNames: string[]
  listenersFor: (name: string) => Listener[]
  sectionText: () => string
  sectionOrder: number
  sectionName: string
  dispose: () => void
  disposed: () => { tools: number; sections: number; listeners: number }
}

function mount(pluginConfig?: Record<string, unknown>): Mounted {
  const registered: string[] = []
  const entries: Array<{ name: string; listener: Listener }> = []
  let disposedTools = 0
  let disposedSections = 0
  let disposedListeners = 0
  let section: { name: string; order: number; text: (context: unknown) => string } | undefined
  let disposeEffect: (() => void) | undefined

  const ctx = {
    effect(fn: () => void | (() => void)) {
      disposeEffect = fn() ?? undefined
    },
    tools: {
      register(tool: { name: string }) {
        registered.push(tool.name)
        return () => {
          disposedTools++
        }
      },
    },
    systemPrompt: {
      section(registeredSection: { name: string; order: number; text: string | ((context: unknown) => string) }) {
        const text = registeredSection.text
        section = {
          name: registeredSection.name,
          order: registeredSection.order,
          text: typeof text === 'function' ? () => text(undefined) : () => text,
        }
        return () => {
          disposedSections++
        }
      },
    },
    on(name: string, listener: Listener) {
      entries.push({ name, listener })
      return () => {
        disposedListeners++
      }
    },
  }

  // Config flows through apply() exactly like a real harness plugin row —
  // apply() re-applies config, so setting it any earlier would be wiped.
  apply(ctx as never, pluginConfig as never)
  return {
    registered,
    listenerNames: entries.map((entry) => entry.name),
    listenersFor: (name) => entries.filter((entry) => entry.name === name).map((entry) => entry.listener),
    sectionText: () => {
      if (!section) throw new Error('section was not registered')
      return section.text(undefined)
    },
    get sectionOrder() {
      if (!section) throw new Error('section was not registered')
      return section.order
    },
    get sectionName() {
      if (!section) throw new Error('section was not registered')
      return section.name
    },
    dispose: () => disposeEffect?.(),
    disposed: () => ({ tools: disposedTools, sections: disposedSections, listeners: disposedListeners }),
  }
}

async function runDiagnostics(args: Record<string, unknown>, root: string): Promise<unknown> {
  const tool = tools.find((entry) => entry.name === 'lint_diagnostics')!
  return (tool.execute as (a: unknown, exec: unknown) => Promise<unknown>)(
    args,
    { agent: { session: { header: { cwd: root } } } },
  )
}

afterEach(async () => {
  await disposeAllManagers()
  invalidateProbes()
  clearGateState()
  applyConfig()
})

describe('plugin lifecycle', () => {
  it('registers tools + section + fs listener + gate listener, disposes all, and can mount again', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const first = mount(PLUGIN_CONFIG)
    expect(first.registered).toEqual(['lint_diagnostics', 'lint_workspace_errors', 'lint_fix'])
    expect(first.sectionName).toBe('lint:findings')
    expect(first.sectionOrder).toBe(75)
    expect(first.listenerNames).toEqual(['fs/observed', 'agent/turn-stopping'])
    expect(first.sectionText()).toContain('lint_diagnostics')

    first.dispose()
    expect(first.disposed()).toEqual({ tools: 3, sections: 1, listeners: 2 })

    const second = mount(PLUGIN_CONFIG)
    expect(second.registered).toEqual(['lint_diagnostics', 'lint_workspace_errors', 'lint_fix'])
    second.dispose()
    expect(second.disposed()).toEqual({ tools: 3, sections: 1, listeners: 2 })
  })

  it('injects a findings delta after an fs/observed edit event (the closed loop)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const repo: FixtureRepo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')

    const mounted = mount(PLUGIN_CONFIG)
    const fsListener = mounted.listenersFor('fs/observed')[0]
    expect(fsListener).toBeDefined()

    // Warm the probe/store through the tool path, then "edit" another file.
    await repo.write('src/warm.ts', 'const warm = 1\n')
    await runDiagnostics({ file: 'src/warm.ts', repoRoot: repo.root }, repo.root)
    const edited = await repo.write(
      'src/broken.ts',
      'const x = 1 // lint: error no-unused-vars x is never used\n',
    )

    fsListener({ displayPath: edited }, { kind: 'present' }, undefined)
    await vi.waitFor(
      () => {
        const text = mounted.sectionText()
        expect(text).toContain('1 error introduced by your last edit')
        expect(text).toContain('no-unused-vars')
        expect(text).toContain('src/broken.ts:1')
        expect(text).toContain('lint_fix')
      },
      { timeout: 10_000, interval: 100 },
    )

    mounted.dispose()
  })

  it('keeps warnings out of the section by default, but includes them when asked', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const repo: FixtureRepo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/warn.ts', 'const w = 1 // lint: warning style-rule just a warning\n')

    const strict = mount(PLUGIN_CONFIG)
    strict.listenersFor('fs/observed')[0]({ displayPath: file }, { kind: 'present' }, undefined)
    await vi.waitFor(
      () => {
        // A warning-only delta is filtered out → the section falls back to guidance.
        expect(strict.sectionText()).toContain('lint_diagnostics')
        expect(strict.sectionText()).not.toContain('style-rule')
      },
      { timeout: 10_000, interval: 100 },
    )
    strict.dispose()

    const loud = mount({ ...PLUGIN_CONFIG, sectionSeverity: 'warning' })
    loud.listenersFor('fs/observed')[0]({ displayPath: file }, { kind: 'present' }, undefined)
    await vi.waitFor(
      () => {
        expect(loud.sectionText()).toContain('style-rule')
        expect(loud.sectionText()).toContain('1 warning introduced by your last edit')
      },
      { timeout: 10_000, interval: 100 },
    )
    loud.dispose()
  })

  it('collapses to guidance when a re-save introduces nothing new (delta semantics)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const repo: FixtureRepo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/delta.ts', 'const d = 1 // lint: error dup-rule same finding\n')

    const mounted = mount(PLUGIN_CONFIG)
    const fsListener = mounted.listenersFor('fs/observed')[0]
    fsListener({ displayPath: file }, { kind: 'present' }, undefined)
    await vi.waitFor(() => {
      expect(mounted.sectionText()).toContain('dup-rule')
    }, { timeout: 10_000, interval: 100 })

    // Same file observed again (unchanged content) → no NEW findings → guidance only.
    fsListener({ displayPath: file }, { kind: 'present' }, undefined)
    await vi.waitFor(() => {
      expect(mounted.sectionText()).not.toContain('dup-rule')
      expect(mounted.sectionText()).toContain('lint_diagnostics')
    }, { timeout: 10_000, interval: 100 })

    mounted.dispose()
  })

  it('invalidates the probe cache when an fs/observed event carries a linter config file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const repo: FixtureRepo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    expect((await probeLinters(repo.root)).biome).toBe(false) // warm + cached

    const mounted = mount(PLUGIN_CONFIG)
    const config = await repo.write('biome.json', '{}\n')
    mounted.listenersFor('fs/observed')[0]({ displayPath: config }, { kind: 'present' }, undefined)

    await vi.waitFor(() => {
      expect(probeLinters(repo.root)).resolves.toMatchObject({ biome: true })
    })
    mounted.dispose()
  })

  it('stays quiet (no section, no listeners) when autoInject is false and the gate is not requested', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const mounted = mount({ ...PLUGIN_CONFIG, autoInject: false })
    expect(mounted.registered).toHaveLength(3)
    expect(mounted.listenerNames).toEqual([])
    expect(() => mounted.sectionText()).toThrow('section was not registered')
    mounted.dispose()
    expect(mounted.disposed()).toEqual({ tools: 3, sections: 0, listeners: 0 })
  })
})

describe('completion gate wiring', () => {
  it('the turn-stopping listener returns an awaitable promise (checkpoint contract)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const mounted = mount({ ...PLUGIN_CONFIG })
    const listener = mounted.listenersFor('agent/turn-stopping')[0]
    const result = listener({ agent: { id: 's', steer: () => {} }, turn: 1 }, undefined, undefined)
    // Fire-and-forget here races the turn close and drops the steer.
    expect(result).toBeInstanceOf(Promise)
    await result
    mounted.dispose()
  })

  it('arms the gate without a section when autoInject is false but gate is explicit', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const mounted = mount({ ...PLUGIN_CONFIG, autoInject: false, gate: true })
    expect(mounted.listenerNames).toEqual(['fs/observed', 'agent/turn-stopping'])
    expect(() => mounted.sectionText()).toThrow('section was not registered')
    mounted.dispose()
  })

  it('steers the agent when a file edited this turn still has errors', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const repo: FixtureRepo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/gated.ts', 'const g = 1 // lint: error no-unused-vars g is unused\n')

    const mounted = mount({ ...PLUGIN_CONFIG, gateMaxSteers: 1 })
    const steers: unknown[] = []
    const agent = { id: 'sess-live', steer: (message: unknown) => steers.push(message) }

    // The edit is observed first, then the turn tries to close.
    mounted.listenersFor('fs/observed')[0]({ displayPath: file }, { kind: 'present' }, undefined)
    mounted.listenersFor('agent/turn-stopping')[0]({ agent, turn: 1 }, undefined, undefined)

    await vi.waitFor(() => {
      expect(steers).toHaveLength(1)
      const text = (steers[0] as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain('cannot finish cleanly')
      expect(text).toContain('no-unused-vars')
    }, { timeout: 10_000, interval: 100 })

    mounted.dispose()
  })

  it('managerForRoot returns one shared manager per root', async () => {
    const repo: FixtureRepo = await makeFixtureRepo()
    expect(managerForRoot(repo.root)).toBe(managerForRoot(repo.root))
    expect(managerForRoot(repo.root).root).toBe(repo.root)
  })
})
