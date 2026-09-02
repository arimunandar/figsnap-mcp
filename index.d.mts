// Types for the library half of figsnap-mcp.
//
// Hand-written rather than generated: the runtime is plain ESM JavaScript, and a
// declaration file that says what a consumer may rely on is a smaller and more
// honest contract than one inferred from the implementation. test/e2e-package.mjs
// checks that every runtime export is declared here and the reverse.

// ------------------------------------------------------------------ addresses

/** Loopback. Nothing in this package is meant to be reachable off the machine. */
export declare const HOST: '127.0.0.1'

/** 3058 — Figsnap's own daemon is on 3056, so the two can run at once. */
export declare const DEFAULT_PORT: number

/** Where the Figma panel's WebSocket lands on the daemon. */
export declare const PANEL_PATH: '/panel'

/** What an MCP client proxies to when `FIGSNAP_MCP_URL` is unset. */
export declare const DEFAULT_AGENT_URL: string

/** `~/.figsnap-mcp/agent-token`, absolute. Written by the daemon on first start. */
export declare const TOKEN_FILE: string

// ------------------------------------------------------------------ the tools

/** Every representation the plugin can produce, in the order it returns them. */
export declare const OUTPUTS: readonly string[]

/** The layer types `figma_find_nodes` will search for. */
export declare const FINDABLE_TYPES: string[]

/** One tool, as an MCP client is shown it. */
export interface ToolDescription {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations: {
    /** False for anything that writes, including the saved set. */
    readOnlyHint: boolean
    /** True only for tools gated behind the Edits switch. */
    destructiveHint: boolean
  }
}

/** One tool as the daemon holds it, with the plugin command it maps onto. */
export interface Tool extends ToolDescription {
  /** A fixed command, or one chosen from the arguments. */
  command: string | ((args: Record<string, unknown>) => string)
  /** The body to send the plugin. */
  params: (args: Record<string, unknown>) => Record<string, unknown>
  /** Whether the Edits switch has to be on for this to run. */
  mutates?: boolean
  /** Whether the answer is an image block rather than JSON. */
  image?: boolean
  readOnly?: boolean
}

/** The catalogue an MCP client sees: no command, no params, no `mutates`. */
export declare function toolManifest(): ToolDescription[]

/** The same tools, by name, with the plugin command attached. */
export declare const TOOLS_BY_NAME: ReadonlyMap<string, Tool>

/** A hex colour as designers write it, in the 0-1 triples the Plugin API wants. */
export declare function parseColor(value: unknown): { r: number; g: number; b: number }

// ------------------------------------------------------- the request contract
//
// Which plugin command a given HTTP body means. The daemon and the plugin both
// answer to these, which is what keeps one from drifting from the other.

/** Bytes behind a base64 string, without decoding it. */
export declare function base64Bytes(base64: string): number

/** The render scale a body asked for: 1 to 4, defaulting to 2. */
export declare function requestedScale(body: unknown): number

/** The tree depth a query string asked for, as the plugin wants it. */
export declare function requestedDepth(searchParams: URLSearchParams | null | undefined): { depth?: string }

/** Turns a raw extraction into whichever image reference was asked for. */
export declare function shapeExtraction(
  data: Record<string, unknown>,
  origin: string,
  scale: number,
): Record<string, unknown>

/** `save_nodes` when the body names ids, `save_selection` when it does not. */
export declare function savedAddCommand(body: unknown): 'save_nodes' | 'save_selection'

/** `clear_saved` or `unsave`, depending on what the body names. */
export declare function savedDeleteCommand(body: unknown): 'clear_saved' | 'unsave'

/** `rename_folder` when the body has a `from`, `create_folder` when it does not. */
export declare function folderWriteCommand(body: unknown): 'rename_folder' | 'create_folder'

/** Which batch extraction a body means, or null for a single node. */
export declare function batchCommand(
  body: unknown,
): 'extract_urls' | 'extract_nodes' | 'extract_selection' | 'extract_saved' | null

// ----------------------------------------------------------------- the bridge

/** The Edits switch: one gate, held by the designer, in front of every write. */
export interface Gate {
  writesAllowed(): boolean
  setWrites(on: boolean): void
  state(): { writes: boolean }
}

export declare function createGate(options?: {
  /** Open at startup, as `--allow-edits` does. */
  allowEdits?: boolean
  /** Called after every change, to tell the panel where the gate stands. */
  announce?: () => void
}): Gate

/** Whether a WebSocket upgrade's Origin is one a Figma plugin can present. */
export declare function originAllowed(origin: string | null | undefined): boolean

/** The socket the Figma panel dials in on, and the only route into `figma.*`. */
export interface PluginSocket {
  /** Hand an upgraded socket to the bridge. */
  handleConnection(socket: unknown, req: unknown): void
  /** Ask the panel for something and wait. Rejects after 30s, or on disconnect. */
  request(command: string, params?: Record<string, unknown>): Promise<unknown>
  /** Push a frame at the panel. False when nothing is listening. */
  send(frame: Record<string, unknown>): boolean
  connected(): boolean
  /** Constant-time. True for any candidate when no token is configured. */
  authorized(candidate: string): boolean
  /** Frames the panel sent that were not a response or a ping. */
  onFrame(handler: (message: Record<string, unknown>) => void): () => void
  /** True when a panel attaches, false when it goes away. */
  onPresence(handler: (present: boolean) => void): () => void
  pendingCount(): number
}

export declare function createPluginSocket(options: {
  /** Empty accepts any candidate, which is only ever right in a test. */
  token: string
  log: (...args: unknown[]) => void
}): PluginSocket

/** One MCP content block, as a tool result carries it. */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/**
 * One tool call, from name and arguments through the panel and into `figma.*`.
 *
 * Throws rather than returning an error: the Edits gate, an unknown tool and a
 * closed plugin are three different refusals and each message is the answer.
 */
export declare function runTool(options: {
  plugin: PluginSocket
  gate: Gate
  name: string
  args?: Record<string, unknown>
}): Promise<ToolContent[]>

/** The wording for the one thing no amount of plumbing can fix. */
export declare const PANEL_CLOSED: string

/** Figma's origins only, and only when the request carried one. */
export declare function applyCors(req: unknown, res: unknown): void

/** The daemon's HTTP face: `/health`, `/tools`, `/tool`, and 404. */
export declare function createHttpHandler(options: {
  plugin: PluginSocket
  gate: Gate
  /** Empty disables the check, which is only ever right in a test. */
  token: string
  version: string
}): (req: unknown, res: unknown) => Promise<void>
