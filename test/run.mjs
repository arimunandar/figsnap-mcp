// Runs every suite in this directory and reports one summary.
//
// Nothing to start first. Figsnap's runner had to boot `wrangler dev` and hand
// its address to every suite through an environment variable, because the relay
// was a Cloudflare Worker; there is no relay here, so each suite starts whatever
// it needs on a free port of its own and they can run in any order.

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const files = (await readdir(here))
  .filter((name) => name.endsWith('.mjs') && name !== 'run.mjs')
  .sort()

const results = []
for (const file of files) {
  process.stdout.write(`\n\x1b[1m${file}\x1b[0m\n`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { cwd: root, stdio: 'inherit' })
    child.on('exit', (status) => resolve(status ?? 1))
  })
  results.push({ file, ok: code === 0 })
}

const failed = results.filter((result) => !result.ok)
console.log('\n' + '='.repeat(52))
for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.file}`)
console.log(`\n${results.length - failed.length}/${results.length} suites passed`)
process.exit(failed.length === 0 ? 0 : 1)
