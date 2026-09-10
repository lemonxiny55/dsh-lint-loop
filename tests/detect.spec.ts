import { afterEach, describe, expect, it } from 'vitest'
import { invalidateProbes, isLinterConfigBasename, probeLinters, usableLinters } from '../src/detect.js'
import { applyConfig } from '../src/config.js'
import { chooseLinter } from '../src/detect.js'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtures.js'

let repo: FixtureRepo

afterEach(() => {
  invalidateProbes()
  applyConfig()
})

describe('probeLinters', () => {
  it('detects eslint via flat config and legacy config files', async () => {
    repo = await makeFixtureRepo()
    await repo.write('eslint.config.mjs', 'export default []\n')
    expect(await probeLinters(repo.root)).toEqual({ eslint: true, biome: false, ruff: false })

    const legacy = await makeFixtureRepo()
    await legacy.write('.eslintrc.json', '{}\n')
    expect(await probeLinters(legacy.root)).toEqual({ eslint: true, biome: false, ruff: false })
  })

  it('detects biome and ruff (ruff.toml / pyproject [tool.ruff])', async () => {
    const biomeRepo = await makeFixtureRepo()
    await biomeRepo.write('biome.json', '{}\n')
    expect(await probeLinters(biomeRepo.root)).toEqual({ eslint: false, biome: true, ruff: false })

    const ruffRepo = await makeFixtureRepo()
    await ruffRepo.write('ruff.toml', 'line-length = 100\n')
    expect(await probeLinters(ruffRepo.root)).toEqual({ eslint: false, biome: false, ruff: true })

    const pyprojectRepo = await makeFixtureRepo()
    await pyprojectRepo.write('pyproject.toml', '[project]\nname = "x"\n\n[tool.ruff.lint]\nselect = ["E"]\n')
    expect(await probeLinters(pyprojectRepo.root)).toEqual({ eslint: false, biome: false, ruff: true })
  })

  it('does not count a pyproject.toml without [tool.ruff] as ruff', async () => {
    repo = await makeFixtureRepo()
    await repo.write('pyproject.toml', '[project]\nname = "x"\n')
    expect(await probeLinters(repo.root)).toEqual({ eslint: false, biome: false, ruff: false })
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

  it('routes .ts to eslint by default and to biome only when biome exists without eslint', async () => {
    const bothRepo = await makeFixtureRepo()
    await bothRepo.write('eslint.config.mjs', 'export default []\n')
    await bothRepo.write('biome.json', '{}\n')
    expect(await chooseLinter(bothRepo.root, `${bothRepo.root}/a.ts`)).toBe('eslint')

    const biomeRepo = await makeFixtureRepo()
    await biomeRepo.write('biome.json', '{}\n')
    expect(await chooseLinter(biomeRepo.root, `${biomeRepo.root}/a.tsx`)).toBe('biome')
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
    expect(isLinterConfigBasename('index.ts')).toBe(false)
    expect(isLinterConfigBasename('biome.backup.json')).toBe(false)
  })
})
