// The daemon and the MCP server, end to end.
//
// What this proves is the chain: an MCP client spawns agent/mcp-stdio.mjs, that
// posts to the daemon over loopback, and the daemon turns it into the `request`
// frame the panel has always answered. Nothing here touches Figma — the panel is
// a WebSocket client that answers commands the way the main thread would, which
// is what test/e2e-plugin.mjs then does for real.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'a-token-only-this-suite-knows'

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

function freePort() {
  return new Promise((settle) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => settle(port))
    })
  })
}

const HOME = await mkdtemp(join(tmpdir(), 'figsnap-mcp-suite-'))
const PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`

const daemon = spawn(process.execPath, [join(root, 'agent/index.mjs'), '--quiet'], {
  cwd: root,
  env: { ...process.env, FIGSNAP_MCP_PORT: String(PORT), FIGSNAP_MCP_TOKEN: TOKEN, HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const daemonErrors = []
daemon.stdout.on('data', () => {})
daemon.stderr.on('data', (chunk) => daemonErrors.push(chunk.toString()))

async function until(condition, timeoutMs = 20_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let ok = false
    try {
      ok = await condition()
    } catch {
      ok = false
    }
    if (ok) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${label}${daemonErrors.length ? `\n${daemonErrors.join('')}` : ''}`)
}

await until(async () => (await fetch(`${BASE}/health`)).ok, 15_000, 'the daemon')

// ---------------------------------------------------------------- the panel
//
// What the main thread would answer, for the commands used here.
//
// The saved set is modelled rather than echoed, because the thing worth
// asserting about `figma_saved` is that nine actions land on ten different
// commands with the right body — and a fake that only agreed with whatever it
// was sent could not tell a correct mapping from a wrong one.

const seen = []
const calls = []

// Real base64 of a real PNG signature: the MCP SDK validates an image block's
// `data`, so a fixture that only looked like base64 would be refused before any
// assertion in this suite got to see it.
const PNG_BASE64 = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 88)]).toString('base64')

const BIG_PNG_BASE64 = 'Q'.repeat(40_000)

function extraction(id, formats) {
  // `raw:` stands in for a plugin that answers with pngData and a big image —
  // which the tool schema no longer allows anyone to ask for, but the /tool
  // route still has to survive.
  if (id.startsWith('raw:') || id.startsWith('tiny:')) {
    const png = id.startsWith('tiny:') ? PNG_BASE64 : BIG_PNG_BASE64
    return { id, name: id, nodeType: 'FRAME', width: 375, height: 812, layerCount: 40, truncated: false, outputs: ['pngData'], png }
  }
  const outputs = Array.isArray(formats) && formats.length > 0 ? formats : ['html', 'figmaCss']
  const shaped = {
    id,
    name: `Layer ${id}`,
    nodeType: 'FRAME',
    width: 120,
    height: 40,
    layerCount: 3,
    truncated: false,
    outputs,
  }
  // The plugin exports once and lets `outputs` say which reference was wanted,
  // so both image outputs arrive as the same bytes on the payload.
  if (outputs.includes('png') || outputs.includes('pngData')) shaped.png = PNG_BASE64
  if (outputs.includes('html')) shaped.html = `<div id="${id}"></div>`
  if (outputs.includes('figmaCss')) shaped.figmaCss = `.a-${id} { width: 120px }`
  return shaped
}

const batch = (ids, formats) =>
  ({ results: ids.map((id) => ({ ref: id, nodeId: id, ok: true, extraction: extraction(id, formats) })) })

const saved = { folders: [], entries: [] }
const counts = () =>
  ['', ...saved.folders].map((name) => ({ name, count: saved.entries.filter((entry) => entry.folder === name).length }))
const scoped = (folder) =>
  folder === undefined ? saved.entries : saved.entries.filter((entry) => entry.folder === folder)
const add = (ids, folder) => {
  for (const id of ids) {
    if (saved.entries.some((entry) => entry.id === id)) continue
    saved.entries.push({ id, name: `Layer ${id}`, folder: folder ?? '' })
  }
  return { added: ids.length, folders: counts(), entries: saved.entries }
}

function answer(command, params) {
  seen.push(command)
  calls.push({ command, params })
  switch (command) {
    case 'get_selection':
      return {
        page: 'Agent page',
        rows: [{ id: '1:2', name: 'CTA', type: 'FRAME', width: 120, height: 40, childCount: 1 }],
      }
    case 'set_node_name':
      return { id: params.nodeId, name: params.name }
    case 'set_fill':
      return { id: params.nodeId, name: 'CTA', fills: 1 }
    case 'set_selection':
      return {
        page: 'Agent page',
        rows: (params.nodeIds ?? [params.nodeId]).map((id) => ({
          id,
          name: `Layer ${id}`,
          type: 'FRAME',
          width: 120,
          height: 40,
          childCount: 0,
        })),
      }
    case 'get_tree':
      return { page: 'Agent page', rows: [{ id: '1:1', name: 'Screen', type: 'FRAME', width: 375, height: 812, childCount: 4 }] }
    case 'list_library':
      return { components: [{ id: '2:1', name: 'Button' }], styles: { paint: [], text: [], effect: [] }, variables: [] }

    case 'extract':
      return extraction(params.nodeId ?? '1:2', params.format)
    case 'extract_selection':
      return batch(['1:2', '1:3'], params.format)
    case 'extract_nodes':
      return batch(params.nodeIds.map(String), params.format)
    case 'extract_urls':
      return batch((Array.isArray(params.urls) ? params.urls : [params.urls]).map(String), params.format)
    case 'extract_saved':
      return batch(scoped(params.folder).map((entry) => entry.id), params.format)

    case 'list_folders':
      return { folders: counts() }
    case 'list_saved':
      return { folders: counts(), entries: scoped(params.folder) }
    case 'save_selection':
      return add(['1:2'], params.folder)
    case 'save_nodes':
      return add(params.nodeIds.map(String), params.folder)
    case 'unsave':
      saved.entries = saved.entries.filter((entry) => !params.nodeIds.includes(entry.id))
      return { folders: counts(), entries: saved.entries }
    case 'clear_saved': {
      const doomed = params.all === true || params.folder === undefined ? saved.entries : scoped(params.folder)
      saved.entries = saved.entries.filter((entry) => !doomed.includes(entry))
      return { removed: doomed.length, folders: counts(), entries: saved.entries }
    }
    case 'move_saved': {
      let moved = 0
      for (const entry of saved.entries) {
        if (!params.nodeIds.includes(entry.id)) continue
        entry.folder = params.folder
        moved++
      }
      return { moved, folders: counts(), entries: saved.entries }
    }
    case 'create_folder':
      if (!saved.folders.includes(params.name)) saved.folders.push(params.name)
      return { name: params.name, folders: counts() }
    case 'rename_folder': {
      saved.folders = saved.folders.map((name) => (name === params.from ? params.to : name))
      for (const entry of saved.entries) if (entry.folder === params.from) entry.folder = params.to
      return { name: params.to, folders: counts(), entries: saved.entries }
    }
    case 'delete_folder': {
      saved.folders = saved.folders.filter((name) => name !== params.name)
      const inside = saved.entries.filter((entry) => entry.folder === params.name)
      if (params.deleteEntries === true) saved.entries = saved.entries.filter((entry) => !inside.includes(entry))
      else for (const entry of inside) entry.folder = ''
      return { affected: inside.length, folders: counts(), entries: saved.entries }
    }

    default:
      throw new Error(`the panel has no ${command}`)
  }
}

function openPanel({ token = TOKEN, origin = 'null' } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/panel?token=${encodeURIComponent(token)}`, { origin })
  const frames = []
  const closed = { code: null }

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    frames.push(message)
    if (message.kind !== 'request') return
    try {
      socket.send(JSON.stringify({ kind: 'response', id: message.id, ok: true, data: answer(message.command, message.params) }))
    } catch (error) {
      socket.send(JSON.stringify({ kind: 'response', id: message.id, ok: false, error: error.message }))
    }
  })
  socket.on('close', (code) => {
    closed.code = code
  })

  const send = (frame) => socket.send(JSON.stringify(frame))
  const find = (predicate) => frames.find(predicate)
  const wait = (predicate, label) => until(() => find(predicate) !== undefined, 20_000, label).then(() => find(predicate))
  const open = () => new Promise((settle, fail) => {
    if (socket.readyState === socket.OPEN) return settle()
    socket.on('open', settle)
    socket.on('error', fail)
  })

  return { socket, frames, closed, send, find, wait, open }
}

// -------------------------------------------------------------------- guards
//
// A local port is reachable by any page the designer happens to visit, so both
// halves of the guard are asserted before anything else runs.

const noToken = openPanel({ token: 'wrong' })
await until(() => noToken.closed.code !== null, 10_000, 'the refusal')
check('a bad token is refused', noToken.closed.code === 4001, `code ${noToken.closed.code}`)

const badOrigin = openPanel({ origin: 'https://evil.example' })
await until(() => badOrigin.closed.code !== null, 10_000, 'the refusal')
check('a socket from another origin is refused', badOrigin.closed.code === 4001, `code ${badOrigin.closed.code}`)

const unauthorised = await fetch(`${BASE}/tools`)
check('HTTP without a token is refused', unauthorised.status === 401)

const openHealth = await fetch(`${BASE}/health`)
check('but /health is open, so a panel can probe before it is paired', openHealth.status === 200)

const editorOrigin = openPanel({ origin: 'https://www.figma.com' })
await editorOrigin.open()
check('the editor origin is allowed', editorOrigin.closed.code === null)
editorOrigin.socket.close()

// --------------------------------------------------------------------- hello

const panel = openPanel()
await panel.open()

panel.send({ kind: 'hello' })
const idle = await panel.wait((frame) => frame.kind === 'state', 'the opening state')
check('a panel that says hello is told where the gate stands', idle.writes === false, JSON.stringify(idle))

const paired = await (await fetch(`${BASE}/health`)).json()
check('and /health agrees that a panel is attached',
  paired.panelConnected === true && paired.editsAllowed === false, JSON.stringify(paired))
check('with nothing in it about accounts or sessions',
  paired.loginRequired === undefined && paired.session === undefined, JSON.stringify(paired))

// ------------------------------------------------------------------- tools

const toolList = await (await fetch(`${BASE}/tools`, { headers: { 'x-figsnap-token': TOKEN } })).json()
check('every tool is described for the agent', toolList.tools.length >= 33, `${toolList.tools.length} tools`)
check('including the ones that make things, not only change them',
  ['figma_create_text', 'figma_create_rectangle', 'figma_create_svg', 'figma_create_instance', 'figma_list_library']
    .every((name) => toolList.tools.some((tool) => tool.name === name)))
check('and the two that fold thirteen plugin commands into one argument each',
  ['figma_saved', 'figma_select'].every((name) => toolList.tools.some((tool) => tool.name === name)),
  toolList.tools.map((tool) => tool.name).join())
check('reading and writing are marked apart',
  toolList.tools.find((tool) => tool.name === 'figma_extract').annotations.readOnlyHint === true &&
  toolList.tools.find((tool) => tool.name === 'figma_set_fill').annotations.readOnlyHint === false)
// The saved set is not the design, so it is not gated — but half of it writes,
// and a client told it was read-only would be told something untrue.
check('and a tool that writes something other than the design is neither',
  toolList.tools.find((tool) => tool.name === 'figma_saved').annotations.readOnlyHint === false &&
  toolList.tools.find((tool) => tool.name === 'figma_saved').annotations.destructiveHint === false)

const gone = await fetch(`${BASE}/fs?path=/`, { headers: { 'x-figsnap-token': TOKEN } })
check('the filesystem route is not here — nothing in this repo needs a working directory',
  gone.status === 404, String(gone.status))

// ------------------------------------------------------------- the MCP server
//
// Anything that speaks MCP can spawn this and reach the same open file. That is
// the difference between the designs being available inside a plugin's own chat
// and being available wherever the designer works.

async function mcpClient(env) {
  const client = new Client({ name: 'suite', version: '1.0.0' }, { capabilities: {} })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'agent/mcp-stdio.mjs')],
      env: { ...process.env, ...env },
    }),
  )
  return client
}

const standalone = await mcpClient({ FIGSNAP_MCP_URL: BASE, FIGSNAP_MCP_TOKEN: TOKEN })
const listed = await standalone.listTools()
check('any MCP client can list the tools', listed.tools.length >= 33, `${listed.tools.length} tools`)

seen.length = 0
const answered = await standalone.callTool({ name: 'figma_get_selection', arguments: {} })
check('and call one, all the way into the plugin',
  answered.isError !== true && seen.includes('get_selection'), JSON.stringify(answered.content?.[0]).slice(0, 80))

/** The text of a tool result, which is where every non-image answer lives. */
const said = (result) =>
  (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')

// ------------------------------------------------------------------- the gate
//
// In Figsnap this switch sat behind an ACP runner and a permission prompt. Here
// it is the whole of the daemon's state, and the panel is the only thing that
// can move it — which is the point: the designer holds it, not the agent.

seen.length = 0
const refused = await standalone.callTool({ name: 'figma_set_node_name', arguments: { nodeId: '1:2', name: 'CTA v2' } })
check('a writing tool is refused while Edits is off',
  refused.isError === true && refused.content[0].text.includes('switched off'), refused.content[0].text.slice(0, 90))
check('so nothing reached the canvas', !seen.includes('set_node_name'))

panel.frames.length = 0
panel.send({ kind: 'writes', on: true })
const opened = await panel.wait((frame) => frame.kind === 'state' && frame.writes === true, 'writes on')
check('the panel switch opens it, and the panel is told it moved', opened.writes === true)
check('and /health says the same, for a client that never sees the socket',
  (await (await fetch(`${BASE}/health`)).json()).editsAllowed === true)

const allowed = await standalone.callTool({ name: 'figma_set_node_name', arguments: { nodeId: '1:2', name: 'CTA v2' } })
check('and the same call now reaches the canvas',
  allowed.isError !== true && seen.includes('set_node_name'), said(allowed).slice(0, 80))

// ------------------------------------------------------ extracting in batches
//
// Four batch extractions are arguments on figma_extract rather than four more
// tools, because thirty-nine tool descriptions already cost real context on
// every request.

seen.length = 0
const many = await standalone.callTool({ name: 'figma_extract', arguments: { selection: true } })
check('a batch is an argument on figma_extract, not a tool of its own',
  many.isError !== true && seen.includes('extract_selection'), seen.join())
const manyBody = JSON.parse(said(many))
check('answering one entry per selected node',
  manyBody.results.length === 2 && manyBody.results.every((entry) => entry.ok === true),
  JSON.stringify(manyBody.results?.map((entry) => entry.nodeId)))
check('with the default formats, which are text',
  manyBody.results[0].extraction.outputs.join() === 'html,figmaCss',
  JSON.stringify(manyBody.results[0].extraction.outputs))

seen.length = 0
const byId = await standalone.callTool({ name: 'figma_extract', arguments: { nodeIds: ['1:2', '1:3', '1:4'] } })
check('ids go through extract_nodes', seen.includes('extract_nodes'), seen.join())
check('and every one comes back', JSON.parse(said(byId)).results.length === 3)

seen.length = 0
await standalone.callTool({
  name: 'figma_extract',
  arguments: { urls: ['https://www.figma.com/design/KEY/N?node-id=1-2'] },
})
check('links go through extract_urls', seen.includes('extract_urls'), seen.join())

// The bug this section exists for: a batch answers an extraction per entry,
// each with its own image, and stringifying twenty base64 PNGs into one tool
// result is not an answer anyone can read.
seen.length = 0
const withImages = await standalone.callTool({
  name: 'figma_extract',
  arguments: { selection: true, formats: ['png', 'html'] },
})
const imagesBody = said(withImages)
check('a batch that asked for images carries no base64',
  !imagesBody.includes(PNG_BASE64), imagesBody.slice(0, 120))
check('and no image blocks either — figma_export_png is the tool for a picture',
  (withImages.content ?? []).every((block) => block.type === 'text'),
  (withImages.content ?? []).map((block) => block.type).join())
check('but `outputs` still records what was asked for',
  JSON.parse(imagesBody).results[0].extraction.outputs.join() === 'png,html')

// A picture is an image block, never base64 in a text field. `pngData` used to
// be on this schema and a screen at scale 3 came back as 141 kB of it, which no
// tool result can carry.
const listedFormats = listed.tools.find((tool) => tool.name === 'figma_extract')
  .inputSchema.properties.formats.items.enum
check('pngData is not something a tool can ask for',
  !listedFormats.includes('pngData') && listedFormats.includes('png'), listedFormats.join())

seen.length = 0
const asPicture = await standalone.callTool({
  name: 'figma_extract',
  arguments: { nodeId: '1:2', formats: ['png'] },
})
check('asking for png gets a real image block, not base64 in the text',
  asPicture.content.some((block) => block.type === 'image' && block.data === PNG_BASE64) &&
  !said(asPicture).includes(PNG_BASE64),
  asPicture.content.map((block) => block.type).join())

// The /tool route takes a body rather than a validated argument list, so a
// hand-written call can still name pngData. It is answered, not refused.
const viaBody = await (await fetch(`${BASE}/tool`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-figsnap-token': TOKEN },
  body: JSON.stringify({ name: 'figma_extract', arguments: { nodeId: '1:2', formats: ['pngData'] } }),
})).json()
check('a hand-written pngData is answered as the picture it was asking for',
  viaBody.content.some((block) => block.type === 'image'),
  JSON.stringify(viaBody.error ?? viaBody.content.map((block) => block.type)))

// And the floor under all of it: 141 kB of base64 in one tool result exceeds
// what any result may carry, so the call is wasted and the caller is handed a
// file to slice.
const capped = await (await fetch(`${BASE}/tool`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-figsnap-token': TOKEN },
  body: JSON.stringify({ name: 'figma_extract', arguments: { nodeId: 'raw:1' } }),
})).json()
const cappedText = capped.content.find((block) => block.type === 'text').text
check('an image too big to inline is not inlined',
  !cappedText.includes(BIG_PNG_BASE64.slice(0, 400)), cappedText.length + ' chars')
check('and the answer says what to ask for instead',
  JSON.parse(cappedText).pngData.note.includes('figma_export_png') &&
  JSON.parse(cappedText).pngData.dataUri === undefined,
  JSON.parse(cappedText).pngData.note)
check('while still saying how big it was',
  JSON.parse(cappedText).pngData.bytes > 25_000, String(JSON.parse(cappedText).pngData.bytes))

// The cap is a cap, not a ban: an icon is a few kB, and a caller that came in
// over the raw route asking for the bytes gets them.
const small = await (await fetch(`${BASE}/tool`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-figsnap-token': TOKEN },
  body: JSON.stringify({ name: 'figma_extract', arguments: { nodeId: 'tiny:1' } }),
})).json()
const tiny = JSON.parse(small.content.find((block) => block.type === 'text').text).pngData
check('one small enough to read is still inlined',
  tiny.dataUri === `data:image/png;base64,${PNG_BASE64}` && tiny.note === undefined,
  JSON.stringify(tiny).slice(0, 90))

// ------------------------------------------------------------- the saved set
//
// Nine commands behind one `action`, mapped through the same functions in
// shared/shape.mjs that decide what a `POST /saved` body means.

const savedCall = (args) => standalone.callTool({ name: 'figma_saved', arguments: args })
const lastCall = () => calls.at(-1)

calls.length = 0
const savedSelection = await savedCall({ action: 'save' })
check('save with no ids means whatever is selected',
  lastCall().command === 'save_selection' && savedSelection.isError !== true, lastCall().command)

await savedCall({ action: 'save', nodeIds: ['21:1', '21:2'] })
check('save with ids is save_nodes',
  lastCall().command === 'save_nodes' && lastCall().params.nodeIds.join() === '21:1,21:2', lastCall().command)

const listed2 = await savedCall({ action: 'list' })
check('list reads the set back', lastCall().command === 'list_saved' &&
  JSON.parse(said(listed2)).entries.length === 3, said(listed2).slice(0, 120))

await savedCall({ action: 'newFolder', name: 'Checkout' })
check('newFolder creates one', lastCall().command === 'create_folder' && lastCall().params.name === 'Checkout',
  JSON.stringify(lastCall()))

await savedCall({ action: 'move', nodeIds: ['21:1'], folder: 'Checkout' })
check('move puts an entry in it', lastCall().command === 'move_saved', lastCall().command)
const inFolder = await savedCall({ action: 'list', folder: 'Checkout' })
check('and the folder now has it',
  JSON.parse(said(inFolder)).entries.map((entry) => entry.id).join() === '21:1', said(inFolder).slice(0, 120))

const folders = await savedCall({ action: 'folders' })
check('folders counts them, root included',
  lastCall().command === 'list_folders' &&
  JSON.parse(said(folders)).folders.find((folder) => folder.name === 'Checkout').count === 1,
  said(folders).slice(0, 140))

await savedCall({ action: 'renameFolder', from: 'Checkout', to: 'Basket' })
check('renameFolder names both ends',
  lastCall().command === 'rename_folder' && lastCall().params.from === 'Checkout' && lastCall().params.to === 'Basket',
  JSON.stringify(lastCall().params))

await savedCall({ action: 'unsave', nodeIds: ['21:2'] })
check('unsave removes one', lastCall().command === 'unsave', lastCall().command)

await savedCall({ action: 'deleteFolder', name: 'Basket' })
const afterDelete = await savedCall({ action: 'list' })
check('deleteFolder keeps what was inside by default',
  lastCall().command === 'list_saved' &&
  JSON.parse(said(afterDelete)).entries.some((entry) => entry.id === '21:1'), said(afterDelete).slice(0, 140))

await savedCall({ action: 'clear', folder: '' })
check('clear scoped to a folder empties that folder',
  lastCall().command === 'clear_saved' && lastCall().params.folder === '', JSON.stringify(lastCall().params))

await savedCall({ action: 'clear' })
check('and clear with nothing named empties the whole set',
  lastCall().command === 'clear_saved' && lastCall().params.all === true, JSON.stringify(lastCall().params))
// Ten rather than nine: `save` is two commands, because saving the selection
// and saving named ids are two things to the plugin and one thing to a caller.
check('nine actions reach ten plugin commands',
  new Set(calls.map((call) => call.command)).size === 10,
  [...new Set(calls.map((call) => call.command))].join())

const badAction = await savedCall({ action: 'burn' })
check('an action that does not exist names the ones that do',
  badAction.isError === true && badAction.content[0].text.includes('deleteFolder'),
  badAction.content[0].text.slice(0, 90))

const shortHanded = await savedCall({ action: 'move', nodeIds: ['21:1'] })
check('and one missing its folder says which argument is missing',
  shortHanded.isError === true && shortHanded.content[0].text.includes('folder'),
  shortHanded.content[0].text.slice(0, 90))

// ------------------------------------------------------------------ selecting

seen.length = 0
const pointed = await standalone.callTool({ name: 'figma_select', arguments: { nodeId: '1:2' } })
check('figma_select drives the canvas from a terminal',
  pointed.isError !== true && seen.includes('set_selection'), seen.join())
check('and is not behind the Edits gate, because it changes no design data',
  !said(pointed).includes('switched off'), said(pointed).slice(0, 80))

// ------------------------------------------------------------------ resources
//
// The same designs, addressable instead of called for, so a client can
// @-mention them rather than spend a tool call.

const resources = await standalone.listResources()
check('the three obvious contexts are resources',
  ['figma://selection', 'figma://page', 'figma://library'].every((uri) =>
    resources.resources.some((resource) => resource.uri === uri)),
  resources.resources.map((resource) => resource.uri).join())

const templates = await standalone.listResourceTemplates()
check('and one node is a template', templates.resourceTemplates[0].uriTemplate === 'figma://node/{nodeId}',
  JSON.stringify(templates.resourceTemplates))

seen.length = 0
const readSelection = await standalone.readResource({ uri: 'figma://selection' })
check('reading the selection extracts it, through the tool that already did that',
  seen.includes('extract_selection') && JSON.parse(readSelection.contents[0].text).results.length === 2,
  readSelection.contents[0].text.slice(0, 90))
check('and says what it is', readSelection.contents[0].mimeType === 'application/json')

seen.length = 0
await standalone.readResource({ uri: 'figma://page' })
check('the page resource is the layer tree', seen.includes('get_tree'), seen.join())
seen.length = 0
await standalone.readResource({ uri: 'figma://library' })
check('and the library resource is the design system', seen.includes('list_library'), seen.join())

seen.length = 0
const readNode = await standalone.readResource({ uri: 'figma://node/1:2' })
check('a node id in the URI extracts that node',
  seen.includes('extract') && JSON.parse(readNode.contents[0].text).id === '1:2',
  readNode.contents[0].text.slice(0, 80))

let noSuchResource = null
await standalone.readResource({ uri: 'figma://nonsense' }).catch((error) => {
  noSuchResource = error
})
check('and a URI that names nothing is an error, not empty context', noSuchResource !== null)

await standalone.close()

// A daemon that is not running is the common first-run mistake, and "fetch
// failed" is not something a user can act on.
const orphan = await mcpClient({ FIGSNAP_MCP_URL: 'http://127.0.0.1:1', FIGSNAP_MCP_TOKEN: 'x' })
const noDaemon = await orphan.callTool({ name: 'figma_get_selection', arguments: {} })
check('with no daemon it says how to start one',
  noDaemon.isError === true && noDaemon.content[0].text.includes('agent/index.mjs'),
  noDaemon.content[0].text.slice(0, 110))
await orphan.close()

const wrongToken = await mcpClient({ FIGSNAP_MCP_URL: BASE, FIGSNAP_MCP_TOKEN: 'not-the-token' })
const rejected = await wrongToken.callTool({ name: 'figma_get_selection', arguments: {} })
check('and a wrong token points at the file the right one is in',
  rejected.isError === true && rejected.content[0].text.includes('.figsnap-mcp/agent-token'),
  rejected.content[0].text.slice(0, 90))
await wrongToken.close()

// ------------------------------------------------------- a daemon of its own
//
// Two things are only true before a panel has ever connected, so they get their
// own daemon: the Edits gate seeded from the command line, and the answer to a
// tool call when there is no plugin to forward it to.

const SOLO_PORT = await freePort()
const SOLO = `http://127.0.0.1:${SOLO_PORT}`
const solo = spawn(process.execPath, [join(root, 'agent/index.mjs'), '--quiet', '--allow-edits'], {
  cwd: root,
  env: { ...process.env, FIGSNAP_MCP_PORT: String(SOLO_PORT), FIGSNAP_MCP_TOKEN: TOKEN, HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
})
solo.stdout.on('data', () => {})
solo.stderr.on('data', (chunk) => daemonErrors.push(chunk.toString()))
await until(async () => (await fetch(`${SOLO}/health`)).ok, 15_000, 'the second daemon')

const soloHealth = await (await fetch(`${SOLO}/health`)).json()
check('--allow-edits opens the gate from the terminal, before any panel connects',
  soloHealth.editsAllowed === true && soloHealth.panelConnected === false,
  JSON.stringify({ edits: soloHealth.editsAllowed, panel: soloHealth.panelConnected }))

// The one limit that is not solvable and should be said rather than engineered
// around: `figma.*` only exists while the plugin is open.
const closedPlugin = await mcpClient({ FIGSNAP_MCP_URL: SOLO, FIGSNAP_MCP_TOKEN: TOKEN })
const noPanel = await closedPlugin.callTool({ name: 'figma_get_selection', arguments: {} })
check('with the daemon up but the plugin closed, the answer says which of the two to fix',
  noPanel.isError === true && noPanel.content[0].text.includes('not open in Figma'),
  noPanel.content[0].text.slice(0, 100))
const noPanelWrite = await closedPlugin.callTool({ name: 'figma_set_fill', arguments: { nodeId: '1:2', color: '#f00' } })
check('and a writing tool gets the same answer rather than the Edits refusal',
  noPanelWrite.isError === true && noPanelWrite.content[0].text.includes('not open in Figma'),
  noPanelWrite.content[0].text.slice(0, 100))
await closedPlugin.close()
solo.kill('SIGTERM')

// ---------------------------------------------------- the port and the token
//
// The whole reason this repo has its own numbers: Figsnap's daemon and this one
// have to be able to run at the same time.

// agent/lib/paths.mjs exists so these can be imported at all: they used to live
// in mcp-stdio.mjs, where importing them connected a second MCP server to this
// process's own stdio — the stdio this suite prints its results on.
const paths = await import('../agent/lib/paths.mjs')
check('the MCP client defaults to 3058, not to Figsnap\u2019s 3056',
  paths.DEFAULT_AGENT_URL === 'http://127.0.0.1:3058', paths.DEFAULT_AGENT_URL)
check('and to a token file of its own',
  paths.TOKEN_FILE.endsWith('/.figsnap-mcp/agent-token'), paths.TOKEN_FILE)
check('and reading them started nothing', typeof paths.DEFAULT_PORT === 'number')

panel.socket.close()
daemon.kill('SIGTERM')
await rm(HOME, { recursive: true, force: true })

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
