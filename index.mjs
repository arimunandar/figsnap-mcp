// figsnap-mcp, as a library.
//
// The package is two commands — `figsnap-mcp-daemon` and `figsnap-mcp` — and
// this is what is left when you want the pieces rather than the pair of them:
// the tool catalogue, the contract the plugin answers on, and the three
// factories the daemon is assembled from.
//
// Nothing here starts a server or touches the network on import. That is a
// deliberate property, and test/e2e-package.mjs holds it: `agent/mcp-stdio.mjs`
// connects an MCP server to stdio the moment it is loaded, so it is not
// re-exported and must not be imported to read a constant off it.
//
//   import { toolManifest } from 'figsnap-mcp'
//
// Semver applies from 1.0.0. While this is 0.x, treat the factories as the part
// most likely to move; the catalogue and the constants are the stable half.

export { OUTPUTS, TOOLS_BY_NAME, parseColor, toolManifest } from './agent/lib/tools.mjs'

export { DEFAULT_AGENT_URL, DEFAULT_PORT, HOST, PANEL_PATH, TOKEN_FILE } from './agent/lib/paths.mjs'

export { FINDABLE_TYPES } from './shared/nodes.mjs'

export {
  base64Bytes,
  batchCommand,
  folderWriteCommand,
  requestedDepth,
  requestedScale,
  savedAddCommand,
  savedDeleteCommand,
  shapeExtraction,
} from './shared/shape.mjs'

export { createGate } from './agent/lib/gate.mjs'

export { createPluginSocket, originAllowed } from './agent/lib/plugin-socket.mjs'

export { PANEL_CLOSED, applyCors, createHttpHandler, runTool } from './agent/lib/http.mjs'
