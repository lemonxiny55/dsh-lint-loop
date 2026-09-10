/** Standalone probe: run this plugin's detection + lint pipeline against REAL
 *  linters — the fastest way to verify JSON shapes and flags outside the harness.
 *
 *  Usage: node scripts/probe-linter.mjs [repoRoot] [file]
 *  - repoRoot: a git repo (default: cwd)
 *  - file:     the file to lint (default: auto-picks the first .ts/.js/.py file)
 *
 *  Prints: detected configs, chosen linter per file, resolved command, the RAW
 *  linter output, and the parsed findings. Exit code 1 on failure.
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chooseLinter, detectLinters } from '../dist/index.js'
import { LintManager } from '../dist/index.js'
import { LINTER_SPECS, resolveCommand } from '../dist/index.js'
import { getConfig } from '../dist/index.js'

const root = path.resolve(process.argv[2] ?? process.cwd())
const fileArg = process.argv[3]

const detected = await detectLinters(root)
console.log(`[probe] repo root: ${root}`)
console.log(`[probe] detected: ${JSON.stringify(detected)}`)

const candidates = fileArg
  ? [path.isAbsolute(fileArg) ? path.resolve(fileArg) : path.resolve(root, fileArg)]
  : (await readdir(root))
      .filter((name) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/.test(name))
      .slice(0, 3)
      .map((name) => path.join(root, name))

if (candidates.length === 0) {
  console.error('[probe] no candidate files — pass one as argv[2]')
  process.exit(1)
}

const manager = new LintManager(root)
for (const file of candidates) {
  const linter = await chooseLinter(root, file)
  console.log(`\n[probe] ${path.relative(root, file)} → linter: ${linter ?? 'NONE'}`)
  if (!linter) continue
  const spec = LINTER_SPECS[linter]
  const { command, args } = resolveCommand(spec, getConfig().linterPath[linter], [...spec.lintArgs, file])
  console.log(`[probe] command: ${command} ${args.join(' ')}`)
  try {
    const findings = await manager.lintFile(file)
    console.log(`[probe] parsed ${findings.length} finding(s):`)
    for (const finding of findings.slice(0, 10)) {
      console.log(
        `  ${finding.file}:${finding.line}:${finding.col}  ${finding.severity}  ${finding.rule}  ${finding.message.slice(0, 80)}${finding.fixable ? '  [fixable]' : ''}`,
      )
    }
  } catch (error) {
    console.error(`[probe] lint failed: ${error.message}`)
    process.exitCode = 1
  }
}
