// Build a one-reader comparison artifact without changing production source/config.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('tsup'))('esbuild')
const source = await readFile('src/evidence.ts', 'utf8')
const marker = 'pending.length === 4'
assert.equal(source.split(marker).length, 2, 'expected exactly one reader-pool limit')
const variant = source.replace(marker, 'pending.length === 1')
const output = path.resolve('.cache/benchmark-serial/index.mjs')
await mkdir(path.dirname(output), { recursive: true })
await build({ entryPoints: ['src/index.ts'], outfile: output, bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node22',
  plugins: [{ name: 'one-reader-comparison', setup(builder) {
    builder.onLoad({ filter: /[\\/]evidence\.ts$/ }, () => ({ contents: variant, loader: 'ts', resolveDir: path.resolve('src') }))
  } }],
})
const sha256 = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
console.log(JSON.stringify({ output, productionReaders: 4, comparisonReaders: 1, productionSourceSha256: sha256(source), comparisonSourceSha256: sha256(variant) }, null, 2))
