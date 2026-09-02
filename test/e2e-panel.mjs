// The panel, in a real DOM.
//
// dist/ui.html is the shipped panel: one document, styles and script inlined.
// Here it is loaded into jsdom with the two things it talks to replaced — the
// main thread, which is `parent.postMessage`, and the daemon, which is `fetch`
// and a WebSocket. So what is proved is the part no other suite covers: that
// the panel renders what the main thread sends it and sends back what the
// designer's clicks mean.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const html = await readFile(join(root, 'dist/ui.html'), 'utf8')

/** Everything the panel sent the main thread, in order. */
const sent = []
/** Every WebSocket the bridge tried to open. */
const dialled = []

const TOOLS = {
  tools: [
    { name: 'figma_get_selection', title: 'What is selected', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'figma_set_fill', title: 'Set a fill', annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'figma_saved', title: 'The saved set', annotations: { readOnlyHint: false, destructiveHint: false } },
  ],
}

let health = { ok: true, version: '0.1.0', panelConnected: false, pendingRequests: 0, tokenRequired: true, editsAllowed: false }

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://www.figma.com/',
  pretendToBeVisual: true,
  beforeParse(window) {
    // A plugin iframe's parent is the editor. In jsdom `parent` is the window
    // itself, which would post the panel's own messages back at it.
    Object.defineProperty(window, 'parent', {
      value: { postMessage: (message) => sent.push(message.pluginMessage) },
      configurable: true,
    })
    window.fetch = async (url) => {
      const path = String(url)
      if (path.endsWith('/health')) return { ok: true, status: 200, json: async () => health }
      if (path.endsWith('/tools')) return { ok: true, status: 200, json: async () => TOOLS }
      throw new Error(`no stub for ${path}`)
    }
    window.WebSocket = class {
      constructor(address) {
        dialled.push(address)
        this.readyState = 0
      }
      addEventListener() {}
      close() {}
      send() {}
      static OPEN = 1
    }
  },
})

const { window } = dom
const $ = (id) => window.document.getElementById(id)
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

/** A message from the main thread, arriving the way Figma delivers one. */
const fromMain = (message) => {
  window.dispatchEvent(new window.MessageEvent('message', { data: { pluginMessage: message } }))
}

await tick(60)

// ------------------------------------------------------------------- opening

check('the panel announces itself to the main thread',
  sent.some((message) => message.type === 'ready'), JSON.stringify(sent))
check('and dials nothing until it has been paired', dialled.length === 0, dialled.join())
check('the address it will dial is on screen', $('url').value === 'ws://localhost:3058/panel', $('url').value)
check('four panes and no more', window.document.querySelectorAll('.pane').length === 4)
check('and Selection is the one it opens on',
  window.document.querySelector('.pane.is-active').id === 'pane-selection',
  window.document.querySelector('.pane.is-active').id)

// ------------------------------------------------------- selection preview

check('with nothing selected the stage says so',
  $('preview').hidden && !$('preview-empty').hidden && $('save-current').disabled)

fromMain({
  type: 'selected',
  id: '1:2',
  ids: ['1:2'],
  rows: [{ id: '1:2', name: 'Card', type: 'FRAME', width: 320.4, height: 180, childCount: 3 }],
})
await tick(20)
check('a selected layer fills in its facts',
  $('sel-name').textContent === 'Card' && $('sel-type').textContent === 'FRAME' &&
  $('sel-size').textContent === '320 × 180' && $('sel-children').textContent === '3' &&
  $('sel-id').textContent === '1:2',
  [$('sel-name').textContent, $('sel-size').textContent].join(' '))
check('and Save becomes available', $('save-current').disabled === false)

// The main thread sends bytes; an <img> needs a URL, and the panel is the only
// side that can do the conversion.
const PNG = new window.Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
fromMain({ type: 'thumb', id: '1:2', png: PNG })
await tick(20)
check('the thumbnail is drawn as a data URI',
  $('preview').hidden === false && $('preview').src === 'data:image/png;base64,iVBORw0KGgo=',
  $('preview').src.slice(0, 60))
check('and the minimised stage shows the same picture',
  $('mini-preview').src === $('preview').src)

sent.length = 0
$('save-current').click()
check('Save saves what is selected, into the folder in the picker',
  sent.at(-1)?.type === 'save-selection' && sent.at(-1).folder === '', JSON.stringify(sent.at(-1)))

fromMain({
  type: 'selected',
  id: '1:2',
  ids: ['1:2', '1:3'],
  rows: [
    { id: '1:2', name: 'Card', type: 'FRAME', width: 320, height: 180, childCount: 3 },
    { id: '1:3', name: 'Label', type: 'TEXT', width: 80, height: 20, childCount: 0 },
  ],
})
fromMain({ type: 'thumb', id: null, png: null })
await tick(20)
check('several layers are a count, not a picture',
  $('sel-name').textContent === '2 layers' && $('save-current').textContent === 'Save 2' &&
  $('preview').hidden === true,
  `${$('sel-name').textContent} / ${$('save-current').textContent}`)
check('and the type column says which kinds they are',
  $('sel-type').textContent === 'FRAME, TEXT', $('sel-type').textContent)

// ------------------------------------------------------------- minimising

sent.length = 0
$('minimise').click()
await tick(20)
check('minimising tells the main thread, which is what resizes the window',
  sent.at(-1)?.type === 'minimise' && sent.at(-1).on === true, JSON.stringify(sent.at(-1)))
check('the tabs and the panes go, the strip stays',
  window.document.body.className.includes('is-mini') &&
  $('mini-stage').hidden === false && $('mini-title').hidden === false &&
  $('mini-save').hidden === false,
  window.document.body.className)
check('and the strip names what is selected', $('mini-title').textContent === '2 layers selected',
  $('mini-title').textContent)

sent.length = 0
$('mini-save').click()
check('the strip can save without being restored first',
  sent.at(-1)?.type === 'save-selection', JSON.stringify(sent.at(-1)))

sent.length = 0
$('minimise').click()
await tick(20)
check('restoring says so too',
  sent.at(-1)?.on === false && !window.document.body.className.includes('is-mini') &&
  $('mini-stage').hidden === true,
  JSON.stringify(sent.at(-1)))

// Settings arrive from clientStorage a moment later; an unpaired panel stays put.
fromMain({ type: 'agent-settings', url: 'ws://localhost:3058/panel', token: '', cwd: '', harness: '', sessionId: '', writes: false, auto: true })
await tick(60)
check('an empty token does not start a connection', dialled.length === 0, dialled.join())
check('but the daemon is probed anyway, so its state is on screen',
  $('fact-daemon').textContent.includes('running'), $('fact-daemon').textContent)

// -------------------------------------------------------------------- tools

$('tabs').querySelector('[data-pane="tools"]').click()
await tick(60)
check('the Tools pane shows what the daemon offers',
  $('tool-list').children.length === 3, String($('tool-list').children.length))
check('with the writing ones marked apart',
  $('tool-list').textContent.includes('edits') && $('tool-list').textContent.includes('reads'),
  $('tool-list').textContent.slice(0, 80))
check('and the saved set marked as reading, because it is not the design',
  Array.from($('tool-list').children)[2].textContent.includes('reads'),
  Array.from($('tool-list').children)[2].textContent)

$('tool-filter').value = 'fill'
$('tool-filter').dispatchEvent(new window.Event('input'))
check('the filter narrows the list', $('tool-list').children.length === 1, $('tool-list').textContent)
$('tool-filter').value = ''
$('tool-filter').dispatchEvent(new window.Event('input'))

// The switch is the daemon's to move, so an unconnected panel must not pretend.
$('allow-edits').click()
await tick(20)
check('Allow edits with no daemon is refused rather than faked',
  $('allow-edits').checked === false && $('status').textContent.includes('no gate'),
  $('status').textContent)

// -------------------------------------------------------------------- saved

$('tabs').querySelector('[data-pane="saved"]').click()
fromMain({
  type: 'saved',
  folders: [{ name: '', count: 1 }, { name: 'Checkout', count: 2 }],
  entries: [
    { id: '1:2', name: 'Card', type: 'FRAME', addedAt: 1, folder: '' },
    { id: '1:3', name: 'Button', type: 'COMPONENT', addedAt: 2, folder: 'Checkout' },
    { id: '1:4', name: 'Gone', type: 'FRAME', addedAt: 3, folder: 'Checkout', missing: true },
  ],
})
await tick(30)

check('every entry is listed under All', $('saved-list').children.length === 3,
  String($('saved-list').children.length))
check('the folder rail lists All, the root and each folder',
  $('folder-list').children.length === 3 && $('folder-list').textContent.includes('Checkout'),
  $('folder-list').textContent)
check('and the caps the plugin enforces are the caps on screen',
  $('saved-count').textContent === '3/100 saved · 1/30 folders', $('saved-count').textContent)
check('a layer that is gone is marked, not dropped',
  $('saved-list').children[2].className.includes('is-missing') &&
  $('saved-list').children[2].querySelector('.entry-jump').disabled,
  $('saved-list').children[2].className)

sent.length = 0
$('save-selection').click()
check('Save selection saves into the folder in view — the root, so far',
  sent.at(-1)?.type === 'save-selection' && sent.at(-1).folder === '', JSON.stringify(sent.at(-1)))

Array.from($('folder-list').children)[2].click()
await tick(20)
check('picking a folder filters the list to it', $('saved-list').children.length === 2,
  String($('saved-list').children.length))
check('and offers the things only a folder can do', $('folder-actions').hidden === false)

sent.length = 0
$('save-selection').click()
check('Save selection now saves into that folder',
  sent.at(-1)?.folder === 'Checkout', JSON.stringify(sent.at(-1)))

sent.length = 0
$('saved-list').querySelector('.entry-jump').click()
check('clicking an entry points the canvas at it',
  sent.at(-1)?.type === 'pick' && sent.at(-1).id === '1:3', JSON.stringify(sent.at(-1)))

sent.length = 0
const move = $('saved-list').querySelector('.entry-move')
move.value = ''
move.dispatchEvent(new window.Event('change'))
check('the folder picker on a row moves it',
  sent.at(-1)?.type === 'move-saved' && sent.at(-1).folder === '' && sent.at(-1).ids.join() === '1:3',
  JSON.stringify(sent.at(-1)))

sent.length = 0
Array.from($('saved-list').querySelectorAll('button')).find((button) => button.textContent === 'Remove').click()
check('Remove takes one entry out', sent.at(-1)?.type === 'unsave' && sent.at(-1).ids.join() === '1:3',
  JSON.stringify(sent.at(-1)))

// Deleting a folder is two clicks rather than a confirm(), which a sandboxed
// iframe cannot be relied on to show.
sent.length = 0
$('delete-folder').click()
check('a destructive folder action arms before it fires',
  sent.length === 0 && $('delete-folder').textContent === 'Sure?', $('delete-folder').textContent)
$('delete-folder').click()
check('and the second click is the answer',
  sent.at(-1)?.type === 'delete-folder' && sent.at(-1).name === 'Checkout' && sent.at(-1).deleteEntries === false,
  JSON.stringify(sent.at(-1)))

sent.length = 0
$('new-folder').click()
const naming = $('folder-list').querySelector('input')
naming.value = 'Basket'
naming.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }))
check('naming a folder happens in the list, not in a dialog',
  sent.at(-1)?.type === 'create-folder' && sent.at(-1).name === 'Basket', JSON.stringify(sent.at(-1)))

// --------------------------------------------------------------- the daemon

fromMain({ type: 'save-result', added: 2, already: 1, moved: 0, full: 0, folder: '' })
check('a save says what happened to each node',
  $('status').textContent.includes('saved 2') && $('status').textContent.includes('1 already there'),
  $('status').textContent)

fromMain({ type: 'error', message: 'That layer is gone. Refresh the tree.' })
check('and a refusal from the main thread is shown as one',
  $('status').textContent.includes('That layer is gone') && $('status').className.includes('bad'),
  $('status').textContent)

// Figma keys clientStorage by plugin id, so a Figsnap install sharing this
// plugin's id hands over its own address and token. Dialling it is blocked by
// the manifest's CSP, with a console error the designer never sees — so the
// panel refuses it here instead, and says why.
fromMain({ type: 'agent-settings', url: 'ws://localhost:3056/panel', token: 'someone-elses', cwd: '', harness: '', sessionId: '', writes: false, auto: true })
await tick(60)
check('an address this build cannot reach is not dialled', dialled.length === 0, dialled.join())
check('its token is dropped with it, rather than tried against another daemon',
  $('token').value === '' && $('url').value === 'ws://localhost:3058/panel',
  `${$('url').value} ${$('token').value}`)
check('and the panel says what it ignored and why',
  $('connect-note').hidden === false && $('connect-note').textContent.includes('3056') &&
  $('connect-note').textContent.includes('3058'),
  $('connect-note').textContent)

$('url').value = 'ws://localhost:9999/panel'
$('connect').click()
check('typing one by hand is refused before anything is dialled',
  dialled.length === 0 && $('connect-note').textContent.includes('9999'),
  $('connect-note').textContent)
$('url').value = 'ws://localhost:3058/panel'

// A paired panel reconnects itself, which is what makes pairing a one-time job.
fromMain({ type: 'agent-settings', url: 'ws://localhost:3058/panel', token: 'a-token', cwd: '', harness: '', sessionId: '', writes: false, auto: true })
await tick(60)
check('a stored token connects without being asked',
  dialled.length === 1 && dialled[0] === 'ws://localhost:3058/panel?token=a-token', dialled.join())

// Everything else the main thread sends is Figsnap's, and is ignored rather
// than crashed on.
for (const message of [
  { type: 'extract', id: '1:2', outputs: [] },
  { type: 'tree', page: 'p', rows: [] },
  { type: 'thumb', id: null, png: null },
  { type: 'sync', fileId: 'doc-1', folders: [], entries: [], updatedAt: 0 },
  { type: 'settings', url: '', token: '', email: '', profiles: [] },
]) {
  fromMain(message)
}
check('the frames this panel never asked for are ignored, not fatal',
  $('saved-list').children.length > 0, String($('saved-list').children.length))

dom.window.close()

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
