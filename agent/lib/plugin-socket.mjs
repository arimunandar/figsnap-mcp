// The socket the Figma panel dials in on.
//
// Lifted from the local relay this project used to ship: the plugin cannot be
// reached from outside Figma, so it holds the connection open and everything
// else here asks questions down it. The frame vocabulary is unchanged, which is
// why `src/ui/bridge.ts` can drive this socket without knowing it is a different
// server — request/response, ping/pong, event, and the 4000/4001/4002 close
// codes the panel already treats as terminal.
//
// What is new is everything above `request`: this socket also carries the chat
// itself, because the panel is the human end of an ACP client that lives here.
// Those frames are handed to `onFrame` rather than interpreted, so the transport
// stays the relay's and the conversation stays the daemon's.

import { randomUUID, timingSafeEqual } from 'node:crypto'

const REQUEST_TIMEOUT_MS = 30_000

// Two plugin windows will each replace the other forever if both keep retrying.
const REPLACE_WINDOW_MS = 10_000
const REPLACE_LIMIT = 5

/**
 * A plugin iframe is a sandboxed document, so it sends `null`; the editor itself
 * sends figma.com. CORS does not apply to WebSocket, so this is the only place
 * the check can happen — and it is the check that matters, because a token alone
 * would not stop a page the user happens to visit from opening a socket to
 * localhost and reading it out of somewhere else.
 *
 * A request with no Origin at all is not a browser, and a non-browser on this
 * machine is what the token is for.
 */
export function originAllowed(origin) {
  if (origin === undefined || origin === null || origin === '') return true
  return origin === 'null' || origin === 'https://www.figma.com' || origin === 'https://figma.com'
}

export function createPluginSocket({ token, log }) {
  /** @type {import('ws').WebSocket | null} */
  let panel = null
  let replacements = []
  // Sockets are numbered and counted because the failure that matters here is
  // two of them at once: the newest wins, the loser is closed with 4000, and a
  // panel that mishandles that close reports a working link as dead. A bare
  // "connected" line cannot tell that story; these can.
  let opened = 0
  let live = 0
  const pending = new Map()
  const listeners = new Set()
  const watchers = new Set()

  /**
   * Constant-time, because `===` on a secret leaks its prefix through timing to
   * anything that can make repeated attempts — and a local port can be dialled
   * in a loop by any page the designer happens to visit. The length difference
   * still leaks, which is why the token is a fixed 32 characters.
   */
  function authorized(candidate) {
    if (token === '') return true
    const offered = Buffer.from(String(candidate ?? ''))
    const expected = Buffer.from(token)
    return offered.length === expected.length && timingSafeEqual(offered, expected)
  }

  function connected() {
    return panel !== null && panel.readyState === panel.OPEN
  }

  function settle(id, ok, payload) {
    const entry = pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(id)
    if (ok) entry.resolve(payload)
    else entry.reject(new Error(String(payload)))
  }

  /** Asks the panel for something and waits. The panel relays it to figma.*. */
  function request(command, params = {}) {
    if (!connected()) {
      return Promise.reject(new Error('The Figma panel is not connected. Open the plugin in Figma.'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for the Figma panel`))
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      panel.send(JSON.stringify({ kind: 'request', id, command, params }))
    })
  }

  /** Pushes a frame at the panel. Silently dropped when nothing is listening. */
  function send(frame) {
    if (!connected()) return false
    panel.send(JSON.stringify(frame))
    return true
  }

  function handleConnection(socket, req) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!originAllowed(req.headers.origin)) {
      socket.close(4001, 'Origin not allowed')
      log(`refused a socket from origin ${req.headers.origin}`)
      return
    }
    if (!authorized(url.searchParams.get('token') ?? '')) {
      socket.close(4001, 'Bad agent token')
      log('refused a socket with a bad token')
      return
    }

    if (connected()) {
      const now = Date.now()
      replacements = replacements.filter((at) => now - at < REPLACE_WINDOW_MS)
      if (replacements.length >= REPLACE_LIMIT) {
        socket.close(4002, 'Too many reconnections. Close the duplicate plugin window.')
        log('refused a replacement storm')
        return
      }
      replacements.push(now)
      // A reloaded plugin opens a second socket; the newest one wins.
      panel.close(4000, 'Replaced by a newer plugin connection')
    }

    opened += 1
    live += 1
    const id = opened
    panel = socket
    log(`panel connected  (socket #${id}, ${live} live)`)
    for (const watcher of watchers) watcher(true)

    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        log('dropped a malformed frame')
        return
      }
      // Answering a ping is what tells the panel the socket is still whole.
      if (message.kind === 'ping') {
        socket.send(JSON.stringify({ kind: 'pong', at: Date.now() }))
        return
      }
      if (message.kind === 'response') {
        settle(message.id, message.ok !== false, message.ok === false ? message.error : message.data)
        return
      }
      for (const listener of listeners) {
        try {
          listener(message)
        } catch (error) {
          log(`frame handler failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })

    socket.on('close', (code, reason) => {
      live -= 1
      const why = `${code}${reason?.length ? ` ${reason}` : ''}`
      if (panel !== socket) {
        log(`socket #${id} closed after being replaced  (${why}, ${live} live)`)
        return
      }
      panel = null
      log(`panel disconnected  (socket #${id}, ${why}, ${live} live)`)
      // A pending request whose answer can no longer arrive is a hang, not a
      // wait, so every one of them is failed rather than left to time out.
      for (const waiting of Array.from(pending.keys())) settle(waiting, false, 'The Figma panel disconnected')
      for (const watcher of watchers) watcher(false)
    })

    socket.on('error', (error) => log(`socket error: ${error.message}`))
  }

  return {
    handleConnection,
    request,
    send,
    connected,
    authorized,
    /** Frames the panel sends that are not a response or a ping. */
    onFrame(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    /** Called with true when a panel attaches and false when it goes away. */
    onPresence(handler) {
      watchers.add(handler)
      return () => watchers.delete(handler)
    },
    pendingCount() {
      return pending.size
    },
  }
}
