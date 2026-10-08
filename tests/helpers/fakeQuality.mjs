// Protocol fake: process exits, malformed reports and hangs are exercised without mocks.
import { readFile, readdir, appendFile } from 'node:fs/promises'
import path from 'node:path'
const files = []
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(file)
    else if (file.endsWith('.ts')) files.push(file)
  }
}
await walk(process.cwd())
const texts = await Promise.all(files.map((f) => readFile(f, 'utf8')))
if (process.env.QUALITY_RUN_LOG) await appendFile(process.env.QUALITY_RUN_LOG, JSON.stringify(process.argv.slice(1)) + '\n')
if (texts.some((t) => t.includes('// hang'))) await new Promise(() => setInterval(() => {}, 1000))
if (texts.some((t) => t.includes('// invalid'))) { console.log('not a report'); process.exit(2) }
if (process.argv[1].endsWith('tsc')) {
  let count = 0
  texts.forEach((text, index) => {
    for (const match of text.matchAll(/\/\/ type: (TS\d+) (.*)/g)) {
      const line = text.slice(0, match.index).split('\n').length
      console.log(`${path.relative(process.cwd(), files[index])}(${line},1): error ${match[1]}: ${match[2]}`)
      count++
    }
  })
  process.exit(count ? 2 : 0)
}
const requested = process.argv.slice(2).filter((arg) => arg.endsWith('.ts'))
const testResults = []
let total = 0, failed = 0
texts.forEach((text, index) => {
  if (!/\.(spec|test)\.ts$/.test(files[index])) return
  if (requested.length && !requested.includes(files[index])) return
  const assertionResults = [...text.matchAll(/\/\/ case: (\S+) (PASS|FAIL)(?: (.*))?/g)].map((m) => {
    total++
    if (m[2] === 'FAIL') failed++
    return { fullName: m[1], status: m[2] === 'FAIL' ? 'failed' : 'passed', failureMessages: m[2] === 'FAIL' ? [m[3] || 'failure'] : [] }
  })
  testResults.push({ name: files[index], status: assertionResults.some((r) => r.status === 'failed') ? 'failed' : 'passed', assertionResults })
})
console.log(JSON.stringify({ numTotalTests: total, success: !failed, testResults }))
process.exit(failed ? 1 : 0)
