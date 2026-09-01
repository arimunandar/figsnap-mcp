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
import { homedir } from 'node:os'
import { WebSocketServer } from 'ws'
import { createPluginSocket } from './lib/plugin-socket.mjs'
import { createGate } from './lib/gate.mjs'
import { createHttpHandler } from './lib/http.mjs'

const VERSION = '0.1.0'
// This package is private, so `npx figsnap-mcp` is not the way in. The MCP
// server is this file's sibling, and naming the real path is the difference
// between advice that works and advice that looks like it should.
const MCP_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'mcp-stdio.mjs')
const PORT = Number(process.env.FIGSNAP_MCP_PORT ?? 3058)
const HOST = '127.0.0.1'
const TOKEN_FILE = join(homedir(), '.figsnap-mcp', 'agent-token')
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

const subcommand = typeof process.argv[2] === 'string' && !process.argv[2].startsWith('-') ? process.argv[2] : ''
if (subcommand !== '') {
  console.error(`No such command: ${subcommand}. This daemon takes flags only — try --allow-edits, --new-token or --mcp.`)
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
const wss = new WebSocketServer({ server, path: '/panel', maxPayload: 64 * 1024 * 1024 })
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

server.listen(PORT, HOST, () => {
  console.log(`figsnap-mcp-daemon ${VERSION}`)
  console.log(`  panel socket   ws://${HOST}:${PORT}/panel`)
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    // A socket that will not close should not hold the process open forever.
    setTimeout(() => process.exit(0), 500).unref()
  })
}
