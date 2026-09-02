#!/usr/bin/env node
// figsnap-mcp-daemon — the local bridge between the Figma panel and an MCP client.
//
// One daemon, two faces, both on loopback:
//
//   · a WebSocket server the plugin panel dials in on          (lib/plugin-socket.mjs)
//   · an MCP server any client spawns to reach the canvas      (mcp-stdio.mjs)
//
// Nothing runs a coding agent here, and nothing signs in anywhere. The plugin
// holds the Figma Plugin API, this daemon holds the port, and the MCP server is
// a stateless proxy between whatever the designer's client is and the file they
// have open.
//
//   node agent/index.mjs            or, once installed, figsnap-mcp-daemon
//
// Two things guard the socket, because a local port is reachable by any page
// the designer happens to visit: the Origin header on upgrade, which a browser
// cannot forge, and a token in the query string, because a browser WebSocket
// cannot set headers.
//
// 3058 rather than Figsnap's 3056, and ~/.figsnap-mcp rather than ~/.figsnap, so
// this daemon and that one can be running at the same time without either
// reading the other's config.

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createPluginSocket } from './lib/plugin-socket.mjs'
import { createGate } from './lib/gate.mjs'
import { createHttpHandler } from './lib/http.mjs'
import { DEFAULT_PORT, HOST, PANEL_PATH, TOKEN_FILE } from './lib/paths.mjs'

const VERSION = '0.1.0'
// This package is private, so `npx figsnap-mcp` is not the way in. The MCP
// server is this file's sibling, and naming the real path is the difference
// between advice that works and advice that looks like it should.
const MCP_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'mcp-stdio.mjs')
/** A port from the environment, or a refusal that names what was wrong with it. */
function resolvePort() {
  const raw = process.env.FIGSNAP_MCP_PORT
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const port = Number(raw)
  // 0 is "any free port" to bind(), which is useless here: the plugin manifest
  // names one port and Figma will not let it dial another.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`FIGSNAP_MCP_PORT is not a port number: ${JSON.stringify(raw)}. Leave it unset for ${DEFAULT_PORT}.`)
    process.exit(1)
  }
  return port
}

const PORT = resolvePort()
const quiet = process.argv.includes('--quiet')
// The Edits gate lives in this daemon, which is what makes it one gate rather
// than one per client. Its switch has only ever been in the plugin panel, which
// is the wrong end for someone working in a terminal: writing a fill meant
// switching to Figma and ticking a box first. This is the same explicit act, in
// the place the work is happening. The panel's switch still shows it, and still
// turns it off.
const allowEdits =
  process.argv.includes('--allow-edits') ||
  process.env.FIGSNAP_MCP_ALLOW_EDITS === '1' ||
  process.env.FIGSNAP_MCP_ALLOW_EDITS === 'true'

// `figsnap-mcp-daemon --mcp` prints the block an MCP client wants and exits.
// Printing it on every start would be noise; needing it is a one-time job.
if (process.argv.includes('--mcp')) {
  console.log(
    JSON.stringify(
      { mcpServers: { 'figsnap-mcp': { command: process.execPath, args: [MCP_SERVER] } } },
      null,
      2,
    ),
  )
  console.log(`\nOr, in a terminal:  claude mcp add figsnap-mcp -s user -- node ${MCP_SERVER}`)
  console.log(`Both find the daemon on ${HOST}:${PORT} and its token in ~/.figsnap-mcp/agent-token.`)
  process.exit(0)
}

const HELP = `figsnap-mcp-daemon ${VERSION} — the local bridge between the Figma plugin and an MCP client.

  figsnap-mcp-daemon [options]

  --allow-edits     open the writing tools at boot, instead of from the plugin
  --new-token       rotate the token, invalidating the one the plugin has
  --quiet           no per-frame logging
  --mcp             print the MCP client registration and exit
  --version         print the version and exit
  --help            this

Environment:
  FIGSNAP_MCP_PORT         default ${DEFAULT_PORT}
  FIGSNAP_MCP_TOKEN        use this token instead of ~/.figsnap-mcp/agent-token
  FIGSNAP_MCP_ALLOW_EDITS  1 or true, same as --allow-edits

The daemon listens on 127.0.0.1 only. It needs the Figma plugin open to answer
anything: the Figma Plugin API exists only while the plugin is running.`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP)
  process.exit(0)
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(VERSION)
  process.exit(0)
}

const subcommand = typeof process.argv[2] === 'string' && !process.argv[2].startsWith('-') ? process.argv[2] : ''
if (subcommand !== '') {
  console.error(`No such command: ${subcommand}. This daemon takes flags only — try --help.`)
  process.exit(1)
}

function log(...args) {
  if (!quiet) console.log(new Date().toISOString().slice(11, 19), ...args)
}

/**
 * The same token across restarts, so the panel is not re-paired every morning.
 * `--new-token` rotates it, which is the answer if one ever leaks.
 */
async function resolveToken() {
  const fromEnv = process.env.FIGSNAP_MCP_TOKEN
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  if (!process.argv.includes('--new-token')) {
    const stored = await readFile(TOKEN_FILE, 'utf8').catch(() => null)
    if (stored !== null && stored.trim() !== '') return stored.trim()
  }
  const fresh = randomBytes(24).toString('base64url')
  await mkdir(dirname(TOKEN_FILE), { recursive: true })
  await writeFile(TOKEN_FILE, fresh + '\n', { mode: 0o600 })
  return fresh
}

const TOKEN = await resolveToken()

const plugin = createPluginSocket({ token: TOKEN, log })

// Told to the panel every time it changes, so the switch in the plugin and the
// gate in front of the tools cannot disagree — including when the change came
// from `--allow-edits` rather than from the panel.
const gate = createGate({
  allowEdits,
  announce: () => plugin.send({ kind: 'state', writes: gate.writesAllowed() }),
})

const server = createServer(createHttpHandler({ plugin, gate, token: TOKEN, version: VERSION }))
const wss = new WebSocketServer({ server, path: PANEL_PATH, maxPayload: 64 * 1024 * 1024 })
wss.on('connection', (socket, req) => plugin.handleConnection(socket, req))

// ------------------------------------------------------------- panel frames
//
// The transport is the relay's, unchanged, so `src/ui/bridge.ts` drives it
// without knowing what is on the other end. Above `request` there are two
// frames in and two frames out, because there is only one piece of state on
// this side worth telling the panel about.

function onPanelFrame(message) {
  // Every frame the panel sends, named. When something in the panel does not
  // reach here, that is the difference between a broken button and a broken
  // daemon, and there is no other way to tell them apart from this side.
  log(`panel: ${message.kind ?? 'unknown'}`)
  try {
    switch (message.kind) {
      case 'hello':
        plugin.send({ kind: 'state', writes: gate.writesAllowed() })
        break

      case 'writes':
        gate.setWrites(message.on === true)
        break

      default:
        // `event` frames are the relay's; nothing here subscribes to them.
        break
    }
  } catch (error) {
    plugin.send({ kind: 'notice', level: 'error', text: error instanceof Error ? error.message : String(error) })
  }
}

plugin.onFrame(onPanelFrame)

// A panel that reconnects has forgotten nothing on this side, so it is told
// where the gate stands rather than being left to guess.
plugin.onPresence((present) => {
  if (present) plugin.send({ kind: 'state', writes: gate.writesAllowed() })
})

// Binding is the one startup step that fails routinely — Figsnap's own daemon,
// a second copy of this one, a stale process — and an unhandled 'error' event
// exits with a stack trace naming nothing the designer can act on.
function onServerError(error) {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use, so this daemon did not start.\n\n` +
        `  · another figsnap-mcp-daemon may already be running — check http://${HOST}:${PORT}/health\n` +
        '  · or something else has the port; set FIGSNAP_MCP_PORT to move this one, and change the\n' +
        "    two localhost entries in the plugin's manifest.json to match.",
    )
    process.exit(1)
  }
  if (error.code === 'EACCES') {
    console.error(`Not allowed to listen on port ${PORT}. Ports below 1024 need privileges; pick a higher one.`)
    process.exit(1)
  }
  console.error(`The daemon could not start: ${error.message}`)
  process.exit(1)
}

server.on('error', onServerError)
// And on the WebSocket server as well, which is not belt and braces.
//
// `ws` attaches its own 'error' listener to the HTTP server and re-emits on the
// WebSocketServer — and it attaches it where the WebSocketServer is constructed,
// which is above. An EventEmitter given an 'error' with nobody listening throws,
// so that re-emit was raising before the handler above ever ran: EADDRINUSE came
// out as an uncaught exception with a stack trace through node:net, which is
// exactly the message this function exists to replace.
wss.on('error', onServerError)

server.listen(PORT, HOST, () => {
  console.log(`figsnap-mcp-daemon ${VERSION}`)
  console.log(`  panel socket   ws://${HOST}:${PORT}${PANEL_PATH}`)
  console.log(`  http           http://${HOST}:${PORT}`)
  console.log(`  token          ${TOKEN}`)
  console.log(
    allowEdits
      ? '  edits          allowed — started with --allow-edits, so the writing tools are open'
      : '  edits          off — turn them on in the plugin, or start with --allow-edits',
  )
  console.log('\nPaste the token into the plugin’s Connect pane.')
  console.log(`To reach the same designs from a terminal:  claude mcp add figsnap-mcp -s user -- node ${MCP_SERVER}`)
})

let stopping = false

function shutdown() {
  if (stopping) return
  stopping = true
  // An open WebSocket keeps the server's close callback from ever firing, so
  // the panel is told to go before the port is given up.
  for (const socket of wss.clients) {
    try {
      socket.close(1001, 'The daemon is shutting down')
    } catch {
      // Already gone; nothing to do about it.
    }
  }
  server.close(() => process.exit(0))
  // A socket that will not close should not hold the process open forever.
  setTimeout(() => process.exit(0), 1_000).unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown)

// A rejected promise somewhere in a frame handler must not take the daemon with
// it: the plugin would stay connected to a process that had stopped answering.
process.on('unhandledRejection', (reason) => {
  const why = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
  console.error(`figsnap-mcp-daemon: an operation failed and was not handled — ${why}`)
})

// An uncaught exception is a different matter: the state is unknown, so say so
// plainly and stop rather than answer tool calls from a process in that shape.
process.on('uncaughtException', (error) => {
  console.error(`figsnap-mcp-daemon stopped: ${error.stack ?? error.message}`)
  console.error('Start it again; if this repeats, please report it with the lines above.')
  process.exit(1)
})
