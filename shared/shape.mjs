// Shared between the local relay and the Cloudflare relay so the HTTP contract
// cannot drift between them.

/**
 * Turns the raw image into whichever reference was asked for. `png` publishes a
 * URL that re-renders on request, which is why responses stay small and why the
 * relay keeps no copy. `pngData` inlines the same bytes as a data URI, for when
 * the answer has to stand on its own — it costs about a third more than the
 * file, in the body, every time.
 */
export function shapeExtraction(data, origin, scale) {
  const { png, ...rest } = data
  if (typeof png !== 'string') return rest

  // An older plugin build sends no `outputs`; it always meant the URL.
  const outputs = Array.isArray(rest.outputs) ? rest.outputs : ['png']
  const shaped = { ...rest }

  if (outputs.indexOf('png') !== -1) {
    shaped.png = {
      url: `${origin}/assets/${encodeURIComponent(rest.id)}@${scale}x.png`,
      bytes: base64Bytes(png),
      note: 'Rendered on request; the relay stores no image.',
    }
  }
  if (outputs.indexOf('pngData') !== -1) {
    shaped.pngData = {
      dataUri: `data:image/png;base64,${png}`,
      bytes: base64Bytes(png),
      scale,
      note: 'The image itself, inline. Nothing to fetch, and nothing stored.',
    }
  }
  return shaped
}

export function base64Bytes(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

export function requestedScale(body) {
  const scale = Number(body?.scale)
  return Number.isFinite(scale) && scale >= 1 && scale <= 4 ? scale : 2
}

/**
 * The depth a tree request asked for, as the plugin wants it. Absent means one
 * level, which is what /tree and /children have always returned.
 */
export function requestedDepth(searchParams) {
  const depth = searchParams?.get('depth')
  return depth === null || depth === undefined || depth === '' ? {} : { depth }
}

/** Which command a POST /saved body asks for. */
export function savedAddCommand(body) {
  return Array.isArray(body?.nodeIds) && body.nodeIds.length > 0 ? 'save_nodes' : 'save_selection'
}

/**
 * Which command a DELETE /saved body asks for. Naming a folder without any ids
 * empties that folder; `all` empties everything.
 */
export function savedDeleteCommand(body) {
  if (body?.all === true) return 'clear_saved'
  if (Array.isArray(body?.nodeIds) && body.nodeIds.length > 0) return 'unsave'
  if (typeof body?.folder === 'string') return 'clear_saved'
  return 'unsave'
}

/** Which command a POST /folders body asks for: rename names both ends. */
export function folderWriteCommand(body) {
  return typeof body?.from === 'string' && body.from !== '' ? 'rename_folder' : 'create_folder'
}

/** Which command a POST /extract body asks for, or null for a single node. */
export function batchCommand(body) {
  if (Array.isArray(body?.urls) || (typeof body?.urls === 'string' && body.urls.trim() !== '')) {
    return 'extract_urls'
  }
  if (Array.isArray(body?.nodeIds) && body.nodeIds.length > 0) return 'extract_nodes'
  if (body?.selection === true || body?.selection === 'all') return 'extract_selection'
  if (body?.saved === true) return 'extract_saved'
  return null
}
