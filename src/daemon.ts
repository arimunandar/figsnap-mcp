// The daemon this build talks to.
//
// Both sandboxes need the address — the main thread for a fresh install's
// default, the UI to dial it — so it lives here rather than being written out
// twice. There is only one address to know: this repo has no relay and no
// hosted anything, so nothing here is a choice the designer has to make.
//
// 3058 rather than Figsnap's 3056 so both daemons, and both plugins, can be
// running at once. A fixed port rather than a range because `ws://localhost:*`
// is undocumented and user reports say it does not work, so the manifest has to
// name one.

export const AGENT_URL = 'ws://localhost:3058/panel'
