import { afterEach, describe, expect, it } from 'vitest'
import { invalidateProbes, isLinterConfigBasename, probeLinters, usableLinters } from '../src/detect.js'
import { applyConfig } from '../src/config.js'
import { chooseLinter } from '../src/detect.js'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtures.js'
import type { DetectedLinters } from '../src/detect.js'

let repo: FixtureRepo

afterEach(() => {
  invalidateProbes()
  applyConfig()
})

/** The probe shape with only the named linters flipped on. */
function detected(on: Partial<DetectedLinters> = {}): DetectedLinters {
  return { eslint: false, biome: false, ruff: false, golangci: false, clippy: false, ...on }
}

describe('probeLinters', () => {
  it('detects eslint via flat config and legacy config files', async () => {
    repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    expect(await probeLinters(repo.root)).toEqual(detected({ eslint: true }))

    const legacy = await makeFixtureRepo()
    await legacy.write('.eslintrc.json', '{}\n')
    expect(await probeLinters(legacy.root)).toEqual(detected({ eslint: true }))
  })

  it('detects biome and ruff (ruff.toml / pyproject [tool.ruff])', async () => {
    const biomeRepo = await makeFixtureRepo()
    await biomeRepo.write('biome.json', '{}\n')
    expect(await probeLinters(biomeRepo.root)).toEqual(detected({ biome: true }))

    const ruffRepo = await makeFixtureRepo()
    await ruffRepo.write('ruff.toml', 'line-length = 100\n')
    expect(await probeLinters(ruffRepo.root)).toEqual(detected({ ruff: true }))

    const pyprojectRepo = await makeFixtureRepo()
    await pyprojectRepo.write('pyproject.toml', '[project]\nname = "x"\n\n[tool.ruff.lint]\nselect = ["E"]\n')
    expect(await probeLinters(pyprojectRepo.root)).toEqual(detected({ ruff: true }))
  })

  it('detects golangci-lint via any .golangci.* config file', async () => {
    for (const name of ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json']) {
      const goRepo = await makeFixtureRepo()
      await goRepo.write(name, 'linters:\n  enable: []\n')
      expect(await probeLinters(goRepo.root)).toEqual(detected({ golangci: true }))
    }
  })

  it('detects clippy via a Cargo.toml (it ships with the toolchain)', async () => {
    const rustRepo = await makeFixtureRepo()
    await rustRepo.write('Cargo.toml', '[package]\nname = "x"\n')
    expect(await probeLinters(rustRepo.root)).toEqual(detected({ clippy: true }))
  })

  it('does not count a pyproject.toml without [tool.ruff] as ruff', async () => {
    repo = await makeFixtureRepo()
    await repo.write('pyproject.toml', '[project]\nname = "x"\n')
    expect(await probeLinters(repo.root)).toEqual(detected())
  })

  it('caches per root until invalidateProbes is called (config change → re-probe)', async () => {
    repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    expect((await probeLinters(repo.root)).biome).toBe(false)

    await repo.write('biome.json', '{}\n')
    expect((await probeLinters(repo.root)).biome).toBe(false) // cached

    invalidateProbes()
    expect((await probeLinters(repo.root)).biome).toBe(true) // re-probed
  })
})

describe('chooseLinter', () => {
  it('routes .py/.pyi to ruff', async () => {
    repo = await makeFixtureRepo()
    await repo.write('ruff.toml', 'x = 1\n')
    expect(await chooseLinter(repo.root, `${repo.root}/mod.py`)).toBe('ruff')
  })

  it('routes .go to golangci-lint and .rs to clippy', async () => {
    const goRepo = await makeFixtureRepo()
    await goRepo.write('.golangci.yml', 'linters:\n  enable: []\n')
    expect(await chooseLinter(goRepo.root, `${goRepo.root}/main.go`)).toBe('golangci')

    const rustRepo = await makeFixtureRepo()
    await rustRepo.write('Cargo.toml', '[package]\nname = "x"\n')
    expect(await chooseLinter(rustRepo.root, `${rustRepo.root}/src/main.rs`)).toBe('clippy')
  })

  it('routes .ts to eslint by default and to biome only when biome exists without eslint', async () => {
    const bothRepo = await makeFixtureRepo()
    await bothRepo.write('eslint.config.mjs', 'export default []\n')
    await bothRepo.write('biome.json', '{}\n')
    expect(await chooseLinter(bothRepo.root, `${bothRepo.root}/a.ts`)).toBe('eslint')

    const biomeRepo = await makeFixtureRepo()
    await biomeRepo.write('biome.json', '{}\n')
    expect(await chooseLinter(biomeRepo.root, `${biomeRepo.root}/a.tsx`)).toBe('biome')
  })

  it('returns null for a supported family with no usable linter', async () => {
    const goRepo = await makeFixtureRepo()
    await goRepo.write('go.mod', 'module x\n')
    expect(await chooseLinter(goRepo.root, `${goRepo.root}/main.go`)).toBeNull()
  })

  it('honours a forced linters config', async () => {
    const bothRepo = await makeFixtureRepo()
    await bothRepo.write('eslint.config.mjs', 'export default []\n')
    await bothRepo.write('biome.json', '{}\n')
    applyConfig({ linters: ['biome'] })
    expect(await chooseLinter(bothRepo.root, `${bothRepo.root}/a.ts`)).toBe('biome')

    applyConfig({ linters: ['ruff'] })
    expect(await chooseLinter(bothRepo.root, `${bothRepo.root}/a.ts`)).toBeNull()
  })

  it('restricts the usable set to detected linters', async () => {
    repo = await makeFixtureRepo()
    await repo.write('biome.json', '{}\n')
    expect(await usableLinters(repo.root)).toEqual(['biome'])
    expect(await usableLinters(repo.root)).not.toContain('eslint')
  })
})

describe('isLinterConfigBasename', () => {
  it('recognises every config basename the probe cares about', () => {
    expect(isLinterConfigBasename('biome.json')).toBe(true)
    expect(isLinterConfigBasename('biome.jsonc')).toBe(true)
    expect(isLinterConfigBasename('eslint.config.ts')).toBe(true)
    expect(isLinterConfigBasename('.eslintrc.yml')).toBe(true)
    expect(isLinterConfigBasename('pyproject.toml')).toBe(true)
    expect(isLinterConfigBasename('ruff.toml')).toBe(true)
    expect(isLinterConfigBasename('.ruff.toml')).toBe(true)
    expect(isLinterConfigBasename('.golangci.yml')).toBe(true)
    expect(isLinterConfigBasename('.golangci.toml')).toBe(true)
    expect(isLinterConfigBasename('Cargo.toml')).toBe(true)
    expect(isLinterConfigBasename('index.ts')).toBe(false)
    expect(isLinterConfigBasename('biome.backup.json')).toBe(false)
  })
})
