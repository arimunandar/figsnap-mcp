// The real plugin, driven by real tool calls.
//
// dist/code.js runs against a fake `figma`, wired to a real daemon on a free
// port, and every assertion below goes in through `POST /tool` — the same route
// the MCP server uses. So what is proved is the whole chain: tool schema,
// argument shaping, the panel socket, the plugin's own 51-command switch, and
// the clientStorage the saved set lives in.

import { startPlugin, makeNode } from './support/plugin.mjs'

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

/** The text half of a tool answer, which is where every non-image result lives. */
const said = (answer) =>
  (answer.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
const parsed = (answer) => JSON.parse(said(answer))

const label = makeNode('1:3', 'Label', 'TEXT', [], { width: '80px', color: '#111111' })
const card = makeNode('1:2', 'Card', 'FRAME', [label], { width: '320px', 'border-radius': '8px' })
const loose = makeNode('1:4', 'Badge', 'RECTANGLE', [], { width: '24px' })

const storage = new Map()
let plugin = await startPlugin({ pageChildren: [card, loose], storage })

// ------------------------------------------------------------------- pairing

const health = await (await fetch(`${plugin.base}/health`)).json()
check('the daemon sees the panel', health.panelConnected === true, JSON.stringify(health))
check('and the Edits gate starts shut', health.editsAllowed === false)
check('the panel was told so', plugin.daemonFrames.some((frame) => frame.kind === 'state' && frame.writes === false),
  JSON.stringify(plugin.daemonFrames))

// ------------------------------------------------------------------ reading

const tree = await plugin.tool('figma_get_tree')
check('the layer tree comes back from the real main thread',
  parsed(tree).rows.some((row) => row.id === '1:2' && row.name === 'Card'), said(tree).slice(0, 120))

const extracted = await plugin.tool('figma_extract', { nodeId: '1:2' })
const extraction = parsed(extracted)
check('extraction answers about the node that was asked for',
  extraction.id === '1:2' && extraction.name === 'Card' && extraction.nodeType === 'FRAME',
  said(extracted).slice(0, 120))
check('with the default formats, which are text',
  extraction.outputs.join() === 'html,figmaCss', JSON.stringify(extraction.outputs))
check('the HTML holds the layer it was made from',
  typeof extraction.html === 'string' && extraction.html.includes('Label'), String(extraction.html).slice(0, 120))
check('and figmaCss carries the geometry Figma reported, layer by layer',
  typeof extraction.figmaCss === 'string' &&
  extraction.figmaCss.includes('/* Card */') && extraction.figmaCss.includes('width: 100px'),
  String(extraction.figmaCss).slice(0, 120))
check('the child was counted', extraction.layerCount >= 2, String(extraction.layerCount))

const picture = await plugin.tool('figma_export_png', { nodeId: '1:2' })
check('a picture is an image block, not base64 in the text',
  (picture.content ?? []).some((block) => block.type === 'image' && block.mimeType === 'image/png'),
  JSON.stringify(picture).slice(0, 120))

const found = await plugin.tool('figma_find_nodes', { types: ['TEXT'] })
check('find_nodes searches the real page',
  parsed(found).rows.some((row) => row.id === '1:3'), said(found).slice(0, 140))

const nonsense = await plugin.tool('figma_find_nodes', { types: ['STICKY'] })
check('and a type it cannot search for is refused by name',
  typeof nonsense.error === 'string' && nonsense.error.includes('STICKY'), String(nonsense.error).slice(0, 120))

// --------------------------------------------------------------- the gate

const refused = await plugin.tool('figma_set_node_name', { nodeId: '1:2', name: 'Renamed' })
check('a writing tool is refused while Edits is off',
  typeof refused.error === 'string' && refused.error.includes('switched off'), String(refused.error).slice(0, 120))
check('so nothing reached the canvas', card.name === 'Card', card.name)

await plugin.setWrites(true)
check('the panel switch opens the gate',
  (await (await fetch(`${plugin.base}/health`)).json()).editsAllowed === true)

const renamed = await plugin.tool('figma_set_node_name', { nodeId: '1:2', name: 'Renamed' })
check('and the same call now reaches the canvas',
  renamed.error === undefined && card.name === 'Renamed', String(renamed.error ?? card.name))
check('the edit is in undo history, so the designer can take it back', plugin.figma.undos.length > 0)

await plugin.setWrites(false)
const refusedAgain = await plugin.tool('figma_set_node_name', { nodeId: '1:2', name: 'Nope' })
check('turning it off again shuts the gate',
  typeof refusedAgain.error === 'string' && refusedAgain.error.includes('switched off'), card.name)
await plugin.setWrites(true)

// ------------------------------------------------------------- the saved set

await plugin.tool('figma_saved', { action: 'save', nodeIds: ['1:2', '1:3'] })
const listed = await plugin.tool('figma_list_saved')
check('saving named ids puts them in the set',
  parsed(listed).entries.map((entry) => entry.id).sort().join() === '1:2,1:3', said(listed).slice(0, 160))
check('and the set is in clientStorage, keyed by document',
  plugin.storage.get('saved:doc-1')?.entries?.length === 2,
  JSON.stringify(plugin.storage.get('saved:doc-1')).slice(0, 120))
check('the panel is told too, so its list and the tool cannot disagree',
  plugin.lastPanel('saved')?.entries.length === 2, JSON.stringify(plugin.lastPanel('saved')).slice(0, 120))

await plugin.tool('figma_saved', { action: 'newFolder', name: 'Checkout' })
await plugin.tool('figma_saved', { action: 'move', nodeIds: ['1:2'], folder: 'Checkout' })
const inFolder = await plugin.tool('figma_saved', { action: 'list', folder: 'Checkout' })
check('a folder holds what was moved into it',
  parsed(inFolder).entries.map((entry) => entry.id).join() === '1:2', said(inFolder).slice(0, 160))

const folders = await plugin.tool('figma_saved', { action: 'folders' })
check('and folders counts them, root included',
  parsed(folders).folders.find((folder) => folder.name === 'Checkout')?.count === 1 &&
  parsed(folders).folders.some((folder) => folder.name === ''),
  said(folders).slice(0, 160))

const nested = await plugin.tool('figma_saved', { action: 'newFolder', name: 'a/b' })
check('folders do not nest, and the refusal says so',
  typeof nested.error === 'string' && nested.error.includes('nest'), String(nested.error).slice(0, 100))

await plugin.tool('figma_saved', { action: 'renameFolder', from: 'Checkout', to: 'Basket' })
const renamedFolder = await plugin.tool('figma_saved', { action: 'list', folder: 'Basket' })
check('renaming a folder carries its entries with it',
  parsed(renamedFolder).entries.map((entry) => entry.id).join() === '1:2', said(renamedFolder).slice(0, 140))

// A saved entry is a node id, so a node that goes away has to be reported
// rather than silently dropped: the designer is the only one who can fix it.
await plugin.tool('figma_saved', { action: 'save', nodeIds: ['1:4'] })
loose.remove()
loose.removed = true
const afterDelete = await plugin.tool('figma_list_saved')
check('an entry whose layer is gone is marked missing, not dropped',
  parsed(afterDelete).entries.find((entry) => entry.id === '1:4')?.missing === true,
  said(afterDelete).slice(0, 200))

await plugin.tool('figma_saved', { action: 'unsave', nodeIds: ['1:4'] })
check('unsave removes exactly one',
  parsed(await plugin.tool('figma_list_saved')).entries.length === 2)

// --------------------------------------------------- a saved set that survives
//
// The one thing the relay used to be for. It is clientStorage now, so the test
// is a reload rather than a round trip: a second plugin, a second daemon, the
// same storage.

await plugin.stop()
plugin = await startPlugin({ pageChildren: [card, label], storage })
const reopened = await plugin.tool('figma_list_saved')
check('the saved set survives closing and reopening the plugin',
  parsed(reopened).entries.map((entry) => entry.id).sort().join() === '1:2,1:3', said(reopened).slice(0, 160))
check('and so do its folders',
  parsed(await plugin.tool('figma_saved', { action: 'folders' })).folders.some((folder) => folder.name === 'Basket'))

await plugin.tool('figma_saved', { action: 'clear' })
check('clear empties the whole set',
  parsed(await plugin.tool('figma_list_saved')).entries.length === 0)

// ------------------------------------------------------------------ selecting

const pointed = await plugin.tool('figma_select', { nodeId: '1:2' })
check('figma_select drives the canvas from a terminal',
  pointed.error === undefined && plugin.figma.currentPage.selection[0]?.id === '1:2', String(pointed.error))
check('and frames it, so the designer can see what was meant',
  plugin.figma.viewport.framed.some((ids) => ids.includes('1:2')),
  JSON.stringify(plugin.figma.viewport.framed))

await plugin.stop()

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
