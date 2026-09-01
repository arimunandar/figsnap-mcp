#!/usr/bin/env node
// figsnap-mcp — the Figma file the designer has open, as MCP tools.
//
// Every tool here proxies to the daemon over loopback HTTP, which forwards it
// down the panel's WebSocket into `figma.*`. Resources ride the same route, for
// the handful of things a client would rather `@`-mention than call a tool for.
//
// Anything that speaks MCP can spawn this — Claude Code in a terminal, an
// editor, a script — which is the point: the designs are wherever the designer
// is working, not only inside Figma.
//
//   claude mcp add figsnap-mcp -- node <this repo>/agent/mcp-stdio.mjs
//
// Nothing needs configuring beyond that, because both defaults are knowable: the
// daemon listens on a fixed port and writes its token to a fixed file. Set
// FIGSNAP_MCP_URL or FIGSNAP_MCP_TOKEN to override either.
//
// stdio rather than HTTP because it is the variant every MCP client has to
// support, and this server has nothing to gain from being reachable remotely.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolManifest } from './lib/tools.mjs'

export const DEFAULT_AGENT_URL = 'http://127.0.0.1:3058'
export const TOKEN_FILE = join(homedir(), '.figsnap-mcp', 'agent-token')

const BASE = process.env.FIGSNAP_MCP_URL ?? DEFAULT_AGENT_URL
// This repo is not on npm, so `npx figsnap-mcp` is not the way in. The daemon is
// this file's sibling, so the advice for starting it can name the real path
// rather than a package that does not exist.
const DAEMON = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs')

/** The daemon's own token file, so a client on this machine needs no setup. */
async function resolveToken() {
  const fromEnv = process.env.FIGSNAP_MCP_TOKEN
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const stored = await readFile(TOKEN_FILE, 'utf8').catch(() => null)
  return stored === null ? '' : stored.trim()
}

const TOKEN = await resolveToken()

const server = new Server(
  { name: 'figsnap-mcp', version: '0.1.0' },
  // Resources as well as tools: a client that can @-mention context should not
  // have to spend a tool call to get the obvious things. See RESOURCES below.
  { capabilities: { tools: {}, resources: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolManifest() }))

/** Why a call could not even be attempted, in words the caller can act on. */
function unreachable(error) {
  const why = error instanceof Error ? error.message : String(error)
  const refused = why.includes('ECONNREFUSED') || why.includes('fetch failed')
  return refused
    ? `No figsnap-mcp daemon at ${BASE}. Start it with \`node ${DAEMON}\` on the machine running Figma, ` +
        'then open the plugin so it has a file to reach.'
    : `The figsnap-mcp daemon is not answering: ${why}`
}

/**
 * Every call — a tool the agent chose, or a resource a client is reading —
 * leaves through the one `POST /tool` route. Answering with `{error}` rather
 * than throwing, because which of the three things went wrong is the useful
 * part and each has a different fix.
 */
async function callTool(name, args) {
  let answer
  try {
    const response = await fetch(`${BASE}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-figsnap-token': TOKEN },
      body: JSON.stringify({ name, arguments: args ?? {} }),
    })
    answer = await response.json()
  } catch (error) {
    // The daemon going away mid-run is the common case: the designer quit it,
    // or the machine slept. Say so rather than returning a protocol error, so
    // the agent can tell the user instead of retrying into the void.
    return { error: unreachable(error) }
  }

  if (answer.error === 'Bad or missing agent token') {
    return {
      error:
        'The figsnap-mcp daemon rejected the token. It writes one to ~/.figsnap-mcp/agent-token; ' +
        `set FIGSNAP_MCP_TOKEN to that value, or run \`node ${DAEMON}\` to create it.`,
    }
  }
  // The third way this fails, and the one that used to arrive as a timeout: the
  // daemon is up and paired, but the plugin is closed, so there is no `figma.*`
  // on the other end.
  if (typeof answer.error === 'string' && answer.error.includes('panel is not connected')) {
    return {
      error:
        'The Figsnap MCP plugin is not open in Figma. The daemon is running, but the Figma Plugin API only exists ' +
        'while the plugin does. Ask the designer to open the file and run Plugins > Development > Figsnap MCP.',
    }
  }

  if (answer.error !== undefined) return { error: String(answer.error) }
  if (!Array.isArray(answer.content)) return { error: 'The figsnap-mcp daemon answered with no content.' }
  return { content: answer.content }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const answer = await callTool(request.params.name, request.params.arguments ?? {})
  return answer.error === undefined
    ? { content: answer.content }
    : { isError: true, content: [{ type: 'text', text: answer.error }] }
})

// ------------------------------------------------------------------ resources
//
// The same designs, addressable rather than called for. A client that can
// @-mention a resource should not have to spend a turn deciding to call a tool
// for the three things a question about a Figma file almost always needs: what
// is selected, what is on the page, and what the design system holds.
//
// Each one is a tool that already exists, so there is no second path into the
// daemon and nothing here can drift from what the tools answer.

const RESOURCES = [
  {
    uri: 'figma://selection',
    name: 'Selection',
    description: 'Every layer the designer has selected right now, extracted as HTML and figmaCss.',
    mimeType: 'application/json',
    read: () => ['figma_extract', { selection: true }],
  },
  {
    uri: 'figma://page',
    name: 'Current page',
    description: 'The layer tree of the page the designer is looking at, three levels deep.',
    mimeType: 'application/json',
    read: () => ['figma_get_tree', { depth: 3 }],
  },
  {
    uri: 'figma://library',
    name: 'Design system',
    description: 'The components, styles and variables this file has, with their ids.',
    mimeType: 'application/json',
    read: () => ['figma_list_library', {}],
  },
]

const NODE_TEMPLATE = {
  uriTemplate: 'figma://node/{nodeId}',
  name: 'One node',
  description: 'The extraction of a single layer, by Figma node id — figma://node/21:10314.',
  mimeType: 'application/json',
}

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
}))

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [NODE_TEMPLATE],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = String(request.params.uri ?? '')
  const fixed = RESOURCES.find((resource) => resource.uri === uri)
  const node = /^figma:\/\/node\/(.+)$/.exec(uri)
  if (fixed === undefined && node === null) throw new Error(`No Figsnap resource at ${uri}`)

  const [name, args] = fixed !== undefined ? fixed.read() : ['figma_extract', { nodeId: decodeURIComponent(node[1]) }]
  const answer = await callTool(name, args)
  // A resource read has no isError, so a failure has to be an error: a client
  // that pasted the text of a refusal into the prompt as though it were the
  // design would be worse than one that reported the read failed.
  if (answer.error !== undefined) throw new Error(answer.error)

  const text = answer.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return { contents: [{ uri, mimeType: fixed?.mimeType ?? NODE_TEMPLATE.mimeType, text }] }
})

await server.connect(new StdioServerTransport())
