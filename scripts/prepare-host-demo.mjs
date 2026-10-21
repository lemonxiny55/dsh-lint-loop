// Creates only an isolated, local acceptance driver and config. Installs nothing globally.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const host = process.argv[2] ?? 'web'
if (!['web', 'desktop'].includes(host)) throw new Error('host must be web or desktop')
const dir = path.resolve('.cache/host-demo-' + host)
await mkdir(dir, { recursive: true })
const config = { runtime: path.resolve('.cache/dsh021'), dependencies: path.resolve('.cache/demo-v070'), output: path.join(dir, 'output'), mount: false }
await writeFile(path.join(dir, 'config.json'), JSON.stringify(config))
const driver = `import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {runDemo} from ${JSON.stringify(pathToFileURL(path.resolve('scripts/dsh-runtime-demo.mjs')).href)};
import {runShellDemo} from ${JSON.stringify(pathToFileURL(path.resolve('scripts/dsh-shell-demo.mjs')).href)};
export const name='evidence-demo-driver';
export const inject=['agentLoop','tools','agents','llm','fs','workingDirectory'];
export function apply(ctx){
 const timer=setTimeout(async()=>{
  const config=JSON.parse(await readFile(${JSON.stringify(path.join(dir, 'config.json'))},'utf8'));
  try{const demo=await runDemo(ctx,config);await runShellDemo(ctx,{root:demo.root,output:config.output});await writeFile(config.output+'/completed.json',JSON.stringify({passed:true,agentDisposed:true}))}catch(error){await mkdir(config.output,{recursive:true});await writeFile(config.output+'/failure.json',JSON.stringify({error:String(error),stack:error.stack}));console.error('[evidence-demo] failed: '+error.message)}
 },2000);
 return()=>clearTimeout(timer);
}
`
await writeFile(path.join(dir, 'driver.mjs'), driver)
await writeFile(path.join(dir, 'overlay.yml'), `- id: session-title-llm\n  disabled: true\n- id: lint-loop\n  config:\n    autoInject: false\n    gate: true\n    qualityTimeoutMs: 30000\n- insert:\n    - id: evidence-demo-driver\n      name: ${JSON.stringify(path.join(dir, 'driver.mjs').replaceAll('\\', '/'))}\n`)
console.log(path.join(dir, 'overlay.yml'))
