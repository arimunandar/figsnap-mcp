# Figsnap MCP

[![CI](https://github.com/arimunandar/figsnap-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/arimunandar/figsnap-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/figsnap-mcp)](https://www.npmjs.com/package/figsnap-mcp)
[![node](https://img.shields.io/node/v/figsnap-mcp)](https://www.npmjs.com/package/figsnap-mcp)
[![licence](https://img.shields.io/npm/l/figsnap-mcp)](./LICENSE)

The Figma file you have open, as MCP tools — and nothing else.

A Figma plugin, a local daemon, and an MCP server. Your coding agent reads the
design, extracts a node as PNG, React, HTML or CSS, edits the canvas when you
allow it, and shares a saved set of components with you. No relay, no account, no
network beyond loopback.

```
  MCP client              figsnap-mcp              daemon                 the plugin
  (Claude Code)   stdio    (stateless      HTTP :3058       ws         (open in Figma)
       ─────────────────►   proxy)          ──────────►   /panel   ──────────►   figma.*
                                            127.0.0.1 only
```

Three processes and one rule: `figma.*` exists only while the plugin is open, so
the plugin holds the connection and everything else asks questions down it.

## What this is not

This repo is a derivative of [Figsnap](../Figsnap), cut down to one job. Figsnap
ships four products from one `package.json` — the plugin, a Cloudflare Worker
relay with accounts, an ACP chat client, and this MCP server. If all you want is
MCP tools and a saved set, you had to clone all of it, build a 4,200-line panel
you would never open, and load a plugin whose manifest whitelists a Worker you
would never sign in to.

So: **no ACP client, no harness discovery, no session store, no relay, no
accounts, no chat, no API browser, no code-export UI.** What is left is the
extraction engine, the 39 tools, and a panel with three panes.

Figsnap is not modified by any of this, and the two can run side by side — this
daemon is on port **3058** with its token in `~/.figsnap-mcp/agent-token`, where
Figsnap's is on 3056 with its token in `~/.figsnap/agent-token`.

One caution on that manifest: Figma validates `allowedDomains` and refuses an IP
literal — `Invalid value for allowedDomains. 'ws://127.0.0.1:3058' must be a
valid URL` — and a manifest it refuses is a manifest it does not load, so the
plugin quietly keeps running the last good one. Name `localhost`, and check the
console after any change here, because nothing else reports it.

They are kept apart in Figma too. `clientStorage` is keyed by plugin id, so the
manifest carries an id of its own rather than Figsnap's `REPLACE_ON_PUBLISH`, and
every key this plugin writes is prefixed `figsnap-mcp:` on top of that. Sharing
either one means sharing the stored daemon address, and a panel that inherits
`ws://localhost:3056` is then blocked by its own manifest's CSP — with a console
error the designer never sees. The panel also refuses any stored or typed address
outside the port its manifest allows, and drops the token that came with it.

## Install

```bash
npm install -g figsnap-mcp
```

Two commands come with it:

| | |
|---|---|
| `figsnap-mcp-daemon` | the bridge; leave it running while you work |
| `figsnap-mcp` | the MCP server, spawned by your client — not run by hand |

You can skip the install and let `npx` fetch it, which is what an MCP client
config usually does. The Figma plugin ships in the package too: after a global
install its manifest is at

```bash
npm root -g   # …/lib/node_modules — the manifest is figsnap-mcp/manifest.json
```

Or clone the repository and `npm install && npm run build`, which is the same
thing with the sources beside it.

## Getting it running

Five steps, once.

**1. Build it.**

```bash
npm install -g figsnap-mcp
```

From a clone instead: `npm install && npm run build`.

**2. Start the daemon.** Leave it running; it is the only thing that talks to
Figma.

```bash
figsnap-mcp-daemon                # --allow-edits opens the writing tools at boot
```

From a clone: `npm run daemon`. `figsnap-mcp-daemon --help` lists the rest.

It prints its address and its token:

```
figsnap-mcp-daemon 0.1.0
  panel socket   ws://127.0.0.1:3058/panel
  http           http://127.0.0.1:3058
  token          8fT2qN4vRk1pXwLzYc7BhJ0mAeUdSg9T
  edits          off — turn them on in the plugin, or start with --allow-edits
```

**3. Load the plugin.** In Figma desktop: **Plugins → Development → Import
plugin from manifest**, pick the package's `manifest.json` (`npm root -g` finds
it, or it is in the repository root), then run **Figsnap MCP**.

**4. Pair the panel.** Copy the `token` line from step 2 into the panel's
**Connect** pane and press **Connect**. The dot turns green and the Address
reads `ws://localhost:3058/panel`.

This is the only place a token is ever typed. It is stored in Figma's own
per-user storage, so the panel reconnects itself every time from now on.

**5. Register the MCP server.**

```bash
claude mcp add figsnap-mcp -s user -- npx -y figsnap-mcp
```

Restart the client, then `claude mcp list` shows `figsnap-mcp · ✔ Connected`.
From a clone, name the file instead: `-- node /path/to/FigsnapMCP/agent/mcp-stdio.mjs`.

Check the whole chain:

```bash
curl -s http://127.0.0.1:3058/health
# { "ok": true, "panelConnected": true, "editsAllowed": false, ... }
```

`panelConnected: true` is the line that matters — it means Figma is on the
other end.

## The token

**An MCP client never needs it.** This is the part that surprises people:
`claude mcp add` takes no token, no environment variable, no config. The MCP
server reads the daemon's own file on the way past.

Only two things use the token, and only one of them is you:

| Who | How it gets it |
|---|---|
| The Figma panel | You paste it, once, in **Connect** |
| `agent/mcp-stdio.mjs` | Reads `~/.figsnap-mcp/agent-token` by itself |

**Where it comes from.** The first time the daemon starts it makes one — 24
random bytes, base64url — and writes it to `~/.figsnap-mcp/agent-token` with
mode `600`. Every later start reads that same file back, so the token is stable
and the panel is not re-paired every morning.

**How to see it again** without restarting anything:

```bash
cat ~/.figsnap-mcp/agent-token
```

**Why there is one at all.** The daemon listens on a loopback port, and any web
page you happen to visit can open a socket to `localhost`. Two things stop it:
the `Origin` header, checked on upgrade, which a browser cannot forge; and this
token, because a browser WebSocket cannot set headers. Only `GET /health` is
reachable without it — so the panel can tell you the daemon is running before it
has been paired.

**If it leaks**, rotate it:

```bash
npm run daemon -- --new-token
```

That writes a fresh one and invalidates the old. Re-paste it in **Connect**; MCP
clients pick the new one up on their own, because they read the file.

**To use one of your own** — a fixed token in a script, say — set
`FIGSNAP_MCP_TOKEN` and the daemon uses it instead of the file. Set the same
variable for the MCP client if it cannot read your home directory.
`FIGSNAP_MCP_URL` moves the address the client dials.

## Wiring up an MCP client

```bash
claude mcp add figsnap-mcp -s user -- npx -y figsnap-mcp
```

For a client that takes JSON:

```json
{ "mcpServers": { "figsnap-mcp": { "command": "npx", "args": ["-y", "figsnap-mcp"] } } }
```

`figsnap-mcp-daemon --mcp` prints both, with paths already filled in.

Then `claude mcp list` should show `figsnap-mcp · ✔ Connected`, and in a session
`figma_get_selection` answers about whatever is selected on the canvas.

### When it does not answer

Three things can be wrong, and each says so differently:

| What the tool says | What to do |
|---|---|
| `No figsnap-mcp daemon at http://127.0.0.1:3058` | `npm run daemon` |
| `The Figsnap MCP plugin is not open in Figma` | Open the file and run the plugin |
| `The figsnap-mcp daemon rejected the token` | `cat ~/.figsnap-mcp/agent-token`, or set `FIGSNAP_MCP_TOKEN` |
| `Editing the file is switched off` | Turn on **Allow edits** in the plugin's Tools pane |

### Resources

Three things a question about a Figma file almost always needs are addressable
rather than called for, so a client can `@`-mention them:

| URI | What it is |
|---|---|
| `figma://selection` | Everything selected, extracted |
| `figma://page` | The layer tree, three levels deep |
| `figma://library` | Components, styles and variables, with ids |
| `figma://node/{nodeId}` | One layer — `figma://node/21:10314` |

## The panel

Four panes, and the one it opens on is **Selection**.

**Selection** is a preview of whatever you have picked on the canvas — the
picture, its name, type, size, child count and node id — with a folder picker
and a **Save** button beside it. Saving from here is the short way round: no
switching panes, no hunting for the layer again in a list.

The preview costs one PNG export. The panel used to run a full extraction on
every selection change — HTML, TSX, two stylesheets and a 2× image — for a
picture nobody was looking at; the code outputs are what MCP asks for, on
request, not what a click costs. A small layer is magnified at most 4×, so an
icon and a screen do not both fill the stage.

**Minimise** (the ▼ at the top right) drops the window to a 44px strip and the
preview under it, so the canvas is clear while the plugin keeps running — the
daemon needs the panel open, but you do not need to look at it. The strip still
names what is selected and still has **Save**, because those are the two things
worth having while you work. ▲ puts it back to whatever size you had dragged it
to.

**Connect** and **Tools** are pairing and the tool list; **Saved** is the folder
manager. Both are described below.

## The tools

39 of them, 13 read and 26 write. The **Tools** pane lists them all with the
writing ones marked; `GET /tools` is the same list as JSON.

Reading is always allowed. **Writing is not, until you say so** — every mutating
tool is refused until *Allow edits* is on, which is a switch the designer holds
rather than a prompt the agent can talk past. A harness running with permission
prompts disabled still cannot get past it. `--allow-edits` opens the same gate
from the terminal, for when the work is happening there.

Two tools fold thirteen plugin commands into one argument each, because 39 tool
descriptions already cost real context on every request:

- `figma_extract` takes `nodeId`, or `nodeIds`, `urls`, `selection: true`,
  `saved: true` for a batch.
- `figma_saved` takes an `action`: `list`, `folders`, `save`, `unsave`, `clear`,
  `move`, `newFolder`, `renameFolder`, `deleteFolder`.

A picture comes back as a real image block, never as base64 in a text field —
that is what `figma_export_png` is for, one node at a time.

## The saved set

The **Saved** pane is a place to keep the components you keep coming back to:
folders, *Save selection*, jump-to-node, move, remove. It is reachable over MCP
as `figma_list_saved` and `figma_saved`, so you and the agent are looking at the
same list.

It lives in `figma.clientStorage`, keyed by document id. That means: **per user,
per file, per machine.** Up to 100 entries and 30 folders, one level deep.

**One deliberate loss.** Figsnap also mirrors this set to its relay, so it
follows you to a second machine. Without the Worker, these sets are local only.
That is the right trade for this repo — no account, no network, and always
writable even in a file you can only view — but it is a real difference. If
cross-device sync is wanted later it is an additive change: the plugin would gain
a sync target, not a new owner of the data.

## Layout

```
index.mjs              the library entry point; importing it starts nothing
index.d.mts            hand-written types for it
manifest.json          the Figma plugin manifest; localhost:3058 only
build.mjs              esbuild → dist/code.js + a self-contained dist/ui.html
shared/                nodes.mjs (findable types), shape.mjs (what a body means)
agent/
  index.mjs            the daemon: WS server, HTTP server, the Edits gate
  mcp-stdio.mjs        the MCP server; a stateless proxy to the daemon
  lib/tools.mjs        the 39 tools — one command each, no logic in between
  lib/plugin-socket.mjs  the panel socket: origin check, token, request/response
  lib/http.mjs         /health, /tools, /tool
  lib/gate.mjs         the Edits switch
  lib/paths.mjs        the port, the host and the token file, defined once
src/
  code.ts              the main thread: 51 commands, extraction and codegen
  figma-css.ts         Figma's own CSS, rendered
  daemon.ts            the one address the plugin dials
  ui/                  the panel: bridge.ts, main.ts, index.html, style.css
test/                  run.mjs and five suites; see Tests below
.github/workflows/     CI on Node 20, 22 and 24; publish on a version tag
```

## Using it as a library

Most people want the two commands. If you are building your own bridge, the
package exports the catalogue and the pieces the daemon is assembled from:

```js
import { toolManifest, createGate, createPluginSocket, createHttpHandler } from 'figsnap-mcp'

console.log(toolManifest().length)  // 39
```

Importing it starts no server and opens no socket — `agent/mcp-stdio.mjs`
connects an MCP server to stdio the moment it loads, so it is deliberately not
re-exported, and the constants that used to live on it are in
`agent/lib/paths.mjs`. `index.d.mts` is hand-written and the test suite checks it
against the runtime in both directions.

Semver applies from 1.0.0. While this is 0.x, the factories are the part most
likely to move; the catalogue and the constants are the stable half.

## Security

The daemon binds `127.0.0.1` only, and two things guard the socket, because a
local port is reachable by any page you happen to visit:

- **Origin**, checked on upgrade. A plugin iframe is a sandboxed document and
  sends `null`; the editor sends figma.com. Anything else is closed with 4001.
  A browser cannot forge this header, and CORS does not apply to an upgrade, so
  it is the check that matters.
- **A token** in the query string, because a browser WebSocket cannot set
  headers. It is the same one HTTP callers send as `x-figsnap-token`, and only
  `/health` is reachable without it — so the panel can probe before it is paired.

`--new-token` rotates it if one ever leaks.

## Tests

```bash
npm test          # four suites: no wrangler, no network, no Figma
npm run typecheck
```

- `e2e-plugin.mjs` runs the shipped `dist/code.js` against a fake `figma`, wired
  to a real daemon, and drives it through `POST /tool` — extraction fidelity,
  `figma_find_nodes`, the saved set including a reload, and a write with the gate
  both shut and open.
- `e2e-mcp.mjs` spawns the daemon, fakes the panel as a WebSocket client, and
  drives a real MCP client over stdio: the guards, the tool list, the batch and
  image rules, all ten saved-set commands, the resources, and the three ways a
  call can fail before it reaches Figma.
- `e2e-panel.mjs` loads the shipped `dist/ui.html` into jsdom with the main
  thread and the daemon replaced, and drives the designer's side: the panes
  render what they are sent, the clicks mean what they say, and a destructive
  folder action arms before it fires.
- `contract.mjs` is the drift guard. `shared/`, `agent/lib/tools.mjs` and
  `src/code.ts` exist in both this repo and Figsnap, and the protocol between
  them has no shared type. So it asserts what a one-sided edit would break: every
  command a tool can name is a case in `src/code.ts` and every case is reachable
  from a tool, `MAX_BATCH` agrees, the caps the panel prints are the caps the
  plugin enforces, the `find_nodes` schema offers exactly `FINDABLE_TYPES`, all
  three files agree on 3058, and nothing has quietly imported the relay, the
  accounts or the ACP client back in.

## Publishing the plugin to your organisation

The plugin can stay a development install — import the manifest, done — but
publishing it to your Figma **organisation** puts it in everyone's plugin list
and updates them automatically, without it appearing in Community.

That option needs a Figma **Organization or Enterprise** plan. On Professional
the only published option is Community, which is public; a development install
is the private route there.

1. Build first: `npm run build`. Figma publishes what `dist/` holds, not what
   `src/` says.
2. Figma desktop → **Plugins → Development → Figsnap MCP → Publish**.
3. Choose **Only <your organisation>** rather than Community.
4. Fill in the listing: a 128×128 icon, a description, and a cover image. An
   org-only publish skips Community review, so it is live once you submit.

**Figma writes a plugin id into `manifest.json` on that first publish**,
replacing `REPLACE_ON_PUBLISH_FIGSNAP_MCP`. Commit that change — it is what
identifies later versions as updates rather than a new plugin, and it is also
what keeps this plugin's `clientStorage` separate from Figsnap's. To release an
update, build again and publish again from the same menu.

One thing worth being clear about: this repository and the npm package are
public, and both carry the built plugin. Org-only publishing controls *listing
and distribution inside Figma*, not who can obtain the code — it is MIT either
way.

## Releasing

CI runs the suites on Node 20, 22 and 24 for every push.

**The first release is manual**, because npm configures a trusted publisher on a
package's own settings page and there is no page until the package exists:

```bash
npm login
npm publish --access public
```

**Then turn on trusted publishing**, once, at
`npmjs.com/package/figsnap-mcp/access` → Trusted Publisher → GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `arimunandar` |
| Repository | `figsnap-mcp` |
| Workflow filename | `publish.yml` |
| Environment name | leave empty |

**Every release after that is a tag:**

```bash
npm version patch          # writes package.json and the v0.1.1 tag
git push --follow-tags
```

`.github/workflows/publish.yml` picks the tag up, refuses it if it disagrees with
`package.json`, and publishes with provenance over OIDC — no token exists to
leak, which matters because npm is restricting tokens that bypass 2FA (account
changes August 2026, direct publishing January 2027).

`prepublishOnly` typechecks, builds and runs every suite first, so a release that
would not have worked cannot reach the registry. `npm pack --dry-run` shows
exactly what would be sent; `test/e2e-package.mjs` asserts those contents.

## Licence

MIT.
