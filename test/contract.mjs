// The drift guard.
//
// Four files in this repo are copies of files in Figsnap: shared/shape.mjs,
// shared/nodes.mjs, agent/lib/tools.mjs and src/code.ts. Nothing enforces that
// they stay in step with each other, and the protocol between them has no
// shared type — it is a convention in three places (src/ui/bridge.ts,
// agent/lib/plugin-socket.mjs, src/code.ts's switch) and `requestedDepth` has
// already drifted once between shared/shape.mjs and src/code.ts.
//
// So this suite asserts the joins that a one-sided edit would break. It needs no
// daemon, no network and no Figma: it reads the source and calls the catalogue.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TOOLS_BY_NAME, toolManifest } from '../agent/lib/tools.mjs'
import { FINDABLE_TYPES } from '../shared/nodes.mjs'
import { batchCommand, savedAddCommand, savedDeleteCommand, folderWriteCommand } from '../shared/shape.mjs'
import { DEFAULT_AGENT_URL, DEFAULT_PORT, HOST, PANEL_PATH, TOKEN_FILE } from '../agent/lib/paths.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const code = await readFile(join(root, 'src/code.ts'), 'utf8')
const tools = await readFile(join(root, 'agent/lib/tools.mjs'), 'utf8')
const panel = await readFile(join(root, 'src/ui/main.ts'), 'utf8')

/** A `const NAME = 123` in a module that does not export it. */
function constant(source, name) {
  const match = new RegExp(`const ${name} = (\\d+)`).exec(source)
  return match === null ? null : Number(match[1])
}

// -------------------------------------------------- every command is answered
//
// A tool names a command; the plugin's `handleRequest` switch answers it. A tool
// pointing at a case that is not there fails at the far end of the chain, with
// "Unknown command", after a round trip through Figma.

const switchStart = code.indexOf('async function handleRequest')
const switchEnd = code.indexOf('figma.ui.onmessage')
check('handleRequest and the panel switch are both still there',
  switchStart !== -1 && switchEnd > switchStart, `${switchStart} ${switchEnd}`)

const answered = new Set(
  Array.from(code.slice(switchStart, switchEnd).matchAll(/case '([a-z_]+)':/g)).map((match) => match[1]),
)

/**
 * The commands a tool can name. Most are a string; two are a function of the
 * arguments, so every branch of those is probed rather than assumed — that is
 * the half most likely to drift, because the branches live in shared/shape.mjs.
 */
const PROBES = {
  figma_extract: [{}, { selection: true }, { nodeIds: ['1:2'] }, { urls: ['x'] }, { saved: true }],
  figma_saved: [
    { action: 'list' },
    { action: 'folders' },
    { action: 'save' },
    { action: 'save', nodeIds: ['1:2'] },
    { action: 'unsave', nodeIds: ['1:2'] },
    { action: 'clear' },
    { action: 'clear', folder: 'x' },
    { action: 'move', nodeIds: ['1:2'], folder: 'x' },
    { action: 'newFolder', name: 'x' },
    { action: 'renameFolder', from: 'x', to: 'y' },
    { action: 'deleteFolder', name: 'x' },
  ],
}

const wanted = new Set()
const dynamic = []
for (const [name, tool] of TOOLS_BY_NAME) {
  if (typeof tool.command === 'string') {
    wanted.add(tool.command)
    continue
  }
  dynamic.push(name)
  const probes = PROBES[name]
  if (probes === undefined) continue
  for (const args of probes) wanted.add(tool.command(args))
}

check('every tool whose command is computed has probes here',
  dynamic.every((name) => PROBES[name] !== undefined),
  dynamic.filter((name) => PROBES[name] === undefined).join())

const missing = [...wanted].filter((command) => !answered.has(command)).sort()
check('every command a tool can name is a case in src/code.ts',
  missing.length === 0, missing.join())

// The other direction. A case with no tool is a command no MCP client can ever
// reach — which is what the plugin's chat used to be for, and is now dead code.
const unreachable = [...answered].filter((command) => !wanted.has(command)).sort()
check('and every case in that switch is reachable from a tool',
  unreachable.length === 0, unreachable.join())

check('the 39 tools cover the whole switch',
  toolManifest().length === 39 && answered.size === wanted.size,
  `${toolManifest().length} tools reach ${wanted.size} of ${answered.size} cases`)

// ------------------------------------------------------------------- the caps
//
// Written down twice on purpose — the plugin enforces them, the tool schema
// advertises them — so a caller is told the truth before it asks.

const codeBatch = constant(code, 'MAX_BATCH')
const toolBatch = constant(tools, 'MAX_BATCH')
check('MAX_BATCH agrees between the plugin and the catalogue',
  codeBatch !== null && codeBatch === toolBatch, `code ${codeBatch}, tools ${toolBatch}`)

const maxSaved = constant(code, 'MAX_SAVED')
const maxFolders = constant(code, 'MAX_FOLDERS')
const maxFolderName = constant(code, 'MAX_FOLDER_NAME')
check('the saved-set caps are still the ones this repo was built around',
  maxSaved === 100 && maxFolders === 30 && maxFolderName === 40,
  `${maxSaved}/${maxFolders}/${maxFolderName}`)
// The panel prints them at the designer, so a cap changed in one place and not
// the other tells them something untrue about their own file.
const quoted = {
  entries: panel.includes(`/${maxSaved} saved`),
  folders: panel.includes(`/${maxFolders} folders`),
  name: panel.includes(`input.maxLength = ${maxFolderName}`),
}
check('and the panel quotes the same numbers',
  quoted.entries && quoted.folders && quoted.name,
  Object.entries(quoted).filter(([, ok]) => !ok).map(([what]) => what).join())

// ------------------------------------------------------------ findable types
//
// One list, two sandboxes: the schema advertises it and the plugin checks
// against it. A list that drifted would refuse something it had just offered.

const advertised = toolManifest().find((tool) => tool.name === 'figma_find_nodes')
  .inputSchema.properties.types.items.enum
check('the find_nodes schema offers exactly the findable types',
  advertised.join() === FINDABLE_TYPES.join(), advertised.join())
check('and the plugin validates against that same list, not a copy of it',
  code.includes("import { FINDABLE_TYPES } from '../shared/nodes.mjs'") &&
  code.includes('FINDABLE_TYPES.includes(type)'))

// -------------------------------------------------- what a request body means
//
// shared/shape.mjs decides which command a body asks for. tools.mjs calls those
// same functions rather than saying it a second time, and this is the assertion
// that keeps it that way.

check('a saved body with ids is save_nodes, without them save_selection',
  savedAddCommand({ nodeIds: ['1'] }) === 'save_nodes' && savedAddCommand({}) === 'save_selection')
check('a delete body naming everything is clear_saved, naming ids is unsave',
  savedDeleteCommand({ all: true }) === 'clear_saved' && savedDeleteCommand({ nodeIds: ['1'] }) === 'unsave')
check('a folder body with a `from` is a rename, without one a create',
  folderWriteCommand({ from: 'a', to: 'b' }) === 'rename_folder' && folderWriteCommand({ name: 'a' }) === 'create_folder')
check('and a batch body names the batch it meant',
  batchCommand({ selection: true }) === 'extract_selection' &&
  batchCommand({ nodeIds: ['1'] }) === 'extract_nodes' &&
  batchCommand({ urls: ['u'] }) === 'extract_urls' &&
  batchCommand({ saved: true }) === 'extract_saved' &&
  batchCommand({ nodeId: '1' }) === null)

// ------------------------------------------------------------- the two ports
//
// The whole reason this repo is separate from Figsnap is that both can run at
// once. Three files have to agree on 3058, and one of them is the manifest,
// which Figma reads rather than this code.

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const daemonSource = await readFile(join(root, 'src/daemon.ts'), 'utf8')
const indexSource = await readFile(join(root, 'agent/index.mjs'), 'utf8')
const stdioSource = await readFile(join(root, 'agent/mcp-stdio.mjs'), 'utf8')

const domains = manifest.networkAccess.allowedDomains
check('the manifest allows the daemon’s port and nothing else',
  domains.join() === 'ws://localhost:3058,http://localhost:3058', domains.join())
// Figma validates this list and refuses an IP literal — "Invalid value for
// allowedDomains. 'ws://127.0.0.1:3058' must be a valid URL" — and a manifest it
// refuses is a manifest it does not load, so the plugin silently keeps running
// the last good one. That failure is invisible except in the console.
check('and names hosts the way Figma will accept, never an IP literal',
  domains.every((domain) => !/\d+\.\d+\.\d+\.\d+/.test(domain)), domains.join())
check('the panel dials the same host the manifest names',
  panel.includes('asked.hostname === wanted.hostname'))
check('and dev builds are allowed exactly the same',
  domains.join() === manifest.networkAccess.devAllowedDomains.join())
// Figma keys clientStorage by plugin id, so two plugins sharing one id share
// their stored settings — which is how this panel once read Figsnap's daemon
// address and dialled a port its own manifest forbids.
// Figma assigns a real id on first publish and writes it into this file, so the
// invariant is "not Figsnap's", not "still the placeholder". Asserting the
// placeholder would turn publishing the plugin into a failing test.
check('the plugin has an id of its own, not Figsnap’s',
  typeof manifest.id === 'string' && manifest.id !== '' && manifest.id !== 'REPLACE_ON_PUBLISH',
  manifest.id)
check('and every clientStorage key is namespaced to this plugin as well',
  ['STORAGE_KEY', 'SETTINGS_KEY', 'AGENT_KEY', 'SIZE_KEY'].every((name) =>
    new RegExp(`const ${name} = \`?'?figsnap-mcp:`).test(code)),
  ['STORAGE_KEY', 'SETTINGS_KEY', 'AGENT_KEY', 'SIZE_KEY']
    .filter((name) => !new RegExp(`const ${name} = \`?'?figsnap-mcp:`).test(code)).join())
check('the panel refuses an address outside what the manifest allows',
  panel.includes('function reachable(') && panel.includes('asked.port === wanted.port'))
check('and no relay is reachable from the plugin any more',
  !JSON.stringify(manifest).includes('workers.dev'))
// Imported rather than grepped: agent/lib/paths.mjs is the one definition, and
// importing it is also the assertion that it can be imported without starting a
// server — which is what these constants used to cost.
check('the daemon and the MCP server share one definition of the port',
  DEFAULT_PORT === 3058 && DEFAULT_AGENT_URL === `http://${HOST}:${DEFAULT_PORT}`,
  `${DEFAULT_PORT} ${DEFAULT_AGENT_URL}`)
check('and one definition of the token file',
  TOKEN_FILE.endsWith('/.figsnap-mcp/agent-token'), TOKEN_FILE)
/** Source with the comment lines taken out, so prose about a port is not a port. */
const withoutComments = (source) =>
  source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
check('neither writes the port out a second time',
  ![indexSource, stdioSource].some((source) => withoutComments(source).includes(String(DEFAULT_PORT))),
  [indexSource, stdioSource]
    .map((source) => (withoutComments(source).includes(String(DEFAULT_PORT)) ? 'has one' : 'clean')).join())
// The plugin cannot import that module — it is bundled into a Figma sandbox with
// no Node — so this is the join that has to be checked rather than shared.
check('the plugin dials the same port from its own copy',
  daemonSource.includes(`ws://localhost:${DEFAULT_PORT}${PANEL_PATH}`),
  daemonSource.split('\n').filter((line) => line.includes('AGENT_URL')).join())
check('and none of the three reads Figsnap’s environment',
  ![indexSource, stdioSource].some((source) => /FIGSNAP_AGENT_|FIGSNAP_ALLOW_EDITS|FIGSNAP_REQUIRE_LOGIN/.test(source)))

// ------------------------------------------------------- nothing came with it
//
// The point of the fork is what is absent. These are the imports that would
// quietly drag the relay, the accounts or the ACP client back in.

for (const [what, needle] of [
  ['the ACP client', /acp\.mjs/],
  ['the account gate', /account\.mjs/],
  ['the session store', /sessions\.mjs/],
  ['harness discovery', /harnesses\.mjs/],
  ['the relay address', /shared\/relay\.mjs/],
]) {
  check(`${what} is not imported anywhere`,
    ![code, tools, panel, indexSource, stdioSource, daemonSource].some((source) => needle.test(source)))
}

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
