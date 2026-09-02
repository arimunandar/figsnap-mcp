// What ships, and what a consumer gets when it does.
//
// Everything else in this directory tests the running system. This tests the
// artefact: the tarball's contents, the two bins, the library entry point and
// the declarations that describe it. The failures it is here to catch are the
// ones that only appear after `npm publish` — a bin that is not executable, a
// dist that was never built, a test fixture shipped to strangers, an export
// declared in the types and missing from the runtime.

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { freePort, until } from './support/plugin.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

/**
 * The environment minus npm's own, for the npm subcommands below.
 *
 * This suite runs under `npm test`, and during a release under `npm publish` →
 * prepublishOnly → `npm test`. npm exports its whole configuration to child
 * processes as npm_config_*, so a nested `npm pack` inherits the settings of
 * the publish that is running it — including userconfig, and whatever the CI
 * runner put in it. Starting the child from a clean slate is the difference
 * between testing this package and testing the command that happened to invoke
 * the test.
 */
function withoutNpmConfig() {
  const clean = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('npm_') && !key.startsWith('NPM_')) clean[key] = value
  }
  return clean
}

function run(command, args, options = {}) {
  return new Promise((settle) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('exit', (code) => settle({ code, stdout, stderr }))
  })
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

// ------------------------------------------------------------- package.json

check('the package is not private any more', manifest.private === undefined, String(manifest.private))
check('it is called figsnap-mcp and carries a licence',
  manifest.name === 'figsnap-mcp' && manifest.license === 'MIT', `${manifest.name} ${manifest.license}`)
check('it says which Node it needs', /^>=20/.test(manifest.engines?.node ?? ''), manifest.engines?.node)
// `npm ci` refuses a lockfile whose version disagrees, and CI runs npm ci
// before it runs anything else — so a hand-edited version breaks the release
// at the first step, with an error about the lockfile rather than the version.
check('and the lockfile agrees about the version',
  JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).version === manifest.version,
  JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).version)
check('it is ESM, so the .mjs files load as written', manifest.type === 'module', manifest.type)
check('and it points at a repository, a homepage and an issue tracker',
  typeof manifest.repository?.url === 'string' && typeof manifest.homepage === 'string' &&
  typeof manifest.bugs?.url === 'string')

// The two things that ship at runtime. Everything else is a build or test tool,
// and a dependency listed in the wrong half is installed into every consumer.
check('two runtime dependencies, both of them load-bearing',
  Object.keys(manifest.dependencies).join() === '@modelcontextprotocol/sdk,ws',
  Object.keys(manifest.dependencies).join())
check('and nothing is in both halves',
  Object.keys(manifest.dependencies).every((name) => manifest.devDependencies[name] === undefined))
check('the ACP SDK went with the ACP client', manifest.dependencies['@agentclientprotocol/sdk'] === undefined)

// prepublishOnly is the last gate before the registry, and it has to run the
// things that would otherwise be found by whoever installed it.
check('publishing runs the typecheck, the build and the tests first',
  ['typecheck', 'build', 'test'].every((script) => manifest.scripts.prepublishOnly.includes(script)),
  manifest.scripts.prepublishOnly)
check('and packing builds, so dist is never stale in a tarball',
  manifest.scripts.prepack.includes('build'), manifest.scripts.prepack)

// ----------------------------------------------------------- the MCP registry
//
// Four version fields have to agree — the git tag, package.json, server.json and
// the package pin inside it — and three of them are in files nobody edits
// together. The registry rejects a mismatch after the npm publish has already
// gone out, which is the worst moment to find out.

const server = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'))

check('the registry name is the npm ownership proof, and vice versa',
  server.name === manifest.mcpName && typeof manifest.mcpName === 'string',
  `${server.name} / ${manifest.mcpName}`)
// With GitHub authentication the namespace must be the publisher's own, and
// mcp-publisher refuses anything else — after npm has already been published.
check('and the namespace is one GitHub auth can prove',
  /^io\.github\.[a-z0-9-]+\/[a-z0-9-]+$/.test(server.name), server.name)
check('server.json, its package pin and package.json are the same version',
  server.version === manifest.version && server.packages[0].version === manifest.version,
  `${server.version} / ${server.packages[0].version} / ${manifest.version}`)
check('and it points at this npm package over stdio',
  server.packages[0].identifier === manifest.name &&
  server.packages[0].registryType === 'npm' &&
  server.packages[0].transport.type === 'stdio',
  `${server.packages[0].identifier} ${server.packages[0].registryType}`)
// Both are optional, and one is a secret. A registry entry that marked either
// required would tell every installer to go and find a value they do not need.
check('neither environment variable is presented as required',
  server.packages[0].environmentVariables.every((variable) => variable.isRequired === false) &&
  server.packages[0].environmentVariables.find((v) => v.name === 'FIGSNAP_MCP_TOKEN').isSecret === true,
  server.packages[0].environmentVariables.map((v) => v.name).join())

// --------------------------------------------------------------------- bins

for (const [name, target] of Object.entries(manifest.bin)) {
  const path = join(root, target)
  const info = await stat(path).catch(() => null)
  const source = info === null ? '' : await readFile(path, 'utf8')
  check(`${name} exists and starts with a shebang`,
    info !== null && source.startsWith('#!/usr/bin/env node'), target)
  // npm sets the executable bit when it packs, but only for files it can see as
  // scripts; a bin that lost it is a "command not found" for everyone.
  check(`${name} is executable`, info !== null && (info.mode & 0o111) !== 0,
    info === null ? 'missing' : (info.mode & 0o777).toString(8))
}

check('both bins are inside the published file list',
  Object.values(manifest.bin).every((target) => manifest.files.some((entry) => target.startsWith(entry))),
  manifest.files.join())

const versions = await Promise.all(
  Object.values(manifest.bin).map((target) => run(process.execPath, [join(root, target), '--version'])),
)
check('both answer --version with the package version',
  versions.every((result) => result.code === 0 && result.stdout.trim() === manifest.version),
  versions.map((result) => `${result.code}:${result.stdout.trim()}`).join(' '))

const help = await run(process.execPath, [join(root, manifest.bin['figsnap-mcp-daemon']), '--help'])
check('the daemon has a --help that names its flags and its environment',
  help.code === 0 && help.stdout.includes('--allow-edits') && help.stdout.includes('FIGSNAP_MCP_PORT'),
  String(help.code))

const badPort = await run(process.execPath, [join(root, manifest.bin['figsnap-mcp-daemon'])], {
  env: { ...process.env, FIGSNAP_MCP_PORT: 'ninety' },
})
check('a port that is not a port is refused by name, not by stack trace',
  badPort.code === 1 && badPort.stderr.includes('not a port number') && !badPort.stderr.includes('at Object'),
  badPort.stderr.trim().slice(0, 90))

// The failure a first run actually hits: Figsnap's daemon on 3056, a second copy
// of this one, or a stale process. It reached uncaughtException as a stack trace
// through node:net until `ws` was found to be re-emitting the HTTP server's
// error on the WebSocketServer, where nothing was listening — an EventEmitter
// given an 'error' with no listener throws, so the handler that produces this
// message never ran. Cheap to assert, and invisible when it breaks.
const held = await freePort()
const first = spawn(process.execPath, [join(root, manifest.bin['figsnap-mcp-daemon']), '--quiet'], {
  cwd: root,
  env: { ...process.env, FIGSNAP_MCP_PORT: String(held), FIGSNAP_MCP_TOKEN: 'a-token-for-this-suite' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
first.stdout.on('data', () => {})
first.stderr.on('data', () => {})
await until(async () => (await fetch(`http://127.0.0.1:${held}/health`)).ok, 15_000, 'the first daemon')

const second = await run(process.execPath, [join(root, manifest.bin['figsnap-mcp-daemon'])], {
  env: { ...process.env, FIGSNAP_MCP_PORT: String(held) },
})
check('a port already in use is explained, not thrown',
  second.code === 1 &&
  second.stderr.includes(`Port ${held} is already in use`) &&
  !second.stderr.includes('node:net'),
  second.stderr.trim().split('\n')[0])
first.kill('SIGTERM')

// ------------------------------------------------------- the library entry
//
// The reason this file exists at all: agent/mcp-stdio.mjs connects an MCP server
// to stdio when it is loaded, so anything that re-exported from it would hijack
// the importer's stdout. Importing the package must be inert.

const imported = await run(process.execPath, [
  '--input-type=module',
  '-e',
  `const m = await import(${JSON.stringify(join(root, 'index.mjs'))});
   process.stdout.write(JSON.stringify(Object.keys(m).sort()))`,
])
check('importing the package prints nothing of its own and exits',
  imported.code === 0 && imported.stdout.startsWith('['), `${imported.code} ${imported.stderr.slice(0, 120)}`)

const exported = imported.code === 0 ? JSON.parse(imported.stdout) : []
check('and it exports the catalogue, the constants and the bridge',
  ['toolManifest', 'TOOLS_BY_NAME', 'FINDABLE_TYPES', 'DEFAULT_PORT', 'TOKEN_FILE',
   'createGate', 'createPluginSocket', 'createHttpHandler', 'runTool', 'batchCommand']
    .every((name) => exported.includes(name)),
  exported.join())
check('but not the MCP server, which cannot be imported without becoming one',
  !exported.some((name) => name.toLowerCase().includes('stdio')), exported.join())

// Declarations and runtime, in both directions. A type that describes something
// no longer exported is worse than no type at all.
const types = await readFile(join(root, 'index.d.mts'), 'utf8')
const declared = [...types.matchAll(/export declare (?:const|function) (\w+)/g)].map((m) => m[1])
const undeclared = exported.filter((name) => !declared.includes(name))
const unimplemented = declared.filter((name) => !exported.includes(name))
check('every runtime export is declared in index.d.mts', undeclared.length === 0, undeclared.join())
check('and every declaration has something behind it', unimplemented.length === 0, unimplemented.join())

// --------------------------------------------------------------- the tarball

// The build first, then a pack that runs no scripts. `npm pack --json` puts the
// lifecycle scripts' own output on the same stdout as its JSON, and the build's
// first line is "[ui] dist/ui.html" — which starts with a bracket, so there is no
// reliable way to find where the document begins. Separating them is the fix.
// That prepack builds at all is asserted from package.json above.
const built = await run('npm', ['run', 'build'], { env: withoutNpmConfig() })
check('the plugin builds', built.code === 0, built.code === 0 ? '' : built.stderr.slice(-300))

const packed = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { env: withoutNpmConfig() })
// npm mixes its own log lines into the --json stream, and which lines appear
// depends on the environment rather than on this package: under GitHub Actions
// the .npmrc that actions/setup-node writes makes npm 12 emit
//   npm warn Unknown user config "always-auth"
// onto the same stdout as the document. Dropping npm's own prefixed lines is
// the parse that survives that; slicing from the first bracket does not, since
// a build's "[ui] dist/ui.html" is also a line starting with one.
let files = []
try {
  const document = packed.stdout
    .split('\n')
    .filter((line) => !/^npm (warn|notice|error|WARN|http)\b/.test(line.trim()))
    .join('\n')
  files = JSON.parse(document)[0].files.map((entry) => entry.path)
} catch (error) {
  files = []
}
check('npm pack succeeds and lists what it would send',
  packed.code === 0 && files.length > 0,
  packed.code === 0 && files.length > 0
    ? `${files.length} files`
    : `exit ${packed.code} · stdout[${packed.stdout.length}] ${JSON.stringify(packed.stdout.slice(0, 200))} · ` +
      `stderr ${JSON.stringify(packed.stderr.slice(-200))}`)

for (const wanted of [
  'package.json', 'README.md', 'LICENSE', 'index.mjs', 'index.d.mts', 'manifest.json',
  'agent/index.mjs', 'agent/mcp-stdio.mjs', 'agent/lib/tools.mjs', 'agent/lib/paths.mjs',
  'shared/nodes.mjs', 'shared/shape.mjs',
  // The plugin itself. Without these the manifest in the tarball points at
  // nothing and "Import plugin from manifest" fails on a file it cannot read.
  'dist/code.js', 'dist/ui.html',
]) {
  check(`the tarball carries ${wanted}`, files.includes(wanted), files.length ? '' : 'pack failed')
}

for (const [what, pattern] of [
  ['the test suite', /^test\//],
  ['the plugin sources', /^src\//],
  ['the build script', /^build\.mjs$/],
  ['the TypeScript config', /^tsconfig\.json$/],
  ['CI configuration', /^\.github\//],
  // Registry metadata, read by mcp-publisher from the repository. Shipping it
  // would put a second, staler copy of the version in every install.
  ['the registry metadata', /^server\.json$/],
  ['anything that looks like a token', /token/i],
  ['node_modules', /^node_modules\//],
]) {
  const found = files.filter((path) => pattern.test(path))
  check(`and does not carry ${what}`, found.length === 0, found.join())
}

check('the tarball is a sensible size for what it is',
  files.length > 12 && files.length < 60, `${files.length} files`)

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
