// The addresses and files every part of this package has to agree on.
//
// They were written out in three places — the daemon, the MCP server and the
// plugin's own src/daemon.ts — and two of them could be imported only by
// starting a server, which is not a thing a caller should have to do to learn a
// port number. The plugin's copy stays separate because it is bundled into a
// Figma sandbox that has no Node at all; test/contract.mjs holds the two in step.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Loopback only. There is nothing here that should be reachable off the machine. */
export const HOST = '127.0.0.1'

/**
 * 3058, where Figsnap's own daemon is on 3056, so both can run at once.
 *
 * A fixed port rather than a range because a Figma plugin manifest has to name
 * the addresses it may dial, `ws://localhost:*` is not something it accepts, and
 * an unreachable address fails as a silent CSP refusal rather than an error.
 */
export const DEFAULT_PORT = 3058

/** Where the panel's WebSocket lands. */
export const PANEL_PATH = '/panel'

/** What an MCP client proxies to, absent FIGSNAP_MCP_URL. */
export const DEFAULT_AGENT_URL = `http://${HOST}:${DEFAULT_PORT}`

/**
 * The daemon writes its token here on first start and reads it back on every
 * later one, which is what lets an MCP client need no configuration at all.
 */
export const TOKEN_FILE = join(homedir(), '.figsnap-mcp', 'agent-token')
