import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { applyConfig } from '../src/config.js'
import { disposeAllManagers, managerForRoot } from '../src/manager.js'
import { clearFrameCache } from '../src/frames.js'
import { fakeLinterPath, makeFixtureRepo } from './helpers/fixtures.js'

afterEach(async () => {
  applyConfig()
  await disposeAllManagers()
  clearFrameCache()
  delete process.env.FAKE_RUN_LOG
})

describe('package-scoped linters (golangci / clippy)', () => {
  it('distributes a golangci package run across every file it reports', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('.golangci.yml', 'linters:\n  enable: []\n')
    const main = await repo.write('main.go', 'package main\nvar x = 1 // lint: error govet unused x [fixable]\n')
    const other = await repo.write('other.go', 'package main\nvar y = 2 // lint: warning ineffassign y is ineffectual\n')
    applyConfig({ linterPath: { golangci: fakeLinterPath() } })

    const manager = managerForRoot(repo.root)
    const findings = await manager.lintFile(main)

    expect(findings.map((finding) => finding.file)).toEqual(['main.go'])
    expect(findings[0]).toMatchObject({ rule: 'govet', severity: 'error', fixable: true, linter: 'golangci' })
    expect(manager.findingsFor(other).map((finding) => finding.file)).toEqual(['other.go'])
    expect(manager.findingsFor(other)[0]).toMatchObject({ rule: 'ineffassign', severity: 'warning' })
    expect(manager.allFindings()).toHaveLength(2)
  })

  it('runs a package linter once for several files of the same package', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('.golangci.yml', 'linters:\n  enable: []\n')
    const a = await repo.write('a.go', 'package main // lint: error govet a\n')
    const b = await repo.write('b.go', 'package main // lint: error govet b\n')
    const log = `${repo.root}/runs.log`
    process.env.FAKE_RUN_LOG = log
    applyConfig({ linterPath: { golangci: fakeLinterPath() } })

    const results = await managerForRoot(repo.root).lintMany([a, b])

    const runs = (await readFile(log, 'utf8')).trim().split('\n').filter((line) => line === 'golangci')
    expect(runs).toHaveLength(1)
    expect(results.get(a)).toHaveLength(1)
    expect(results.get(b)).toHaveLength(1)
  })

  it('resolves the crate root for clippy and reports repo-relative paths', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('Cargo.toml', '[package]\nname = "root"\n')
    await repo.write('crates/foo/Cargo.toml', '[package]\nname = "foo"\n')
    const rs = await repo.write('crates/foo/src/main.rs', 'fn main() {} // lint: warning clippy::needless_return unneeded return\n')
    applyConfig({ linterPath: { clippy: fakeLinterPath() } })

    const findings = await managerForRoot(repo.root).lintFile(rs)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'clippy::needless_return',
      file: 'crates/foo/src/main.rs',
      line: 1,
      severity: 'warning',
      linter: 'clippy',
    })
  })

  it('auto-fixes through a package linter and clears the finding', async () => {
    const repo = await makeFixtureRepo()
    await repo.write('Cargo.toml', '[package]\nname = "x"\n')
    const rs = await repo.write('src/main.rs', 'fn main() {} // lint: warning clippy::needless_return unneeded return [fixable]\n')
    applyConfig({ linterPath: { clippy: fakeLinterPath() } })

    const manager = managerForRoot(repo.root)
    await manager.lintFile(rs)
    const result = await manager.fixFile(rs)

    expect(result.fixed).toBe(true)
    expect(result.remaining).toHaveLength(0)
    expect(await readFile(rs, 'utf8')).not.toContain('[fixable]')
  })
})
