import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { applyConfig } from '../src/config.js'
import { disposeAllManagers, managerForRoot } from '../src/manager.js'
import { invalidateProbes, probeLinters } from '../src/detect.js'
import { tools } from '../src/tools.js'
import { fakeLinterPath, makeFixtureRepo, type FixtureRepo } from './helpers/fixtures.js'

const FAKE = fakeLinterPath()
const PLUGIN_CONFIG = { linterPath: { eslint: FAKE, biome: FAKE, ruff: FAKE } }

interface Mounted {
  registered: string[]
  listeners: Array<
    (target: { displayPath?: string } | undefined, info: { kind?: string } | undefined, exec: unknown) => void
  >
  sectionText: () => string
  sectionOrder: number
  sectionName: string
  dispose: () => void
  disposed: () => { tools: number; sections: number; listener: boolean }
}

function mount(pluginConfig?: Record<string, unknown>): Mounted {
  const registered: string[] = []
  const listeners: Array<
    (target: { displayPath?: string } | undefined, info: { kind?: string } | undefined, exec: unknown) => void
  > = []
  let disposedTools = 0
  let disposedSections = 0
  let disposedListener = false
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
      section(registered: { name: string; order: number; text: string | ((context: unknown) => string) }) {
        const text = registered.text
        section = {
          name: registered.name,
          order: registered.order,
          text: typeof text === 'function' ? () => text(undefined) : () => text,
        }
        return () => {
          disposedSections++
        }
      },
    },
    on(
      _name: string,
      listener: (
        target: { displayPath?: string } | undefined,
        info: { kind?: string } | undefined,
        exec: unknown,
      ) => void,
    ) {
      listeners.push(listener)
      return () => {
        disposedListener = true
      }
    },
  }

  // Config flows through apply() exactly like a real harness plugin row —
  // apply() re-applies config, so setting it any earlier would be wiped.
  apply(ctx as never, pluginConfig as never)
  return {
    registered,
    listeners,
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
    disposed: () => ({ tools: disposedTools, sections: disposedSections, listener: disposedListener }),
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
  applyConfig()
})

describe('plugin lifecycle', () => {
  it('registers tools + section + fs/observed listener, disposes all, and can mount again', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const first = mount(PLUGIN_CONFIG)
    expect(first.registered).toEqual(['lint_diagnostics', 'lint_workspace_errors', 'lint_fix'])
    expect(first.sectionName).toBe('lint:findings')
    expect(first.sectionOrder).toBe(75)
    // Before any edit the section shows the standing guidance line.
    expect(first.sectionText()).toContain('lint_diagnostics')

    first.dispose()
    expect(first.disposed()).toEqual({ tools: 3, sections: 1, listener: true })

    const second = mount(PLUGIN_CONFIG)
    expect(second.registered).toEqual(['lint_diagnostics', 'lint_workspace_errors', 'lint_fix'])
    second.dispose()
    expect(second.disposed()).toEqual({ tools: 3, sections: 1, listener: true })
  })

  it('injects a findings delta after an fs/observed edit event (the closed loop)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const repo: FixtureRepo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')

    const mounted = mount(PLUGIN_CONFIG)
    expect(mounted.listeners).toHaveLength(1)

    // Warm the probe/store through the tool path, then "edit" another file.
    await repo.write('src/warm.ts', 'const warm = 1\n')
    await runDiagnostics({ file: 'src/warm.ts', repoRoot: repo.root }, repo.root)
    const edited = await repo.write(
      'src/broken.ts',
      'const x = 1 // lint: error no-unused-vars x is never used\n',
    )

    mounted.listeners[0]({ displayPath: edited }, { kind: 'present' }, undefined)
    await vi.waitFor(
      () => {
        const text = mounted.sectionText()
        expect(text).toContain('1 error / 0 warnings')
        expect(text).toContain('no-unused-vars')
        expect(text).toContain('src/broken.ts:1')
        expect(text).toContain('lint_fix')
      },
      { timeout: 10_000, interval: 100 },
    )

    mounted.dispose()
  })

  it('collapses to guidance when a re-save introduces nothing new (delta semantics)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const repo: FixtureRepo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    const file = await repo.write('src/delta.ts', 'const d = 1 // lint: error dup-rule same finding\n')

    const mounted = mount(PLUGIN_CONFIG)
    mounted.listeners[0]({ displayPath: file }, { kind: 'present' }, undefined)
    await vi.waitFor(() => {
      expect(mounted.sectionText()).toContain('dup-rule')
    }, { timeout: 10_000, interval: 100 })

    // Same file observed again (unchanged content) → no NEW findings → guidance only.
    mounted.listeners[0]({ displayPath: file }, { kind: 'present' }, undefined)
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
    mounted.listeners[0]({ displayPath: config }, { kind: 'present' }, undefined)

    await vi.waitFor(() => {
      expect(probeLinters(repo.root)).resolves.toMatchObject({ biome: true })
    })
    mounted.dispose()
  })

  it('stays quiet (no section, no listener) when autoInject is false', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const mounted = mount({ ...PLUGIN_CONFIG, autoInject: false })
    expect(mounted.registered).toHaveLength(3)
    expect(mounted.listeners).toHaveLength(0)
    expect(() => mounted.sectionText()).toThrow('section was not registered')
    mounted.dispose()
    expect(mounted.disposed()).toEqual({ tools: 3, sections: 0, listener: false })
  })

  it('managerForRoot returns one shared manager per root', async () => {
    const repo: FixtureRepo = await makeFixtureRepo()
    expect(managerForRoot(repo.root)).toBe(managerForRoot(repo.root))
    expect(managerForRoot(repo.root).root).toBe(repo.root)
  })
})
