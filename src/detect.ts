/**
 * Zero-config linter detection: probe a repo root for eslint / biome / ruff
 * configuration files, cache per root, and invalidate when a config file
 * changes (the fs/observed listener calls `invalidateProbes`).
 */

import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getConfig } from './config.js'
import { linterFamilyForExt, LINTER_KEYS, type LinterKey } from './linters.js'

export interface DetectedLinters {
  eslint: boolean
  biome: boolean
  ruff: boolean
}

const ESLINT_CONFIG_FILES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
] as const

const BIOME_CONFIG_FILES = ['biome.json', 'biome.jsonc'] as const

const RUFF_CONFIG_FILES = ['ruff.toml', '.ruff.toml'] as const

/** Every config basename that feeds the probe — a change to any of these invalidates the cache. */
const ALL_CONFIG_BASENAMES = new Set<string>([
  ...ESLINT_CONFIG_FILES,
  ...BIOME_CONFIG_FILES,
  ...RUFF_CONFIG_FILES,
  'pyproject.toml',
])

/** Basename check for the fs/observed listener (sync, cheap). */
export function isLinterConfigBasename(basename: string): boolean {
  return ALL_CONFIG_BASENAMES.has(basename)
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function hasToolRuffSection(pyproject: string): Promise<boolean> {
  let content: string
  try {
    content = await readFile(pyproject, 'utf8')
  } catch {
    return false
  }
  // [tool.ruff] and any subtable like [tool.ruff.lint].
  return /^\s*\[tool\.ruff(?:\.[a-zA-Z0-9_]+)*\]/m.test(content)
}

/** Probe a repo root for linter configurations. */
export async function detectLinters(root: string): Promise<DetectedLinters> {
  const checks = await Promise.all([
    Promise.all(ESLINT_CONFIG_FILES.map((name) => exists(path.join(root, name)))),
    Promise.all(BIOME_CONFIG_FILES.map((name) => exists(path.join(root, name)))),
    Promise.all(RUFF_CONFIG_FILES.map((name) => exists(path.join(root, name)))),
    hasToolRuffSection(path.join(root, 'pyproject.toml')),
  ])
  return {
    eslint: checks[0].some(Boolean),
    biome: checks[1].some(Boolean),
    ruff: checks[2].some(Boolean) || checks[3],
  }
}

/** Probe cache, keyed by resolved root. */
const cache = new Map<string, DetectedLinters>()

export function invalidateProbes(): void {
  cache.clear()
}

/** Cached probe for a root (resolves through the `linters` config filter). */
export async function probeLinters(root: string): Promise<DetectedLinters> {
  const resolved = path.resolve(root)
  const cached = cache.get(resolved)
  if (cached) return cached
  const detected = await detectLinters(resolved)
  cache.set(resolved, detected)
  return detected
}

/**
 * Which linters are usable for `root`: auto-detected ones, filtered by an
 * explicit `linters` config when one is set.
 */
export async function usableLinters(root: string): Promise<LinterKey[]> {
  const detected = await probeLinters(root)
  const forced = getConfig().linters
  const eligible = [...LINTER_KEYS].filter((key) => detected[key])
  if (forced.length === 0) return eligible
  const allowed = new Set<LinterKey>(forced)
  return eligible.filter((key) => allowed.has(key))
}

/**
 * Pick the linter for a file:
 * - `.py/.pyi` → ruff (when usable),
 * - JS-family → eslint by default; biome only when a biome config exists and
 *   an eslint config does NOT (multiple coexisting configs route by extension,
 *   and eslint wins the tie — per the plugin's routing rule).
 * Returns null when the family is supported but no usable linter exists.
 */
export async function chooseLinter(root: string, absPath: string): Promise<LinterKey | null> {
  const family = linterFamilyForExt(path.extname(absPath))
  if (!family) return null
  const usable = await usableLinters(root)
  if (family === 'py') {
    return usable.includes('ruff') ? 'ruff' : null
  }
  if (usable.includes('eslint')) return 'eslint'
  if (usable.includes('biome')) return 'biome'
  return null
}
