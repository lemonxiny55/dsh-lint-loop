// Build a bounded reader-pool comparison without changing production source/config.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('tsup'))('esbuild')
const comparisonReaders = Number(process.argv[2] ?? 1)
assert.ok(Number.isInteger(comparisonReaders) && comparisonReaders >= 1 && comparisonReaders <= 32, 'reader count must be an integer from 1 through 32')
const source = await readFile('src/evidence.ts', 'utf8')
const [marker] = source.match(/pending\.length === \d+/g) ?? []
assert.ok(marker && source.indexOf(marker) === source.lastIndexOf(marker), 'expected exactly one reader-pool limit')
const productionReaders = Number(marker.match(/\d+/)?.[0])
const variant = source.replace(marker, `pending.length === ${comparisonReaders}`)
const output = path.resolve(comparisonReaders === 1 ? '.cache/benchmark-serial/index.mjs' : `.cache/benchmark-readers/${comparisonReaders}/index.mjs`)
await mkdir(path.dirname(output), { recursive: true })
await build({ entryPoints: ['src/index.ts'], outfile: output, bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node22',
  plugins: [{ name: 'one-reader-comparison', setup(builder) {
    builder.onLoad({ filter: /[\\/]evidence\.ts$/ }, () => ({ contents: variant, loader: 'ts', resolveDir: path.resolve('src') }))
  } }],
})
const sha256 = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
console.log(JSON.stringify({ output, productionReaders, comparisonReaders, productionSourceSha256: sha256(source), comparisonSourceSha256: sha256(variant) }, null, 2))

