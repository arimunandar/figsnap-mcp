// UI thread: DOM and network available, no figma API.
//
// The whole panel. Three panes and nothing else: pair with the daemon, hold the
// edits switch, and manage the saved set. Everything an agent does happens
// somewhere else — in a terminal, in an editor — which is why there is no chat
// here, no code viewer and no API browser.
//
// Two conversations run through this file. Downwards, `postMessage` to the main
// thread, which is the only side that can touch `figma.*`. Outwards, a WebSocket
// to the daemon, opened by src/ui/bridge.ts. The panel is the proxy between
// them: the daemon asks for a command, the main thread answers, and the answer
// goes back out the same socket.
import './style.css'
import { createBridge, type BridgeStatus } from './bridge'
import { AGENT_URL } from '../daemon'

// ------------------------------------------------------------------- shapes

type FolderCount = { name: string; count: number }

type SavedEntry = {
  id: string
  name: string
  type: string
  addedAt: number
  folder: string
  missing?: boolean
}

type ToolDescription = {
  name: string
  title?: string
  description?: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

type PluginResponse = { type: 'res'; id: string; ok: boolean; data?: unknown; error?: string }

type Incoming =
  | PluginResponse
  | { type: 'agent-settings'; url: string; token: string; cwd: string; harness: string; sessionId: string; writes: boolean; auto: boolean }
  | { type: 'saved'; folders: FolderCount[]; entries: SavedEntry[] }
  | { type: 'save-result'; added: number; already: number; moved: number; full: number; folder: string }
  | { type: 'error'; message: string }
  | { type: string; [key: string]: unknown }

/** Everything the main thread will accept. The rest of its cases are Figsnap's. */
type Outgoing =
  | { type: 'ready' }
  | { type: 'req'; id: string; command: string; params: Record<string, unknown> }
  | { type: 'resize'; width: number; height: number }
  | { type: 'save-agent-settings'; url: string; token: string; cwd: string; harness: string; sessionId: string; writes: boolean; auto: boolean }
  | { type: 'save-selection'; folder?: string }
  | { type: 'unsave'; ids: string[] }
  | { type: 'clear-saved'; folder?: string }
  | { type: 'create-folder'; name: string }
  | { type: 'rename-folder'; from: string; to: string }
  | { type: 'delete-folder'; name: string; deleteEntries?: boolean }
  | { type: 'move-saved'; ids: string[]; folder: string }
  | { type: 'refresh-saved' }
  | { type: 'pick'; id: string }

function post(message: Outgoing): void {
  parent.postMessage({ pluginMessage: message }, '*')
}

// --------------------------------------------------------------------- dom

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const tabs = $<HTMLElement>('tabs')
const linkDot = $<HTMLElement>('link-dot')
const linkLabel = $<HTMLElement>('link-label')
const statusLine = $<HTMLParagraphElement>('status')

const urlInput = $<HTMLInputElement>('url')
const tokenInput = $<HTMLInputElement>('token')
const showToken = $<HTMLInputElement>('show-token')
const connectButton = $<HTMLButtonElement>('connect')
const disconnectButton = $<HTMLButtonElement>('disconnect')
const connectNote = $<HTMLParagraphElement>('connect-note')
const probeButton = $<HTMLButtonElement>('probe')
const factUrl = $<HTMLElement>('fact-url')
const factDaemon = $<HTMLElement>('fact-daemon')
const factPanel = $<HTMLElement>('fact-panel')
const factEdits = $<HTMLElement>('fact-edits')

const allowEdits = $<HTMLInputElement>('allow-edits')
const editsNote = $<HTMLElement>('edits-note')
const toolFilter = $<HTMLInputElement>('tool-filter')
const toolCount = $<HTMLElement>('tool-count')
const toolList = $<HTMLUListElement>('tool-list')
const toolsEmpty = $<HTMLParagraphElement>('tools-empty')

const savedList = $<HTMLUListElement>('saved-list')
const savedEmpty = $<HTMLParagraphElement>('saved-empty')
const savedCount = $<HTMLElement>('saved-count')
const folderList = $<HTMLUListElement>('folder-list')
const folderActions = $<HTMLElement>('folder-actions')
const saveSelection = $<HTMLButtonElement>('save-selection')
const newFolderButton = $<HTMLButtonElement>('new-folder')
const refreshSaved = $<HTMLButtonElement>('refresh-saved')
const renameFolderButton = $<HTMLButtonElement>('rename-folder')
const emptyFolderButton = $<HTMLButtonElement>('empty-folder')
const deleteFolderButton = $<HTMLButtonElement>('delete-folder')

// ------------------------------------------------------------------- state

let daemonUrl = AGENT_URL
let daemonToken = ''
let writesOn = false
let settingsLoaded = false
let tools: ToolDescription[] = []
let folders: FolderCount[] = []
let entries: SavedEntry[] = []
/** null is "everything"; '' is the root; anything else is a folder by name. */
let activeFolder: string | null = null

let statusTimer: number | undefined

function say(text: string, bad = false): void {
  statusLine.textContent = text
  statusLine.classList.toggle('bad', bad)
  if (statusTimer !== undefined) clearTimeout(statusTimer)
  if (text !== '') {
    statusTimer = setTimeout(() => {
      statusLine.textContent = ''
      statusLine.classList.remove('bad')
    }, 6_000) as unknown as number
  }
}

/** The HTTP face of the daemon, given the socket address the panel dials. */
function httpBase(): string {
  return daemonUrl.replace(/^ws/, 'http').replace(/\/panel\/?$/, '')
}

function authHeaders(): Record<string, string> {
  return daemonToken === '' ? {} : { 'x-figsnap-token': daemonToken }
}

/** Persisted by the main thread, in this Figma account's own storage. */
function rememberSettings(): void {
  post({
    type: 'save-agent-settings',
    url: daemonUrl,
    token: daemonToken,
    cwd: '',
    harness: '',
    sessionId: '',
    writes: writesOn,
    auto: true,
  })
}

// -------------------------------------------------------------------- tabs

tabs.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.tab')
  if (button === null) return
  for (const tab of Array.from(tabs.querySelectorAll('.tab'))) tab.classList.remove('is-active')
  button.classList.add('is-active')
  for (const pane of Array.from(document.querySelectorAll('.pane'))) pane.classList.remove('is-active')
  document.getElementById(`pane-${button.dataset.pane}`)?.classList.add('is-active')
  if (button.dataset.pane === 'tools' && tools.length === 0) void loadTools()
})

// ------------------------------------------------- the main thread, by request
//
// The daemon asks for a command; only the main thread can answer it. Every ask
// is numbered so several can be in flight, which they are whenever an agent
// runs two tools at once.

const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>()
let requestCounter = 0

function requestMain(command: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `p${++requestCounter}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    post({ type: 'req', id, command, params })
  })
}

// ------------------------------------------------------------------- bridge

const bridge = createBridge({
  url: () => `${daemonUrl}?token=${encodeURIComponent(daemonToken)}`,
  label: 'daemon',
  request: requestMain,
  onStatus: (status, detail) => showLink(status, detail),
  onRejected: () => {
    connectNote.hidden = false
    connectNote.textContent =
      'The daemon refused that token. Copy the one it printed on the line marked `token`, or restart it with --new-token.'
  },
  onFrame: (frame) => {
    if (frame.kind === 'state') {
      writesOn = frame.writes === true
      allowEdits.checked = writesOn
      paintEdits()
      rememberSettings()
      return
    }
    if (frame.kind === 'notice') {
      say(String(frame.text ?? ''), frame.level === 'error')
    }
  },
})

const LINK_WORDS: Record<BridgeStatus, string> = {
  off: 'not connected',
  connecting: 'connecting…',
  open: 'connected',
  retrying: 'retrying',
}

function showLink(status: BridgeStatus, detail?: string): void {
  linkDot.className = `dot ${status === 'open' ? 'on' : status === 'off' ? 'off' : status === 'retrying' ? 'bad' : 'busy'}`
  linkLabel.textContent = detail ?? LINK_WORDS[status]
  factPanel.textContent = detail ?? LINK_WORDS[status]
  connectButton.disabled = status === 'connecting' || status === 'open'
  disconnectButton.disabled = status === 'off'
  if (status === 'open') {
    connectNote.hidden = true
    bridge.send({ kind: 'hello' })
    void loadTools()
    void probe()
  }
}

// ------------------------------------------------------------------ connect

async function probe(): Promise<void> {
  factUrl.textContent = daemonUrl
  try {
    const response = await fetch(`${httpBase()}/health`)
    const health = await response.json()
    factDaemon.textContent = `running, version ${health.version}${health.tokenRequired ? '' : ' (no token needed)'}`
    factEdits.textContent = health.editsAllowed === true ? 'allowed' : 'off'
    // The daemon is the authority on the gate, so a panel that reconnected to a
    // daemon started with --allow-edits agrees with it rather than overwriting it.
    writesOn = health.editsAllowed === true
    allowEdits.checked = writesOn
    paintEdits()
    if (!bridge.isOpen()) {
      factPanel.textContent = health.panelConnected === true ? 'another window has it' : 'not connected'
    }
  } catch {
    factDaemon.textContent = 'not answering — start it with `npm run daemon`'
    factEdits.textContent = 'unknown'
  }
}

probeButton.addEventListener('click', () => void probe())

showToken.addEventListener('change', () => {
  tokenInput.type = showToken.checked ? 'text' : 'password'
})

connectButton.addEventListener('click', () => {
  daemonUrl = urlInput.value.trim() === '' ? AGENT_URL : urlInput.value.trim()
  daemonToken = tokenInput.value.trim()
  urlInput.value = daemonUrl
  connectNote.hidden = true
  rememberSettings()
  bridge.connect()
})

disconnectButton.addEventListener('click', () => {
  bridge.disconnect()
  tools = []
  paintTools()
})

// -------------------------------------------------------------------- tools

function paintEdits(): void {
  editsNote.textContent = writesOn
    ? 'On. Every tool marked EDITS will now reach the canvas.'
    : 'Reading is always allowed. Writing is not, until you say so.'
  factEdits.textContent = writesOn ? 'allowed' : 'off'
}

allowEdits.addEventListener('change', () => {
  const on = allowEdits.checked
  if (!bridge.send({ kind: 'writes', on })) {
    allowEdits.checked = writesOn
    say('Not connected to the daemon, so there is no gate to open.', true)
    return
  }
  // The daemon answers with a `state` frame, which is what actually settles it.
  say(on ? 'Asking the daemon to allow edits…' : 'Asking the daemon to refuse edits…')
})

async function loadTools(): Promise<void> {
  try {
    const response = await fetch(`${httpBase()}/tools`, { headers: authHeaders() })
    if (!response.ok) throw new Error(`the daemon answered ${response.status}`)
    const body = await response.json()
    tools = Array.isArray(body.tools) ? body.tools : []
  } catch (error) {
    tools = []
    say(`Could not read the tool list: ${error instanceof Error ? error.message : String(error)}`, true)
  }
  paintTools()
}

function paintTools(): void {
  const needle = toolFilter.value.trim().toLowerCase()
  const shown = tools.filter(
    (tool) =>
      needle === '' ||
      tool.name.toLowerCase().indexOf(needle) !== -1 ||
      String(tool.title ?? '').toLowerCase().indexOf(needle) !== -1,
  )
  const writing = tools.filter((tool) => tool.annotations?.destructiveHint === true).length
  toolCount.textContent =
    tools.length === 0 ? '' : `${shown.length} of ${tools.length} · ${writing} of them write`
  toolsEmpty.hidden = tools.length !== 0
  toolList.textContent = ''
  for (const tool of shown) {
    const row = document.createElement('li')
    row.className = 'tool'

    const name = document.createElement('span')
    name.className = 'tool-name'
    name.textContent = tool.name
    row.appendChild(name)

    const badge = document.createElement('span')
    const writes = tool.annotations?.destructiveHint === true
    badge.className = `badge${writes ? ' writes' : ''}`
    badge.textContent = writes ? 'edits' : 'reads'
    row.appendChild(badge)

    const title = document.createElement('span')
    title.className = 'tool-title'
    title.textContent = tool.title ?? String(tool.description ?? '').split('\n')[0]
    row.appendChild(title)

    toolList.appendChild(row)
  }
}

toolFilter.addEventListener('input', paintTools)

// -------------------------------------------------------------------- saved

/** Every folder name a caller may move an entry into, root first. */
function folderNames(): string[] {
  return folders.map((folder) => folder.name)
}

function inScope(entry: SavedEntry): boolean {
  return activeFolder === null || entry.folder === activeFolder
}

function paintFolders(): void {
  folderList.textContent = ''
  const total = entries.filter((entry) => entry.missing !== true).length
  const rows: { key: string | null; label: string; count: number }[] = [
    { key: null, label: 'All', count: total },
    ...folders.map((folder) => ({
      key: folder.name,
      label: folder.name === '' ? 'Root' : folder.name,
      count: folder.count,
    })),
  ]
  for (const row of rows) {
    const item = document.createElement('li')
    item.className = `folder${row.key === activeFolder ? ' is-active' : ''}`
    item.tabIndex = 0

    const name = document.createElement('span')
    name.className = 'folder-name'
    name.textContent = row.label
    item.appendChild(name)

    const count = document.createElement('span')
    count.className = 'folder-count'
    count.textContent = String(row.count)
    item.appendChild(count)

    const choose = () => {
      activeFolder = row.key
      resetFolderActions()
      paintFolders()
      paintSaved()
    }
    item.addEventListener('click', choose)
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') choose()
    })
    folderList.appendChild(item)
  }
  // The root is not a folder, so it cannot be renamed, emptied as a unit or
  // deleted; neither can "All", which is a view rather than a thing.
  folderActions.hidden = activeFolder === null || activeFolder === ''
}

function paintSaved(): void {
  const shown = entries.filter(inScope)
  savedCount.textContent = `${entries.length}/100 saved · ${folders.length - 1}/30 folders`
  savedEmpty.hidden = shown.length !== 0
  savedEmpty.textContent =
    entries.length === 0
      ? 'Nothing saved in this file yet. Select a layer and press Save selection.'
      : 'Nothing in this folder.'
  savedList.textContent = ''
  for (const entry of shown) {
    const row = document.createElement('li')
    row.className = `entry${entry.missing === true ? ' is-missing' : ''}`

    const jump = document.createElement('button')
    jump.type = 'button'
    jump.className = 'entry-jump'
    jump.textContent = entry.name
    jump.title = entry.missing === true ? 'This layer is gone from the file' : 'Select it on the canvas'
    jump.disabled = entry.missing === true
    jump.addEventListener('click', () => {
      post({ type: 'pick', id: entry.id })
      say(`Jumped to ${entry.name}.`)
    })
    row.appendChild(jump)

    const type = document.createElement('span')
    type.className = 'entry-type'
    type.textContent = entry.missing === true ? 'missing' : entry.type.toLowerCase()
    row.appendChild(type)

    const move = document.createElement('select')
    move.className = 'entry-move'
    move.title = 'Move it to another folder'
    for (const name of folderNames()) {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name === '' ? 'Root' : name
      option.selected = name === entry.folder
      move.appendChild(option)
    }
    move.addEventListener('change', () => {
      post({ type: 'move-saved', ids: [entry.id], folder: move.value })
    })
    row.appendChild(move)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'button ghost small'
    remove.textContent = 'Remove'
    remove.addEventListener('click', () => post({ type: 'unsave', ids: [entry.id] }))
    row.appendChild(remove)

    savedList.appendChild(row)
  }
}

saveSelection.addEventListener('click', () => {
  post({ type: 'save-selection', folder: activeFolder ?? '' })
})

refreshSaved.addEventListener('click', () => {
  post({ type: 'refresh-saved' })
  say('Re-checked every entry against the file.')
})

/**
 * Naming a folder, in the list rather than in a dialog: a plugin iframe is
 * sandboxed, so `prompt()` is not something to rely on.
 */
function askForName(placeholder: string, initial: string, done: (name: string) => void): void {
  const row = document.createElement('li')
  row.className = 'folder'
  const input = document.createElement('input')
  input.className = 'input'
  input.placeholder = placeholder
  input.value = initial
  input.maxLength = 40
  row.appendChild(input)
  folderList.appendChild(row)
  input.focus()
  input.select()
  const finish = (commit: boolean) => {
    const name = input.value.trim()
    row.remove()
    if (commit && name !== '') done(name)
    else paintFolders()
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true)
    if (event.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(false))
}

newFolderButton.addEventListener('click', () => {
  askForName('Folder name', '', (name) => post({ type: 'create-folder', name }))
})

renameFolderButton.addEventListener('click', () => {
  const from = activeFolder
  if (from === null || from === '') return
  askForName('New name', from, (to) => {
    activeFolder = to
    post({ type: 'rename-folder', from, to })
  })
})

/**
 * Two clicks rather than a `confirm()`, which a sandboxed iframe cannot be
 * relied on to show. The second click within a few seconds is the answer.
 */
function armed(button: HTMLButtonElement, word: string, act: () => void): void {
  if (button.dataset.armed === '1') {
    button.dataset.armed = ''
    button.textContent = word
    act()
    return
  }
  button.dataset.armed = '1'
  button.textContent = 'Sure?'
  setTimeout(() => {
    if (button.dataset.armed !== '1') return
    button.dataset.armed = ''
    button.textContent = word
  }, 4_000)
}

function resetFolderActions(): void {
  for (const button of [emptyFolderButton, deleteFolderButton]) button.dataset.armed = ''
  emptyFolderButton.textContent = 'Empty'
  deleteFolderButton.textContent = 'Delete'
}

emptyFolderButton.addEventListener('click', () => {
  const folder = activeFolder
  if (folder === null || folder === '') return
  armed(emptyFolderButton, 'Empty', () => {
    post({ type: 'clear-saved', folder })
    say(`Emptied ${folder}.`)
  })
})

deleteFolderButton.addEventListener('click', () => {
  const name = activeFolder
  if (name === null || name === '') return
  armed(deleteFolderButton, 'Delete', () => {
    activeFolder = ''
    // Its entries are kept and move back to the root; emptying it first is how
    // you get rid of them, and that is a separate, equally deliberate act.
    post({ type: 'delete-folder', name, deleteEntries: false })
    say(`Deleted ${name}. Anything in it moved to the root.`)
  })
})

// ---------------------------------------------------------- the main thread

window.onmessage = (event: MessageEvent) => {
  const message = event.data?.pluginMessage as Incoming | undefined
  if (message === undefined || message === null) return

  switch (message.type) {
    case 'res': {
      const answer = message as PluginResponse
      const waiting = pending.get(answer.id)
      if (waiting === undefined) return
      pending.delete(answer.id)
      if (answer.ok) waiting.resolve(answer.data)
      else waiting.reject(new Error(answer.error ?? 'The plugin refused'))
      return
    }

    case 'agent-settings': {
      const settings = message as Extract<Incoming, { type: 'agent-settings' }>
      daemonUrl = settings.url === '' ? AGENT_URL : settings.url
      daemonToken = settings.token
      urlInput.value = daemonUrl
      tokenInput.value = daemonToken
      factUrl.textContent = daemonUrl
      settingsLoaded = true
      void probe()
      // A paired panel reconnects itself, which makes pairing a one-time job
      // rather than a morning ritual.
      if (daemonToken !== '') bridge.connect()
      return
    }

    case 'saved': {
      const set = message as Extract<Incoming, { type: 'saved' }>
      folders = set.folders
      entries = set.entries
      // A folder that has just been deleted or renamed away leaves the view
      // pointing at nothing; fall back to everything rather than to empty.
      if (activeFolder !== null && !folders.some((folder) => folder.name === activeFolder)) activeFolder = null
      paintFolders()
      paintSaved()
      return
    }

    case 'save-result': {
      const result = message as Extract<Incoming, { type: 'save-result' }>
      const parts = []
      if (result.added > 0) parts.push(`saved ${result.added}`)
      if (result.moved > 0) parts.push(`moved ${result.moved}`)
      if (result.already > 0) parts.push(`${result.already} already there`)
      if (result.full > 0) parts.push(`${result.full} would not fit — the set holds 100`)
      say(parts.length === 0 ? 'Nothing selected to save.' : parts.join(' · '), result.full > 0)
      return
    }

    case 'error':
      say(String((message as { message?: unknown }).message ?? 'Something went wrong'), true)
      return

    default:
      // Extractions, trees, thumbnails and the relay's sync frames: this panel
      // asked for none of them and shows none of them.
      return
  }
}

// Figma may reopen the window at a size the user dragged it to previously.
let resizeTimer: number | undefined
window.addEventListener('resize', () => {
  if (resizeTimer !== undefined) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    post({ type: 'resize', width: window.innerWidth, height: window.innerHeight })
  }, 400) as unknown as number
})

// ---------------------------------------------------------------- first run

urlInput.value = daemonUrl
factUrl.textContent = daemonUrl
paintEdits()
paintTools()
paintFolders()
paintSaved()
showLink('off')
post({ type: 'ready' })

// A daemon may be running before the panel has ever been paired, and saying so
// is what turns "nothing happens" into "paste the token".
setTimeout(() => {
  if (!settingsLoaded) void probe()
}, 500)
