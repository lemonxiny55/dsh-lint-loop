import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { clearGateState } from '../src/gate.js'
import { applyConfig } from '../src/config.js'
import { disposeAllManagers } from '../src/manager.js'
import { invalidateProbes } from '../src/detect.js'
import { ownerFromActor } from '../src/baseline.js'
import { prepareMutation, recordSuccessfulToolMutation } from '../src/regression.js'
import { verifyQuality } from '../src/quality.js'
import { fakeLinterPath, makeFixtureRepo } from './helpers/fixtures.js'

afterEach(async () => { clearGateState(); await disposeAllManagers(); invalidateProbes(); applyConfig() })
it('verifies real TypeScript and Vitest reports with old debt and impacted test filtering', async () => {
  const repo = await makeFixtureRepo()
  const local = (file: string) => pathToFileURL(`${process.cwd().replaceAll('\\', '/')}/node_modules/${file}`).href
  await repo.write('package.json', '{"type":"module","scripts":{"test":"vitest run"}}')
  await repo.write('tsconfig.json', '{"compilerOptions":{"strict":true,"target":"ES2023","module":"ESNext","skipLibCheck":true},"include":["src"]}')
  await repo.write('vitest.config.mjs', 'export default {test:{globals:true}}')
  await repo.write('eslint.config.mjs', 'export default []')
  await repo.write('node_modules/typescript/package.json', '{"type":"module"}')
  await repo.write('node_modules/typescript/bin/tsc', `import ${JSON.stringify(local('typescript/bin/tsc'))}`)
  await repo.write('node_modules/vitest/vitest.mjs', `import ${JSON.stringify(local('vitest/vitest.mjs'))}`)
  const file = await repo.write('src/a.ts', 'export const a: number = 1\nconst debt: number = "old"\n')
  await repo.write('src/b.ts', 'export const b = 1')
  await repo.write('tests/a.test.ts', 'import { a } from "../src/a.js"; test("a", () => expect(a).toBe(1)); test("historical", () => expect(1).toBe(0));')
  await repo.write('tests/b.test.ts', 'import { b } from "../src/b.js"; test("b", () => expect(b).toBe(1));')
  applyConfig({ linterPath: { eslint: fakeLinterPath() }, qualityTimeoutMs: 20_000 })
  const actor = { agent: { session: { id: repo.root, header: { cwd: repo.root } } } }
  const owner = ownerFromActor(actor)
  await prepareMutation(file, actor)
  await repo.write('src/a.ts', 'export const a: number = "new"\nconst debt: number = "old"\n')
  await recordSuccessfulToolMutation(file, actor)
  const receipt = await verifyQuality(repo.root, owner)
  expect(receipt.finalVerdict).toBe('regression')
  expect(receipt.ignoredHistoricalDebt.map((i) => i.check).sort()).toEqual(['tests:.', 'typecheck:.'])
  expect(receipt.newlyIntroducedRegressions.map((i) => i.check).sort()).toEqual(['tests:.', 'typecheck:.'])
  expect(receipt.selection.files).toEqual(['tests/a.test.ts'])
  expect(receipt.checksExecuted.find((c) => c.kind === 'tests')!.executed).toEqual(['tests/a.test.ts|a', 'tests/a.test.ts|historical'])
  await repo.write('src/a.ts', 'export const a: number = "new";\nconst debt: number = "old";\n')
  const formatted = await verifyQuality(repo.root, owner)
  expect(formatted.newlyIntroducedRegressions).toEqual(receipt.newlyIntroducedRegressions)
  expect(formatted.ignoredHistoricalDebt).toEqual(receipt.ignoredHistoricalDebt)
  expect(formatted.agentFixed).toEqual([])
  await repo.write('src/a.ts', 'export const a: number = 1;\nconst debt: number = "old";\n')
  const fixed = await verifyQuality(repo.root, owner)
  expect(fixed.finalVerdict).toBe('clean')
  expect(fixed.agentFixed.map((i) => i.check).sort()).toEqual(['tests:.', 'typecheck:.'])
  expect(fixed.ignoredHistoricalDebt).toEqual(receipt.ignoredHistoricalDebt)
  if (process.env.QUALITY_RECEIPT_OUTPUT) await writeFile(process.env.QUALITY_RECEIPT_OUTPUT, JSON.stringify(receipt, null, 2) + '\n')
}, 60_000)
