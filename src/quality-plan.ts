/** Bounded, conservative Node/TS discovery. No code is executed during selection. */
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { getConfig } from './config.js'
import { toRelative } from './workspace.js'

export interface PackageScope {
  dir: string
  runner?: 'vitest' | 'jest'
  testEntry?: string
  typeEntry?: string
  tsconfig?: string
  hasTests: boolean
}
export interface TestSelection {
  strategy: 'dependency' | 'package-fallback' | 'repository-fallback'
  files: string[]
  reasons: string[]
  complete: boolean
}
export interface QualityPlan { root: string; files: string[]; scopes: PackageScope[]; complete: boolean; reasons: string[] }
const CODE = /\.(?:[cm]?[jt]sx?)$/i
export const isTestFile = (file: string): boolean => /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[/\\])__tests__[/\\].*\.[cm]?[jt]sx?$)/i.test(file)
const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.next', '.turbo'])
export async function exists(file: string): Promise<boolean> { try { await access(file); return true } catch { return false } }
async function localEntry(dir: string, root: string, candidates: string[]): Promise<string | undefined> {
  for (;;) {
    for (const candidate of candidates) {
      const entry = path.join(dir, 'node_modules', candidate)
      if (await exists(entry)) return entry
    }
    if (dir === root) return undefined
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}
export async function discoverQualityPlan(root: string): Promise<QualityPlan> {
  root = path.resolve(root)
  const files: string[] = []
  const dirs = [root]
  let complete = true
  const reasons: string[] = []
  let entriesSeen = 0
  while (dirs.length) {
    const dir = dirs.pop()!
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { complete = false; reasons.push(`unreadable directory: ${toRelative(dir, root)}`); continue }
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue
      if (++entriesSeen > getConfig().qualityMaxFiles) { complete = false; reasons.push('discovery file budget exceeded'); dirs.length = 0; break }
      if (entry.isSymbolicLink()) { complete = false; reasons.push(`symlink excluded: ${entry.name}`); continue }
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) dirs.push(abs)
      else if (entry.isFile()) files.push(abs)
    }
  }
  files.sort()
  const scopes: PackageScope[] = []
  for (const manifest of files.filter((f) => path.basename(f) === 'package.json')) {
    const dir = path.dirname(manifest)
    try {
      const pkg = JSON.parse(await readFile(manifest, 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      const script = pkg.scripts?.test ?? ''
      // Custom wrappers and chained commands have no guaranteed reporter contract.
      const runner = /^\s*vitest(?:\s+run)?\s*$/.test(script) ? 'vitest'
        : /^\s*jest(?:\s+--runInBand)?\s*$/.test(script) ? 'jest' : undefined
      const testEntry = runner ? await localEntry(dir, root, runner === 'vitest' ? ['vitest/vitest.mjs'] : ['jest/bin/jest.js']) : undefined
      const tsconfig = files.includes(path.join(dir, 'tsconfig.json')) ? path.join(dir, 'tsconfig.json') : undefined
      const referencedProject = tsconfig && /["']references["']\s*:/.test(await readFile(tsconfig, 'utf8'))
      // tsc --noEmit does not rebuild project references; stale .d.ts cannot be evidence.
      const typeEntry = tsconfig && !referencedProject ? await localEntry(dir, root, ['typescript/bin/tsc']) : undefined
      scopes.push({ dir, runner, testEntry, typeEntry, tsconfig, hasTests: !!script })
    } catch { complete = false; reasons.push(`invalid package manifest: ${toRelative(manifest, root)}`) }
  }
  return { root, files, scopes, complete, reasons }
}
export function scopeFor(plan: QualityPlan, file: string): PackageScope | undefined {
  return plan.scopes.filter((s) => file === s.dir || file.startsWith(s.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0]
}

/** Extension point: a future index provider can replace selection with evidence and explicit uncertainty. */
export interface ImpactProvider { select(plan: QualityPlan, changed: readonly string[]): Promise<TestSelection> }
export const staticImpactProvider: ImpactProvider = { select: selectImpactedTests }

export async function selectImpactedTests(plan: QualityPlan, changed: readonly string[]): Promise<TestSelection> {
  const tests = plan.files.filter(isTestFile)
  const reasons = [...plan.reasons]
  const all = (reason: string): TestSelection => ({ strategy: 'repository-fallback', files: tests, reasons: [...reasons, reason], complete: plan.complete })
  if (!plan.complete) return all('incomplete discovery; selected every discovered test')
  if (getConfig().mode === 'strict') return all('strict mode requests repository test scope')
  if (changed.some((f) => !CODE.test(f) || /(?:config|setup|fixture|lock)/i.test(toRelative(f, plan.root)))) return all('configuration, fixture or non-code change')
  const known = new Set(plan.files)
  const reverse = new Map<string, Set<string>>()
  let uncertain = false
  for (const file of plan.files.filter((f) => CODE.test(f))) {
    const content = await readFile(file, 'utf8').catch(() => { uncertain = true; return '' })
    if (/\b(?:setupFiles|globalSetup|projects|workspace|testMatch|testRegex|include)\s*:/.test(content)) uncertain = true
    if (/\b(?:import|require)\s*\(\s*(?!['"])/.test(content) || /\b(?:readFile|readFileSync|glob|fetch)\s*\(/.test(content)) uncertain = true
    const imports = [...content.matchAll(/(?:\bfrom\s*|\bimport\s*|\b(?:import|require)\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const spec of imports) {
      // Bare imports can be workspace packages/aliases. Prefer broad evidence.
      if (!spec.startsWith('.')) { if (!['vitest', '@jest/globals'].includes(spec) && !spec.startsWith('node:')) uncertain = true; continue }
      const base = path.resolve(path.dirname(file), spec)
      const withoutJs = base.replace(/\.[cm]?jsx?$/, '')
      const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cts', '.cjs'].flatMap((ext) => [base + ext, withoutJs + ext, path.join(base, 'index' + ext)])]
      const target = candidates.find((c) => known.has(c))
      if (!target) { uncertain = true; continue }
      const dependents = reverse.get(target) ?? new Set<string>()
      dependents.add(file)
      reverse.set(target, dependents)
    }
  }
  if (uncertain) return all('unresolved, dynamic, workspace or runtime dependency')
  const reached = new Set(changed)
  const queue = [...changed]
  while (queue.length) for (const dependent of reverse.get(queue.pop()!) ?? []) if (!reached.has(dependent)) { reached.add(dependent); queue.push(dependent) }
  if ([...reached].some((f) => /(?:config|setup|fixture)/i.test(toRelative(f, plan.root)))) return all('change reaches test configuration or shared setup')
  const selected = tests.filter((t) => reached.has(t))
  // Name conventions are hints, never proof of an exhaustive dependency relation.
  if (!selected.length || changed.some((f) => !known.has(f) || (!isTestFile(f) && !reverse.has(f)))) {
    const scopes = new Set(changed.map((f) => scopeFor(plan, f)?.dir))
    if (scopes.has(undefined)) return all('changed file has no package scope')
    return { strategy: 'package-fallback', files: tests.filter((t) => scopes.has(scopeFor(plan, t)?.dir)), reasons: ['no provable test dependency; running changed packages'], complete: true }
  }
  return { strategy: 'dependency', files: selected, reasons: ['transitive reverse imports, including changed tests'], complete: true }
}
