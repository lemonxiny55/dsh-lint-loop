// Declare explicit package boundaries for the isolated demo installations.
import { mkdir, writeFile } from 'node:fs/promises'
for (const name of ['dsh021', 'demo-v070']) {
  const directory = new URL(`../.cache/${name}/`, import.meta.url)
  await mkdir(directory, { recursive: true })
  try { await writeFile(new URL('package.json', directory), '{"private":true}\n', { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
