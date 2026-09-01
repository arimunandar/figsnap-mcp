// WebSocket link from the plugin UI to a server outside Figma.
//
// Only the UI thread has a real WebSocket, so it acts as the proxy: the far end
// sends a command, the UI asks the main thread for the data, and the reply goes
// back out over the same socket.
//
// Two servers use it. The relay carries designs out to an agent in a project;
// the agent daemon carries a conversation in. They speak the same frames, and
// the only difference here is `onFrame`, which the daemon needs and the relay
// never fires.

export type BridgeStatus = 'off' | 'connecting' | 'open' | 'retrying'

type BridgeOptions = {
  url: () => string
  onStatus: (status: BridgeStatus, detail?: string) => void
  request: (command: string, params: Record<string, unknown>) => Promise<unknown>
  /** The relay refused the token, so the session is over and only signing in fixes it. */
  onRejected?: () => void
  /**
   * Every frame that parses, before the request handling below decides it is
   * not interested. The relay only ever sends requests, so this changes nothing
   * for it; the agent daemon on the same transport also streams a conversation,
   * and this is where the panel picks that up.
   */
  onFrame?: (message: Record<string, unknown>) => void
  /** Names the far end in the messages a terminal close produces. */
  label?: string
}

const FIRST_RETRY_MS = 1_000
const MAX_RETRY_MS = 15_000

// A WebSocket through Cloudflare's edge can be dropped without a close frame
// reaching either end, which shows up as a socket that looks open and answers
// nothing. Pinging turns that into a close, which the retry path already handles.
const PING_EVERY_MS = 25_000
const SILENCE_LIMIT_MS = PING_EVERY_MS * 2 + 5_000

/**
 * Close codes the server uses deliberately. Retrying either one is worse than
 * stopping: reconnecting after being replaced makes two plugin windows kick each
 * other in a loop, and reconnecting with a rejected token just repeats it.
 *
 * The same three codes come from the relay and from the agent daemon, so the
 * side that opened the socket names itself rather than being assumed.
 */
function terminalClose(who: string): Record<number, string> {
  return {
    4000: 'Another plugin window has the connection. Close the other one, then press Reconnect.',
    4001: `The ${who} rejected the token. Check it in the settings.`,
    4002: `The ${who} refused another reconnection. Close the duplicate plugin window, then press Reconnect.`,
  }
}

/** PNG bytes cross the socket as base64; chunked so the argument list stays sane. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(offset, offset + chunk)))
  }
  return btoa(binary)
}

function encodeBinary(value: unknown): unknown {
  if (value instanceof Uint8Array) return toBase64(value)
  if (Array.isArray(value)) return value.map(encodeBinary)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = encodeBinary(entry)
    }
    return out
  }
  return value
}

export function createBridge(options: BridgeOptions) {
  let socket: WebSocket | null = null
  let enabled = false
  let retryMs = FIRST_RETRY_MS
  let retryTimer: number | undefined
  let pingTimer: number | undefined
  let lastHeard = 0

  function clearRetry() {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  function stopPinging() {
    if (pingTimer !== undefined) {
      clearInterval(pingTimer)
      pingTimer = undefined
    }
  }

  /** Runs only while a socket is open; a missed answer closes it rather than waits. */
  function startPinging(current: WebSocket) {
    stopPinging()
    lastHeard = Date.now()
    pingTimer = setInterval(() => {
      if (current.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastHeard > SILENCE_LIMIT_MS) {
        current.close(4100, 'No answer to a keepalive ping')
        return
      }
      current.send(JSON.stringify({ kind: 'ping' }))
    }, PING_EVERY_MS) as unknown as number
  }

  function scheduleRetry(detail: string) {
    if (!enabled) return
    options.onStatus('retrying', `${detail} — retrying in ${Math.round(retryMs / 1000)}s`)
    clearRetry()
    retryTimer = setTimeout(open, retryMs)
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
  }

  function open() {
    if (!enabled) return
    clearRetry()
    // A socket already in hand is replaced, not joined: two live sockets from
    // one panel make the server kick one of them, and the kicked one's own
    // close handling would then speak for the survivor.
    if (socket !== null) {
      const previous = socket
      socket = null
      previous.close(1000, 'Replaced by a fresh connection from this panel')
    }
    options.onStatus('connecting')

    let next: WebSocket
    try {
      next = new WebSocket(options.url())
    } catch (error) {
      scheduleRetry(error instanceof Error ? error.message : `Bad ${options.label ?? 'relay'} address`)
      return
    }
    socket = next

    next.addEventListener('open', () => {
      // A socket that finished connecting after being superseded has nothing to
      // say; every handler below asks the same question first.
      if (socket !== next) {
        next.close(1000, 'Superseded before it opened')
        return
      }
      retryMs = FIRST_RETRY_MS
      startPinging(next)
      options.onStatus('open')
    })

    next.addEventListener('message', async (event: MessageEvent) => {
      // Any frame at all proves the path is whole, not just a pong.
      lastHeard = Date.now()
      let message: { kind?: string; id?: string; command?: string; params?: Record<string, unknown> }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      options.onFrame?.(message as Record<string, unknown>)
      if (message.kind !== 'request' || !message.id || !message.command) return

      try {
        const data = await options.request(message.command, message.params ?? {})
        next.send(JSON.stringify({ kind: 'response', id: message.id, ok: true, data: encodeBinary(data) }))
      } catch (error) {
        next.send(
          JSON.stringify({
            kind: 'response',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    })

    next.addEventListener('close', (event: CloseEvent) => {
      // Not the socket in use any more: its close says nothing about the one
      // that is. Reporting it would stop the live socket's keepalive, or —
      // when the server closed it as a replacement — declare the whole bridge
      // off while it is in fact connected.
      if (socket !== next) return
      socket = null
      stopPinging()
      if (!enabled) {
        options.onStatus('off')
        return
      }
      const terminal = terminalClose(options.label ?? 'relay')[event.code]
      if (terminal) {
        enabled = false
        clearRetry()
        options.onStatus('off', terminal)
        // A rejected token is the one terminal case the panel can recover from,
        // by signing in again, so it is reported rather than only displayed.
        if (event.code === 4001) options.onRejected?.()
        return
      }
      scheduleRetry(event.reason || `Closed (${event.code})`)
    })

    // A refused connection fires error then close; close does the retry.
    next.addEventListener('error', () => {
      if (socket !== next) return
      options.onStatus('retrying', `The ${options.label ?? 'relay'} is unreachable`)
    })
  }

  return {
    connect() {
      enabled = true
      retryMs = FIRST_RETRY_MS
      open()
    },
    disconnect() {
      enabled = false
      clearRetry()
      stopPinging()
      socket?.close(1000, 'Disabled in the panel')
      socket = null
      options.onStatus('off')
    },
    event(name: string, data: unknown) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ kind: 'event', event: name, data }))
      }
    },
    /** A frame of the caller's own shape. Dropped, not queued, when closed. */
    send(frame: Record<string, unknown>): boolean {
      if (socket?.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify(frame))
      return true
    },
    isOpen() {
      return socket?.readyState === WebSocket.OPEN
    },
  }
}
