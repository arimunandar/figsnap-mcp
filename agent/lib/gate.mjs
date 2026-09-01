// The edits switch.
//
// One gate, in the daemon, rather than one per client: `runTool` refuses every
// mutating tool until this says otherwise, so a harness running without
// permission prompts still cannot reach the canvas unannounced. The switch is
// the designer's — the plugin's Tools pane holds it — or the terminal's, with
// `--allow-edits`.
//
// In Figsnap this was three members of a 631-line ACP runner. Here it is the
// whole thing, because nothing else about that object was ever on the MCP path.

export function createGate({ allowEdits = false, announce } = {}) {
  let writes = allowEdits === true
  return {
    writesAllowed: () => writes,
    /** Told to the panel as well as remembered, so the two cannot disagree. */
    setWrites(on) {
      writes = on === true
      announce?.()
    },
    state: () => ({ writes }),
  }
}
