import { describe, expect, it } from 'vitest'
import { applyConfig, getConfig } from '../src/config.js'
import { linterFamilyForExt, resolveCommand, LINTER_SPECS } from '../src/linters.js'

describe('applyConfig / getConfig', () => {
  it('applies the documented defaults', () => {
    applyConfig()
    const config = getConfig()
    expect(config.autoInject).toBe(true)
    expect(config.maxFindings).toBe(50)
    expect(config.linters).toEqual([])
    expect(config.linterPath).toEqual({})
    expect(config.sectionTtlMs).toBe(30_000)
    expect(config.timeoutMs).toBe(10_000)
  })

  it('merges a partial config over the defaults (idempotent)', () => {
    applyConfig({ maxFindings: 10, linters: ['ruff'] })
    expect(getConfig().maxFindings).toBe(10)
    expect(getConfig().linters).toEqual(['ruff'])
    applyConfig({ maxFindings: 10 })
    expect(getConfig().linters).toEqual([])
    expect(getConfig().timeoutMs).toBe(10_000)
  })

  it('coerces obviously wrong numbers back to defaults', () => {
    applyConfig({ maxFindings: -3, sectionTtlMs: 5, timeoutMs: 0 })
    expect(getConfig().maxFindings).toBe(50)
    expect(getConfig().sectionTtlMs).toBe(30_000)
    expect(getConfig().timeoutMs).toBe(10_000)
    applyConfig({ maxFindings: Number.NaN })
    expect(getConfig().maxFindings).toBe(50)
  })

  it('filters unknown linter keys out of the forced set', () => {
    applyConfig({ linters: ['biome', 'nope'] as never })
    expect(getConfig().linters).toEqual(['biome'])
  })
})

describe('file routing', () => {
  it('routes JS-family and Python extensions to their linter families', () => {
    expect(linterFamilyForExt('.ts')).toBe('js')
    expect(linterFamilyForExt('.TSX')).toBe('js')
    expect(linterFamilyForExt('.mjs')).toBe('js')
    expect(linterFamilyForExt('.cts')).toBe('js')
    expect(linterFamilyForExt('.py')).toBe('py')
    expect(linterFamilyForExt('.pyi')).toBe('py')
    expect(linterFamilyForExt('.md')).toBeNull()
    expect(linterFamilyForExt('.rs')).toBeNull()
  })
})

describe('resolveCommand', () => {
  it('passes through the real command and args without an override', () => {
    expect(resolveCommand(LINTER_SPECS.eslint, undefined, ['--fix', 'a.ts'])).toEqual({
      command: 'eslint',
      args: ['--fix', 'a.ts'],
    })
  })

  it('runs .js/.mjs overrides under the current Node (the test-fake seam)', () => {
    const resolved = resolveCommand(LINTER_SPECS.biome, '/abs/fakeLinter.mjs', ['check', 'a.ts'])
    expect(resolved.command).toBe(process.execPath)
    expect(resolved.args).toEqual(['/abs/fakeLinter.mjs', 'check', 'a.ts'])
  })

  it('uses a non-script override as the binary directly', () => {
    expect(resolveCommand(LINTER_SPECS.ruff, '/opt/ruff-wrapper', ['check'])).toEqual({
      command: '/opt/ruff-wrapper',
      args: ['check'],
    })
  })

  it('carries lint and fix args per spec', () => {
    expect(LINTER_SPECS.eslint.lintArgs).toContain('-f')
    expect(LINTER_SPECS.biome.lintArgs).toContain('--reporter=json')
    expect(LINTER_SPECS.ruff.lintArgs).toContain('--output-format=json')
    expect(LINTER_SPECS.eslint.fixArgs).toContain('--fix')
    expect(LINTER_SPECS.biome.fixArgs).toContain('--write')
    expect(LINTER_SPECS.ruff.fixArgs).toContain('--fix')
  })
})
