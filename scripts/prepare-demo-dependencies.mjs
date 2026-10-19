// Explicit package boundaries prevent npm 10 from inspecting the parent's pnpm tree.
import { mkdir, writeFile } from 'node:fs/promises'
for (const name of ['dsh021', 'demo-v070']) {
  const directory = new URL(`../.cache/${name}/`, import.meta.url)
  await mkdir(directory, { recursive: true })
  try { await writeFile(new URL('package.json', directory), '{"private":true}\n', { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
