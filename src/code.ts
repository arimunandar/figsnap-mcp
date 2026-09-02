// Main thread: full access to the figma API, no DOM and no network.
import { renderFigmaCss } from './figma-css'
import { AGENT_URL } from './daemon'
import { FINDABLE_TYPES } from '../shared/nodes.mjs'

const MAX_LAYERS = 500
const MAX_BATCH = 20
const MAX_SAVED = 100
const MAX_FOLDERS = 30
const MAX_FOLDER_NAME = 40
const MAX_TREE_ROWS = 300
// A deep walk is bounded by total nodes, not by level: one page can hold far more
// than a caller wants back in a single response, and an unbounded walk of a real
// design file is measured in tens of thousands of vectors.
const MAX_TREE_NODES = 2000
// The panel opens with the tree already walked this deep, so the common case —
// find a frame inside a group — needs no clicking. Deeper than this a page is
// mostly vectors, and anything still collapsed expands on demand as before.
const AUTO_TREE_DEPTH = 3
const DEBOUNCE_MS = 250

type TreeRow = {
  id: string
  name: string
  type: string
  width: number
  height: number
  childCount: number
  /** Present only when the walk went deeper than this row. */
  children?: TreeRow[]
}

// Which outputs a caller wants back. The names match the response keys, so there
// is nothing to translate between asking and reading.
type OutputName = 'png' | 'pngData' | 'html' | 'tsx' | 'moduleCss' | 'css' | 'figmaCss'

// pngData is left out of the default on purpose: it is the same image as `png`
// but base64 in the body, which is ~40 KB of an agent's context per node. Ask
// for it when the answer has to stand alone; take the URL otherwise.
const ALL_OUTPUTS: OutputName[] = ['png', 'html', 'tsx', 'moduleCss', 'css', 'figmaCss']
const EVERY_OUTPUT: OutputName[] = ['png', 'pngData', 'html', 'tsx', 'moduleCss', 'css', 'figmaCss']

type Extraction = {
  type: 'extract'
  id: string
  name: string
  nodeType: string
  width: number
  height: number
  layerCount: number
  truncated: boolean
  outputs: OutputName[]
  png?: Uint8Array
  html?: string
  css?: string
  tsx?: string
  moduleCss?: string
  figmaCss?: string
}

type ToUI =
  | Extraction
  | { type: 'tree'; page: string; file?: string; rows: TreeRow[]; truncated: boolean }
  | { type: 'children'; parentId: string; rows: TreeRow[]; truncated: boolean }
  | { type: 'selected'; id: string | null; ids: string[]; rows: TreeRow[] }
  | { type: 'busy' }
  | { type: 'error'; message: string }
  | { type: 'res'; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'batch-progress'; index: number; total: number; ref: string; nodeId: string | null; ok: boolean; name?: string; nodeType?: string; layerCount?: number; error?: string }
  | { type: 'batch-done'; total: number; okCount: number }
  | { type: 'saved'; folders: FolderCount[]; entries: SavedEntry[] }
  | { type: 'save-result'; added: number; already: number; moved: number; full: number; folder: string }
  | { type: 'thumb'; id: string | null; png: Uint8Array | null }
  | { type: 'sync'; fileId: string; folders: string[]; entries: SavedEntry[]; updatedAt: number }
  | { type: 'settings'; url: string; token: string; email: string; profiles: Profile[] }
  | { type: 'agent-settings'; url: string; token: string; cwd: string; harness: string; sessionId: string; writes: boolean; auto: boolean }

type FromUI =
  | { type: 'ready' }
  | { type: 'expand'; id: string }
  | { type: 'pick'; id: string; additive?: boolean }
  | { type: 'capture' }
  | { type: 'scale'; value: number }
  | { type: 'scope'; selectionOnly: boolean }
  | { type: 'instances'; inline: boolean }
  | { type: 'cancel' }
  | { type: 'req'; id: string; command: string; params: Record<string, unknown> }
  | { type: 'batch'; source: 'urls' | 'selection' | 'saved'; text?: string; folder?: string }
  | { type: 'save-selection'; folder?: string }
  | { type: 'unsave'; ids: string[] }
  | { type: 'clear-saved'; folder?: string }
  | { type: 'create-folder'; name: string }
  | { type: 'rename-folder'; from: string; to: string }
  | { type: 'delete-folder'; name: string; deleteEntries?: boolean }
  | { type: 'move-saved'; ids: string[]; folder: string }
  | { type: 'sync-apply'; folders: string[]; entries: SavedEntry[]; updatedAt: number }
  | { type: 'refresh-saved' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'minimise'; on: boolean }
  | { type: 'save-settings'; url: string; token: string; email?: string }
  | { type: 'save-agent-settings'; url: string; token: string; cwd: string; harness: string; sessionId: string; writes: boolean; auto: boolean }
  | { type: 'sign-out' }
  | { type: 'open-url'; url: string }
  | { type: 'forget-relay'; url: string }

type ExtractOptions = {
  scale: number
  selectionOnly: boolean
  inlineInstances: boolean
  outputs: OutputName[]
}

/** Defaults, driven by the plugin's own panel; remote callers override per request. */
const defaults: ExtractOptions = { scale: 2, selectionOnly: false, inlineInstances: false, outputs: ALL_OUTPUTS }
let captureTimer: number | undefined
// While minimised the window size is not the user's choice, so it is not stored.
let minimised = false

// Three panes and a list, not Figsnap's tree-plus-preview-plus-code, so the
// window that suits it is a good deal smaller. It is only the opening size:
// whatever the designer drags it to is remembered per file from then on.
const DEFAULT_SIZE = { width: 760, height: 640 }
// Minimised is a strip of header, not a small window: it deliberately sits below
// MIN_SIZE so the canvas is clear while the plugin keeps running.
// Minimised, the window is a strip of header plus a preview that fits whatever
// is selected — a fixed height letterboxes a tall frame and wastes canvas on a
// wide one. Only the height moves; a width that jumped about would be worse.
const MINI_WIDTH = 400
const MINI_STRIP = 44
const MINI_PREVIEW_PADDING = 12
// The preview never goes below square. A wide, short component scaled to the
// panel width is only a few dozen pixels tall, which is a sliver you cannot read
// — so the box keeps its width as a floor and centres the image in it.
const MINI_PREVIEW_WIDTH = MINI_WIDTH - 16
const MINI_PREVIEW_MIN = MINI_PREVIEW_WIDTH
const MINI_PREVIEW_MAX = 520

// The open panel's preview box, at twice the size it is shown in so it stays
// sharp on a retina screen. Bounded rather than proportional: the point of a
// preview is to be cheap, and a 4000px frame exported whole on every click is
// not. `contain` in the panel's CSS does the letterboxing.
const PANEL_PREVIEW_BOX = { width: 880, height: 880 }

// How far a small layer may be magnified to be worth looking at. A preview that
// filled the stage whatever it was shown would tell you an icon and a screen are
// the same size, which is the one thing a preview should never say.
const MAX_PREVIEW_SCALE = 4

/** The preview's own height for a node, before the strip is added. */
function miniPreviewHeight(node: SceneNode): number {
  if (node.width <= 0 || node.height <= 0) return MINI_PREVIEW_MIN
  const scaled = Math.round(MINI_PREVIEW_WIDTH * (node.height / node.width))
  return Math.min(MINI_PREVIEW_MAX, Math.max(MINI_PREVIEW_MIN, scaled))
}

function resizeMini(previewHeight: number): void {
  figma.ui.resize(MINI_WIDTH, MINI_STRIP + (previewHeight > 0 ? previewHeight + MINI_PREVIEW_PADDING : 0))
}
// The floor a stored size is clamped up to. Below this the Saved pane's folder
// rail and its list stop being two columns and the Connect pane is all scroll,
// which is a worse panel than a slightly larger one.
const MIN_SIZE = { width: 460, height: 420 }
const MAX_SIZE = { width: 1800, height: 1200 }
const SIZE_KEY = `figsnap-mcp:size:${figma.root.id}`

figma.showUI(__html__, { ...DEFAULT_SIZE, themeColors: true })

/** Restores whatever size the user last dragged the window to, per file. */
async function restoreSize(): Promise<void> {
  let size = DEFAULT_SIZE
  try {
    const stored = await figma.clientStorage.getAsync(SIZE_KEY)
    if (stored && typeof stored === 'object') {
      const { width, height } = stored as { width?: number; height?: number }
      if (typeof width === 'number' && typeof height === 'number') size = { width, height }
    }
  } catch {
    // A missing or malformed entry just means the default size.
  }
  // Always resizes, not only when something was stored: this is also the way
  // back from minimised, where the window is 40px tall and nothing is showing.
  figma.ui.resize(
    Math.min(MAX_SIZE.width, Math.max(MIN_SIZE.width, Math.round(size.width))),
    Math.min(MAX_SIZE.height, Math.max(MIN_SIZE.height, Math.round(size.height))),
  )
}

async function rememberSize(width: number, height: number): Promise<void> {
  if (minimised) return
  try {
    await figma.clientStorage.setAsync(SIZE_KEY, { width: Math.round(width), height: Math.round(height) })
  } catch {
    // Losing a window size is not worth surfacing to the user.
  }
}

function send(message: ToUI) {
  figma.ui.postMessage(message)
}

/** Panel messages have no reply channel, so a refusal surfaces as a status line. */
function reportFailure(error: unknown): void {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
}

// ---------------------------------------------------------------- naming

/** Layer names repeat constantly, so every generated name is deduped globally. */
function uniqueKebab(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'layer'
  let candidate = base
  let suffix = 2
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix++
  }
  taken.add(candidate)
  return candidate
}

function toCamel(kebab: string): string {
  const camel = kebab.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())
  return /^[0-9]/.test(camel) ? `_${camel}` : camel
}

function toPascal(name: string): string {
  const pascal = name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
  if (!pascal) return 'Component'
  return /^[0-9]/.test(pascal) ? `Component${pascal}` : pascal
}

/** Figma suffixes non-variant property names with "#id"; code does not want that. */
function propName(figmaName: string): string {
  const bare = figmaName.split('#')[0]
  const camel = toCamel(
    bare
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
  )
  return camel || 'prop'
}

// ---------------------------------------------------------------- model

type PropValue = { name: string; kind: 'boolean' | 'string' | 'node'; value: string | boolean }

type PropDefinition = {
  name: string
  tsType: string
  defaultValue: string | boolean | undefined
}

type Layer = {
  name: string
  nodeType: string
  kebab: string
  camel: string
  width: number
  height: number
  css: [string, string][]
  characters?: string
  /** Inline SVG for a layer that is nothing but vectors. */
  svg?: string
  /** A data URI for a layer whose paint is an image Figma will not hand over. */
  image?: string
  isAsset: boolean
  instanceOf?: string
  instanceProps: PropValue[]
  children: Layer[]
}

type BuildState = {
  taken: Set<string>
  imageBytes: number
  /** Layers the React and CSS outputs describe; what `layerCount` reports. */
  count: number
  /** Every layer visited, including inside instances, for the work cap. */
  walked: number
  truncated: boolean
  svgCount: number
  svgBytes: number
  options: ExtractOptions
}

// ------------------------------------------------------------------ vectors
//
// Dev Mode CSS describes a vector with `fill` and `stroke-width`, which are SVG
// properties: on the <div> the generated markup produces they do nothing, so an
// icon comes out as an empty box. The fix is to stop pretending it is a box —
// export the whole icon as one SVG and inline it.

const VECTOR_TYPES = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE']
// A per-node cap has to be generous, because failing it is worse than passing
// it: the walk then descends and inlines every vector inside separately, which
// costs the same bytes, produces fifty elements instead of one, and loses any
// paint that lived on the wrapper — a flag's red disc, say. What actually needs
// bounding is the total, so a page of illustrations cannot run away.
const MAX_SVG_LAYERS = 80
const MAX_SVG_BYTES = 90_000
const MAX_SVG_TOTAL = 600_000

// An image fill points at a file inside Figma. Rendering that layer and inlining
// the result is the only way a copied page can show it, and the only way it can
// stay one file. Bounded, because base64 costs a third more than the bytes and
// a page of photographs would otherwise be measured in megabytes.
const MAX_IMAGE_BYTES = 400_000
const MAX_IMAGE_TOTAL = 2_000_000

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * The plugin sandbox has no btoa and no Buffer, so base64 is done by hand. Only
 * the HTML output needs it — everywhere else images travel as raw bytes and are
 * encoded by whoever is sending them.
 */
function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const b = bytes[index + 1]
    const c = bytes[index + 2]
    out += BASE64_ALPHABET[a >> 2]
    out += BASE64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : BASE64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : BASE64_ALPHABET[c & 63]
  }
  return out
}

/**
 * The layer rendered as a PNG, inline. Rendering bakes in whatever is drawn on
 * top, so a layer with children is left to the placeholder — the children are
 * about to be rendered as elements and would appear twice.
 */
async function exportImage(node: SceneNode, state: BuildState): Promise<string | null> {
  if ('children' in node && node.children.some((child) => child.visible)) return null
  try {
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 2 },
    })
    if (bytes.length > MAX_IMAGE_BYTES) return null
    if (state.imageBytes + bytes.length > MAX_IMAGE_TOTAL) return null
    state.imageBytes += bytes.length
    return `data:image/png;base64,${toBase64(bytes)}`
  } catch {
    return null
  }
}

async function exportSvg(node: SceneNode, state: BuildState): Promise<string | null> {
  try {
    const svg = await node.exportAsync({ format: 'SVG_STRING' })
    if (svg.length > MAX_SVG_BYTES) return null
    if (state.svgBytes + svg.length > MAX_SVG_TOTAL) return null
    state.svgBytes += svg.length
    return svg
  } catch {
    return null
  }
}

function isVectorOnly(node: SceneNode): boolean {
  if (VECTOR_TYPES.indexOf(node.type) !== -1) return true
  if (!('children' in node) || node.children.length === 0) return false
  return node.children.every((child) => !child.visible || isVectorOnly(child))
}

async function mainComponentName(node: InstanceNode): Promise<string> {
  try {
    const main = await node.getMainComponentAsync()
    if (!main) return node.name
    // A variant's own name is "Size=Large"; the set name is the useful one.
    const parent = main.parent
    if (parent && parent.type === 'COMPONENT_SET') return parent.name
    return main.name
  } catch {
    return node.name
  }
}

function readInstanceProps(node: InstanceNode): PropValue[] {
  const props: PropValue[] = []
  try {
    for (const [key, property] of Object.entries(node.componentProperties)) {
      if (property.type === 'INSTANCE_SWAP') {
        props.push({ name: propName(key), kind: 'node', value: String(property.value) })
      } else if (typeof property.value === 'boolean') {
        props.push({ name: propName(key), kind: 'boolean', value: property.value })
      } else {
        props.push({ name: propName(key), kind: 'string', value: String(property.value) })
      }
    }
  } catch {
    // Instances from unavailable libraries can throw; props are optional.
  }
  return props
}

/**
 * `insideComponent` marks a layer that only the HTML output will use: the React
 * and CSS outputs stop at an instance boundary, so these layers are walked but
 * not counted, and `layerCount` means the same thing either way.
 */
async function buildLayer(
  node: SceneNode,
  state: BuildState,
  isRoot: boolean,
  insideComponent = false,
): Promise<Layer | null> {
  if (state.walked >= MAX_LAYERS) {
    state.truncated = true
    return null
  }
  if (!node.visible) return null
  state.walked++
  if (!insideComponent) state.count++

  const kebab = uniqueKebab(node.name, state.taken)
  let css: [string, string][] = []
  try {
    css = Object.entries(await node.getCSSAsync())
  } catch {
    // Some node types report no CSS; an empty rule is better than aborting.
  }

  const layer: Layer = {
    name: node.name,
    nodeType: node.type,
    width: node.width,
    height: node.height,
    kebab,
    camel: toCamel(kebab),
    css,
    isAsset: 'isAsset' in node ? node.isAsset : false,
    instanceProps: [],
    children: [],
  }

  if (node.type === 'TEXT') {
    layer.characters = node.characters
  }

  // Only the page needs this: the other outputs are meant to be edited, and a
  // 200 kB data URI in a stylesheet is not something anyone wants to edit.
  if (state.options.outputs.indexOf('html') !== -1 && css.some(([, value]) => isImageFill(value))) {
    layer.image = (await exportImage(node, state)) ?? undefined
  }

  const treatAsComponent = node.type === 'INSTANCE' && !state.options.inlineInstances && !isRoot
  if (treatAsComponent) {
    layer.instanceOf = toPascal(await mainComponentName(node))
    layer.instanceProps = readInstanceProps(node)
    // React can write `<Title />` because the component exists somewhere. HTML
    // cannot: an instance left empty is a div with no content, which collapses
    // to nothing. So the contents are walked for the page's sake, and every
    // other renderer stops here.
    if (!state.options.outputs.includes('html')) return layer
    insideComponent = true
  }

  // An icon collapses into one inline SVG rather than a stack of empty divs, and
  // the walk stops there: the paths inside are the SVG's business, not the DOM's.
  // Only when the export works — a failure leaves the old shape rather than a hole.
  if (!isRoot && state.svgCount < MAX_SVG_LAYERS && isVectorOnly(node)) {
    const svg = await exportSvg(node, state)
    if (svg !== null) {
      state.svgCount++
      layer.svg = svg
      return layer
    }
  }

  const descend = !(isRoot && state.options.selectionOnly)
  if (descend && 'children' in node) {
    for (const child of node.children) {
      const built = await buildLayer(child, state, false, insideComponent)
      if (built) layer.children.push(built)
    }
  }

  return layer
}

/** Variant unions and defaults live on the component set, not the instance. */
async function rootPropDefinitions(node: SceneNode): Promise<PropDefinition[]> {
  const definitions: PropDefinition[] = []

  const fromDefinitions = (source: ComponentPropertyDefinitions) => {
    for (const [key, definition] of Object.entries(source)) {
      let tsType = 'string'
      if (definition.type === 'BOOLEAN') tsType = 'boolean'
      else if (definition.type === 'INSTANCE_SWAP') tsType = 'ReactNode'
      else if (definition.type === 'VARIANT' && definition.variantOptions?.length) {
        tsType = definition.variantOptions.map((option) => JSON.stringify(option)).join(' | ')
      }
      definitions.push({ name: propName(key), tsType, defaultValue: definition.defaultValue })
    }
  }

  try {
    if (node.type === 'COMPONENT_SET') {
      fromDefinitions(node.componentPropertyDefinitions)
      return definitions
    }
    if (node.type === 'COMPONENT') {
      const parent = node.parent
      if (parent && parent.type === 'COMPONENT_SET') fromDefinitions(parent.componentPropertyDefinitions)
      else fromDefinitions(node.componentPropertyDefinitions)
      return definitions
    }
    if (node.type === 'INSTANCE') {
      const main = await node.getMainComponentAsync()
      const parent = main?.parent
      if (parent && parent.type === 'COMPONENT_SET') {
        fromDefinitions(parent.componentPropertyDefinitions)
      } else if (main) {
        fromDefinitions(main.componentPropertyDefinitions)
      }
      if (definitions.length === 0) {
        // Fall back to whatever the instance itself reports.
        for (const prop of readInstanceProps(node)) {
          definitions.push({
            name: prop.name,
            tsType: prop.kind === 'boolean' ? 'boolean' : prop.kind === 'node' ? 'ReactNode' : 'string',
            defaultValue: typeof prop.value === 'boolean' ? prop.value : String(prop.value),
          })
        }
      }
      return definitions
    }
  } catch {
    // Remote or detached components: emit a propless component instead.
  }
  return definitions
}

// ---------------------------------------------------------------- renderers

function renderPlainCss(root: Layer): string {
  const lines: string[] = []
  const walk = (layer: Layer, depth: number) => {
    const indent = '  '.repeat(depth)
    if (layer.css.length > 0) {
      lines.push(`${indent}/* ${layer.name} — ${layer.nodeType} */`)
      lines.push(`${indent}.${layer.kebab} {`)
      for (const [property, value] of layer.css) lines.push(`${indent}  ${property}: ${value};`)
      lines.push(`${indent}}`)
      lines.push('')
    }
    // What is inside an instance is the component's business, not this
    // stylesheet's — the same boundary the React output stops at.
    if (layer.instanceOf) return
    for (const child of layer.children) walk(child, depth + 1)
  }
  walk(root, 0)
  return lines.join('\n').trim()
}

function renderModuleCss(root: Layer): string {
  const lines: string[] = []
  const walk = (layer: Layer) => {
    if (layer.css.length > 0) {
      lines.push(`/* ${layer.name} — ${layer.nodeType} */`)
      lines.push(`.${layer.camel} {`)
      for (const [property, value] of layer.css) lines.push(`  ${property}: ${value};`)
      lines.push('}')
      lines.push('')
    }
    if (layer.instanceOf) return
    for (const child of layer.children) walk(child)
  }
  walk(root)
  return lines.join('\n').trim()
}

// -------------------------------------------------------------------- html
//
// A page you can open, rather than a fragment to wire up. The class names are
// the deduped kebab ones, so nothing collides; the text is the real text; icons
// are inline SVG. Two things the CSS itself never says are added here because
// without them the page is simply wrong: `position: relative` on any layer with
// an absolutely positioned child, and the root's own size.

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char])
}

/**
 * Figma writes `position: absolute` on a child but never `position: relative` on
 * its parent, so an absolutely positioned layer would otherwise be placed
 * against the page instead of against the layer it belongs to.
 */
function needsPositioning(layer: Layer): boolean {
  if (layer.css.some(([property, value]) => property === 'position' && value.indexOf('absolute') !== -1)) {
    return false
  }
  return layer.children.some((child) =>
    child.css.some(([property, value]) => property === 'position' && value.indexOf('absolute') !== -1),
  )
}

// An image fill points at a file inside Figma that nothing outside can fetch, so
// the box would otherwise render as a hole. A flat neutral reads as "a picture
// goes here" without pretending to be the picture.
const IMAGE_PLACEHOLDER = '#dfe3e8'

function isImageFill(value: string): boolean {
  return value.indexOf('url(') !== -1
}

const GENERIC_FAMILIES = ['sans-serif', 'serif', 'monospace', 'cursive', 'system-ui']

/**
 * Figma names one font and stops — `font-family: Inter`. Outside Figma that font
 * is usually not installed, and a list with nothing available falls back to the
 * browser default, which is a serif. A generic tail fixes the fallback; the
 * webfont link below fixes the common case of actually having the right face.
 */
function withFallback(value: string): string {
  return GENERIC_FAMILIES.some((generic) => value.indexOf(generic) !== -1)
    ? value
    : `${value}, sans-serif`
}

/** The families and weights the design actually uses, for one webfont request. */
function fontsUsed(root: Layer): { families: string[]; weights: string[] } {
  const families: string[] = []
  const weights: string[] = []
  const walk = (layer: Layer) => {
    for (const [property, value] of layer.css) {
      if (property === 'font-family') {
        // A token reads `var(--Font, Inter)`; the fallback is the real name.
        const name = value.replace(/var\([^,]*,\s*/, '').replace(/[)'"]/g, '').split(',')[0].trim()
        if (name !== '' && GENERIC_FAMILIES.indexOf(name) === -1 && families.indexOf(name) === -1) {
          families.push(name)
        }
      }
      if (property === 'font-weight' && /^\d{3}$/.test(value) && weights.indexOf(value) === -1) {
        weights.push(value)
      }
    }
    for (const child of layer.children) walk(child)
  }
  walk(root)
  return { families, weights: weights.sort() }
}

function fontLink(root: Layer): string {
  const { families, weights } = fontsUsed(root)
  if (families.length === 0) return ''
  const wanted = weights.length > 0 ? weights : ['400']
  const query = families
    .map((family) => `family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${wanted.join(';')}`)
    .join('&')
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${query}&display=swap" rel="stylesheet">
`
}

/** A number as CSS, without a trailing `.00` on the common whole-pixel case. */
function size(value: number): string {
  return `${Math.round(value * 100) / 100}px`
}

function pixels(value: string): number {
  const found = value.match(/^(-?[\d.]+)px$/)
  return found ? Number(found[1]) : 0
}

/** How much padding a layer declares on each axis, or null if it declares none. */
function paddingOf(layer: Layer): { block: number; inline: number } | null {
  const shorthand = layer.css.find(([name]) => name === 'padding')
  if (shorthand) {
    const parts = shorthand[1].split(/\s+/).map(pixels)
    if (parts.length === 1) return { block: parts[0] * 2, inline: parts[0] * 2 }
    if (parts.length === 2) return { block: parts[0] * 2, inline: parts[1] * 2 }
    if (parts.length === 3) return { block: parts[0] + parts[2], inline: parts[1] * 2 }
    return { block: parts[0] + parts[2], inline: parts[1] + parts[3] }
  }
  const side = (name: string) => {
    const found = layer.css.find(([property]) => property === name)
    return found ? pixels(found[1]) : 0
  }
  const block = side('padding-top') + side('padding-bottom')
  const inline = side('padding-left') + side('padding-right')
  return block === 0 && inline === 0 ? null : { block, inline }
}

/** A negative auto-layout gap, and which margin it has to become. */
function negativeGap(layer: Layer): { axis: 'top' | 'left'; amount: number } | null {
  const gap = layer.css.find(([name]) => name === 'gap')
  if (!gap) return null
  const amount = pixels(gap[1])
  if (amount >= 0) return null
  const column = layer.css.some(([name, value]) => name === 'flex-direction' && value.indexOf('column') !== -1)
  return { axis: column ? 'top' : 'left', amount }
}

function renderHtmlCss(root: Layer, width: number, height: number): string {
  const lines: string[] = []
  const walk = (layer: Layer, isRoot: boolean) => {
    let placeheld = false
    const declarations = layer.css.map(([property, value]) => {
      if (isImageFill(value)) {
        const name = property.indexOf('background') === 0 ? 'background' : property
        // The whole declaration is replaced, not just the url(): what Figma
        // leaves beside it sizes an image that is no longer the same one.
        if (layer.image) return `  ${name}: url(${layer.image}) center / cover no-repeat;`
        placeheld = true
        return `  ${name}: ${IMAGE_PLACEHOLDER};`
      }
      return `  ${property}: ${property === 'font-family' ? withFallback(value) : value};`
    })
    const declares = (property: string) => layer.css.some(([name]) => name === property)
    if (needsPositioning(layer)) declarations.push('  position: relative;')

    // Figma lets padding exceed the frame that holds it, and lets auto-layout
    // spacing go negative. CSS does neither: with border-box the padding wins
    // and the element balloons, and a negative gap is discarded outright. The
    // node's own size is the thing that is true, so the padding gives way.
    const padding = paddingOf(layer)
    if (padding !== null && layer.height > 0 && padding.block >= layer.height) {
      if (!declares('height')) declarations.push(`  height: ${size(layer.height)};`)
      declarations.push('  padding-top: 0;', '  padding-bottom: 0;', '  overflow: hidden;')
    }
    if (padding !== null && layer.width > 0 && padding.inline >= layer.width) {
      if (!declares('width')) declarations.push(`  width: ${size(layer.width)};`)
      declarations.push('  padding-left: 0;', '  padding-right: 0;')
    }

    // A negative gap has to become a negative margin; there is nowhere else for
    // it to live, and simply dropping it moves every sibling.
    const gap = negativeGap(layer)
    if (gap !== null) declarations.push('  gap: 0;')

    // A Figma stroke is drawn inside the node's bounds, but Dev Mode CSS leaves
    // out any size it considers content-derived — so the border lands outside
    // and the layer grows by twice its width. Pinning the size Figma reports is
    // what makes border-box mean what Figma meant.
    if (declares('border') && !isRoot) {
      if (!declares('height')) declarations.push(`  height: ${size(layer.height)};`)
      if (!declares('width')) declarations.push(`  width: ${size(layer.width)};`)
    }

    // Dev Mode CSS leaves the root's own box to its parent, which is not here.
    if (isRoot) {
      if (!declares('width')) declarations.push(`  width: ${width}px;`)
      if (!declares('height')) declarations.push(`  height: ${height}px;`)
    }
    if (declarations.length > 0) {
      lines.push(
        placeheld
          ? `/* ${layer.name} — ${layer.nodeType}, image fill shown as a placeholder */`
          : `/* ${layer.name} — ${layer.nodeType} */`,
      )
      lines.push(`.${layer.kebab} {`)
      lines.push(...declarations)
      lines.push('}')
      lines.push('')
    }
    if (gap !== null) {
      lines.push(`/* ${layer.name} — negative Figma spacing, as a margin */`)
      lines.push(`.${layer.kebab} > * + * {`)
      lines.push(`  margin-${gap.axis}: ${size(gap.amount)};`)
      lines.push('}')
      lines.push('')
    }
    for (const child of layer.children) walk(child, false)
  }
  walk(root, true)
  return lines.join('\n').trim()
}

function renderHtmlElement(layer: Layer, depth: number, lines: string[]): void {
  const pad = '  '.repeat(depth + 3)
  const attribute = `class="${layer.kebab}"`

  if (layer.svg !== undefined) {
    lines.push(`${pad}<span ${attribute} aria-hidden="true">${layer.svg}</span>`)
    return
  }
  if (layer.characters !== undefined) {
    lines.push(`${pad}<span ${attribute}>${escapeHtml(layer.characters)}</span>`)
    return
  }
  if (layer.children.length === 0) {
    lines.push(`${pad}<div ${attribute}></div>`)
    return
  }
  lines.push(`${pad}<div ${attribute}>`)
  for (const child of layer.children) renderHtmlElement(child, depth + 1, lines)
  lines.push(`${pad}</div>`)
}

function renderHtml(root: Layer, width: number, height: number): string {
  const body: string[] = []
  renderHtmlElement(root, -2, body)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(root.name)}</title>
${fontLink(root)}<style>
:root { color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f6f8;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
/* Figma sizes every layer in pixels, so this is one frame at one width. */
${renderHtmlCss(root, width, height)}
</style>
</head>
<body>
${body.join('\n')}
</body>
</html>
`
}

/** Plain text can sit inline; anything with JSX-significant characters cannot. */
function jsxText(text: string): string {
  if (/^[^<>{}\n\r]+$/.test(text) && text.trim() === text) return text
  return `{${JSON.stringify(text)}}`
}

function renderPropAttribute(prop: PropValue): string {
  if (prop.kind === 'boolean') return prop.value === true ? prop.name : `${prop.name}={false}`
  if (prop.kind === 'node') return `/* ${prop.name}: instance swap */`
  return `${prop.name}=${JSON.stringify(String(prop.value))}`
}

function renderElement(layer: Layer, depth: number, lines: string[]): void {
  const pad = '  '.repeat(depth + 3)
  const className = `className={s.${layer.camel}}`

  if (layer.instanceOf) {
    const attributes = [className, ...layer.instanceProps.map(renderPropAttribute)].join(' ')
    lines.push(`${pad}<${layer.instanceOf} ${attributes} />`)
    return
  }

  if (layer.characters !== undefined) {
    lines.push(`${pad}<span ${className}>${jsxText(layer.characters)}</span>`)
    return
  }

  if (layer.svg !== undefined) {
    // SVG markup is not valid JSX — kebab-case attributes, namespaced xlink —
    // so it goes in as markup rather than being rewritten into elements.
    lines.push(
      `${pad}<span ${className} aria-hidden dangerouslySetInnerHTML={{ __html: ${layer.camel}Svg }} />`,
    )
    return
  }

  if (layer.children.length === 0) {
    if (layer.isAsset) lines.push(`${pad}<span ${className} aria-hidden />`)
    else lines.push(`${pad}<div ${className} />`)
    return
  }

  lines.push(`${pad}<div ${className}>`)
  for (const child of layer.children) renderElement(child, depth + 1, lines)
  lines.push(`${pad}</div>`)
}

function renderTsx(root: Layer, definitions: PropDefinition[]): string {
  const componentName = toPascal(root.name)

  const imported = new Set<string>()
  const collect = (layer: Layer) => {
    if (layer.instanceOf && layer.instanceOf !== componentName) imported.add(layer.instanceOf)
    for (const child of layer.children) collect(child)
  }
  collect(root)

  const icons: Layer[] = []
  const collectIcons = (layer: Layer) => {
    if (layer.svg !== undefined) icons.push(layer)
    for (const child of layer.children) collectIcons(child)
  }
  collectIcons(root)

  const lines: string[] = []
  const needsReactNode = definitions.some((definition) => definition.tsType === 'ReactNode')
  if (needsReactNode) lines.push(`import type { ReactNode } from 'react'`)
  lines.push(`import s from './${componentName}.module.css'`)
  for (const name of Array.from(imported).sort()) {
    lines.push(`import { ${name} } from './${name}'`)
  }
  lines.push('')

  // Held above the component so the markup stays readable; move them to their
  // own files if you would rather.
  for (const icon of icons) {
    lines.push(`const ${icon.camel}Svg = ${JSON.stringify(icon.svg)}`)
  }
  if (icons.length > 0) lines.push('')

  const propsType = `${componentName}Props`
  let signature = '()'
  if (definitions.length > 0) {
    lines.push(`type ${propsType} = {`)
    for (const definition of definitions) {
      lines.push(`  ${definition.name}?: ${definition.tsType}`)
    }
    lines.push('}')
    lines.push('')

    const destructured = definitions
      .map((definition) => {
        if (definition.defaultValue === undefined) return definition.name
        const literal =
          typeof definition.defaultValue === 'boolean'
            ? String(definition.defaultValue)
            : JSON.stringify(definition.defaultValue)
        return `${definition.name} = ${literal}`
      })
      .join(', ')
    signature = `({ ${destructured} }: ${propsType})`
  }

  lines.push(`export function ${componentName}${signature} {`)
  lines.push('  return (')
  renderElement(root, -1, lines)
  lines.push('  )')
  lines.push('}')

  if (definitions.length > 0) {
    lines.push('')
    lines.push('// Props are declared but not wired to markup yet: Figma reports which')
    lines.push('// variant is active, not which layers each variant swaps.')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------- tree

function toRow(node: SceneNode): TreeRow {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    width: Math.round(node.width),
    height: Math.round(node.height),
    childCount: 'children' in node ? node.children.length : 0,
  }
}

/**
 * How deep to walk. 1 is the historical behaviour — one level, flat rows — so a
 * caller that says nothing gets exactly what it always got.
 */
function requestedDepth(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1
  if (value === 'all' || value === true) return Infinity
  const depth = Number(value)
  if (!Number.isFinite(depth) || depth < 1) {
    throw new Error("depth must be a positive whole number, or 'all'")
  }
  return Math.floor(depth)
}

type Walk = { rows: TreeRow[]; truncated: boolean; nodeCount: number }

/** Infinity does not survive JSON, so 'all' is what an unlimited walk echoes. */
function depthLabel(depth: number): number | 'all' {
  return Number.isFinite(depth) ? depth : 'all'
}

/**
 * Rows for one level, and their descendants when asked for. `truncated` covers
 * both limits: too many siblings at a level, and too many nodes overall.
 */
function walkTree(nodes: readonly SceneNode[], depth: number): Walk {
  let budget = MAX_TREE_NODES
  let truncated = false

  function level(children: readonly SceneNode[], remaining: number): TreeRow[] {
    const visible = children.filter((node) => node.visible)
    if (visible.length > MAX_TREE_ROWS) truncated = true
    const rows: TreeRow[] = []
    for (const node of visible.slice(0, MAX_TREE_ROWS)) {
      if (budget <= 0) {
        truncated = true
        break
      }
      budget--
      const row = toRow(node)
      // A row with no `children` key but a childCount above zero is the signal
      // to ask again with a deeper walk, or from that node.
      if (remaining > 1 && 'children' in node && node.children.length > 0) {
        row.children = level(node.children as readonly SceneNode[], remaining - 1)
      }
      rows.push(row)
    }
    return rows
  }

  const rows = level(nodes, depth)
  return { rows, truncated, nodeCount: MAX_TREE_NODES - budget }
}

function rowsOf(nodes: readonly SceneNode[]): { rows: TreeRow[]; truncated: boolean } {
  return walkTree(nodes, 1)
}

function treeData(depth = 1) {
  const { rows, truncated, nodeCount } = walkTree(figma.currentPage.children, depth)
  return {
    page: figma.currentPage.name,
    pageId: figma.currentPage.id,
    depth: depthLabel(depth),
    nodeCount,
    rows,
    truncated,
  }
}

async function childrenData(id: string, depth = 1) {
  const node = await figma.getNodeByIdAsync(id)
  if (!node || !('children' in node)) {
    return { parentId: id, depth: depthLabel(depth), nodeCount: 0, rows: [] as TreeRow[], truncated: false }
  }
  const { rows, truncated, nodeCount } = walkTree(node.children as readonly SceneNode[], depth)
  return { parentId: id, depth: depthLabel(depth), nodeCount, rows, truncated }
}

function sendTree(): void {
  const data = treeData(AUTO_TREE_DEPTH)
  // The file's name rides along so a saved conversation can say which design it
  // was about, not only which folder it ran in.
  send({ type: 'tree', page: data.page, file: figma.root.name, rows: data.rows, truncated: data.truncated })
}

async function sendChildren(id: string): Promise<void> {
  const data = await childrenData(id)
  send({ type: 'children', parentId: data.parentId, rows: data.rows, truncated: data.truncated })
}

// ---------------------------------------------------------------- extraction

/**
 * The layer walk always runs: it is what `layerCount` and `truncated` describe,
 * and skipping it would make them a guess. What the outputs save is the work
 * around it — the PNG render, the second walk `figmaCss` does, and above all the
 * size of the answer, which is the part an agent pays for.
 */
async function buildExtraction(node: SceneNode, options: ExtractOptions): Promise<Extraction> {
  const wants = (name: OutputName) => options.outputs.indexOf(name) !== -1

  // The same bytes serve both: `png` publishes them as a URL, `pngData` inlines
  // them. Exporting once covers either.
  const png = wants('png') || wants('pngData')
    ? await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: options.scale },
        useAbsoluteBounds: true,
      })
    : undefined

  const state: BuildState = {
    taken: new Set(),
    imageBytes: 0,
    count: 0,
    walked: 0,
    truncated: false,
    svgCount: 0,
    svgBytes: 0,
    options,
  }
  const root = await buildLayer(node, state, true)
  if (!root) throw new Error('Layer is hidden.')

  const extraction: Extraction = {
    type: 'extract',
    id: node.id,
    name: node.name,
    nodeType: node.type,
    width: Math.round(node.width),
    height: Math.round(node.height),
    layerCount: state.count,
    truncated: state.truncated,
    outputs: options.outputs,
  }

  if (png) extraction.png = png
  if (wants('html')) extraction.html = renderHtml(root, Math.round(node.width), Math.round(node.height))
  if (wants('css')) extraction.css = renderPlainCss(root)
  if (wants('tsx')) extraction.tsx = renderTsx(root, await rootPropDefinitions(node))
  if (wants('moduleCss')) extraction.moduleCss = renderModuleCss(root)
  if (wants('figmaCss')) extraction.figmaCss = await renderFigmaCss(node, options.selectionOnly)
  return extraction
}

async function extractById(id: string, additive = false): Promise<void> {
  const node = await figma.getNodeByIdAsync(id)
  if (!node || node.removed || !('exportAsync' in node)) {
    send({ type: 'error', message: 'That layer is gone. Refresh the tree.' })
    return
  }
  const scene = node as SceneNode

  if (additive) {
    // Cmd-click in the tree toggles membership instead of replacing the selection.
    const current = figma.currentPage.selection
    const without = current.filter((selected) => selected.id !== scene.id)
    figma.currentPage.selection = without.length === current.length ? [...current, scene] : without
    return
  }

  figma.currentPage.selection = [scene]
  figma.viewport.scrollAndZoomIntoView([scene])
  // No extraction here: changing the selection fires selectionchange, which
  // draws the preview. Doing it twice was only ever twice the work.
}

function extractSelection(): void {
  const selection = figma.currentPage.selection
  send({
    type: 'selected',
    id: selection.length > 0 ? selection[0].id : null,
    ids: selection.map((node) => node.id),
    rows: selection.slice(0, MAX_BATCH).map(toRow),
  })
  // One node is a preview; several is a count and a Save button, because a
  // thumbnail of "three things" is not a picture of anything.
  if (selection.length !== 1) {
    send({ type: 'thumb', id: null, png: null })
    // Nothing to preview, so minimised the window is the strip and nothing else.
    if (minimised) resizeMini(0)
    return
  }
  if (minimised) {
    // The window is the preview here, so it is sized to the node first and the
    // export is measured against what the strip can actually show.
    const previewHeight = miniPreviewHeight(selection[0])
    resizeMini(previewHeight)
    void sendThumb(selection[0], { width: MINI_WIDTH * 2, height: previewHeight * 2 })
    return
  }
  void sendThumb(selection[0], PANEL_PREVIEW_BOX)
}

/**
 * A picture of one node, sized for wherever the panel is going to put it.
 *
 * This is the whole of what the panel needs on a selection change. Building the
 * HTML, the TSX and three stylesheets as well — which is what the open panel
 * used to do — is a great deal of work for something nobody reads: the code
 * outputs go out over MCP, on request, not on every click of the canvas.
 */
async function sendThumb(node: SceneNode, box: { width: number; height: number }): Promise<void> {
  try {
    // Scale, not a target width. Constraining to the box means filling it, and
    // an 8x15 glyph asked to fill 880px is a 110x upscale — several megabytes of
    // blur for a layer the size of a full stop. So: shrink whatever overflows,
    // and magnify a small layer only enough to be legible.
    const fit = Math.min(box.width / Math.max(node.width, 1), box.height / Math.max(node.height, 1))
    const png = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: Math.max(0.02, Math.min(MAX_PREVIEW_SCALE, fit)) },
      useAbsoluteBounds: true,
    })
    send({ type: 'thumb', id: node.id, png })
  } catch {
    // A layer that cannot be exported simply shows no thumbnail.
    send({ type: 'thumb', id: node.id, png: null })
  }
}

function scheduleSelectionExtract(): void {
  if (captureTimer !== undefined) clearTimeout(captureTimer)
  captureTimer = setTimeout(extractSelection, DEBOUNCE_MS)
}

figma.on('selectionchange', scheduleSelectionExtract)
figma.on('currentpagechange', () => {
  sendTree()
  scheduleSelectionExtract()
})

// ---------------------------------------------------------------- figma urls

type ParsedUrl = { url: string; fileKey: string; nodeId: string | null }

// Matches every Figma editor URL shape: /file, /design, /proto, /board, /slides.
const FIGMA_URL = /https?:\/\/(?:[\w-]+\.)?figma\.com\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]+)[^\s]*/g

/** Figma writes node ids with dashes in URLs; the API wants colons. */
function normalizeNodeId(raw: string): string {
  return decodeURIComponent(raw).replace(/-/g, ':')
}

function parseUrl(url: string): ParsedUrl | null {
  FIGMA_URL.lastIndex = 0
  const match = FIGMA_URL.exec(url)
  if (!match) return null
  const query = match[0].split('?')[1] ?? ''
  let nodeId: string | null = null
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=')
    if (key === 'node-id' && value) nodeId = normalizeNodeId(value)
  }
  return { url: match[0], fileKey: match[1], nodeId }
}

/** Pulls every Figma link out of pasted text, in order, without duplicates. */
function parseUrls(text: string): ParsedUrl[] {
  const seen = new Set<string>()
  const parsed: ParsedUrl[] = []
  FIGMA_URL.lastIndex = 0
  for (const match of text.match(FIGMA_URL) ?? []) {
    const entry = parseUrl(match)
    if (!entry) continue
    const key = `${entry.fileKey}#${entry.nodeId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    parsed.push(entry)
  }
  return parsed
}

function pageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node
  while (current && current.type !== 'PAGE') current = current.parent
  return current && current.type === 'PAGE' ? current : null
}

/**
 * A plugin can only read the file it runs in, so a URL from another file is a
 * hard error rather than something to fetch.
 */
async function resolveUrl(parsed: ParsedUrl): Promise<SceneNode> {
  const fileKey = figma.fileKey
  if (fileKey && fileKey !== parsed.fileKey) {
    throw new Error(`That link points at file ${parsed.fileKey}; this plugin is running in ${fileKey}. Open that file and run the plugin there.`)
  }
  if (!parsed.nodeId) throw new Error('Link has no node-id. Right-click a layer in Figma and choose Copy link to selection.')

  let node = await figma.getNodeByIdAsync(parsed.nodeId)
  if (!node) {
    // Under dynamic-page only the open page is loaded; the node may be elsewhere.
    await figma.loadAllPagesAsync()
    node = await figma.getNodeByIdAsync(parsed.nodeId)
  }
  if (!node || node.removed) {
    throw new Error(`No node ${parsed.nodeId} in this file${fileKey ? '' : ' (or the link is from another file)'}.`)
  }
  if (!('exportAsync' in node)) throw new Error(`Node ${parsed.nodeId} is a ${node.type}, which cannot be exported.`)

  const page = pageOf(node)
  if (page && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page)
  return node as SceneNode
}

// ---------------------------------------------------------------- saved set

type FolderCount = { name: string; count: number }

// A folder is a plain label on an entry; '' means the entry sits at the root.
// One level only — the Saved pane is a narrow list, and a tree in it would cost
// more to navigate than the grouping saves.
type SavedEntry = {
  id: string
  name: string
  type: string
  addedAt: number
  folder: string
  missing?: boolean
}

// Keyed by document so each file keeps its own set. clientStorage is per user
// and always writable, unlike plugin data on a file the user can only view.
const STORAGE_KEY = `figsnap-mcp:saved:${figma.root.id}`
// Relay settings belong to the machine, not the file, so they are not scoped by
// document id: one relay serves every file this user opens.
const SETTINGS_KEY = 'figsnap-mcp:relay-settings'
let saved: SavedEntry[] = []
// When this set last changed, by this machine's clock. It is what decides which
// side wins when two devices have both edited — see the sync messages below.
let savedUpdatedAt = 0
// Held separately from the entries so an empty folder survives: you can make one
// before there is anything to put in it, and emptying one does not delete it.
let folders: string[] = []

// The email rides along so the panel can name the signed-in account without a
// round trip on open; it is a label, not a credential.
type Profile = { url: string; token: string; email?: string }

const MAX_PROFILES = 5

/**
 * Relays are switched between, not chosen once: a local one for the filesystem
 * routes and a hosted one for remote agents. Each address remembers its own
 * token so swapping is one click rather than a re-paste.
 */
type Settings = { url: string; token: string; email: string; profiles: Profile[] }

async function readSettings(): Promise<Settings> {
  try {
    const stored = await figma.clientStorage.getAsync(SETTINGS_KEY)
    if (stored && typeof stored === 'object') {
      const settings = stored as { url?: unknown; token?: unknown; email?: unknown; profiles?: unknown }
      const url = typeof settings.url === 'string' ? settings.url : ''
      const token = typeof settings.token === 'string' ? settings.token : ''
      const email = typeof settings.email === 'string' ? settings.email : ''
      const profiles = Array.isArray(settings.profiles)
        ? (settings.profiles as Profile[]).filter(
            (entry) => entry && typeof entry.url === 'string' && typeof entry.token === 'string',
          )
        : []
      return { url, token, email, profiles }
    }
  } catch {
    // No stored settings means the defaults.
  }
  return { url: '', token: '', email: '', profiles: [] }
}

async function writeSettings(next: Settings): Promise<void> {
  try {
    await figma.clientStorage.setAsync(SETTINGS_KEY, next)
  } catch (error) {
    send({
      type: 'error',
      message: `Could not save relay settings: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  send({ type: 'settings', ...next })
}

async function sendSettings(): Promise<void> {
  send({ type: 'settings', ...(await readSettings()) })
}

// The agent daemon runs on this machine, so its address, token and working
// directory belong to the machine rather than the file, like the relay's.
//
// The session id is the odd one out: it is per conversation, and it is stored
// because Figma can take the plugin's runtime away mid-answer. Handing it back
// on reopen lets `session/load` replay what was said instead of starting over.
const AGENT_KEY = 'figsnap-mcp:agent-settings'

type AgentSettings = {
  url: string
  token: string
  cwd: string
  harness: string
  sessionId: string
  // The two switches that decide what the agent may do without being asked.
  // Kept here rather than in the daemon, which forgets them when it restarts.
  writes: boolean
  auto: boolean
}

const NO_AGENT: AgentSettings = {
  url: AGENT_URL,
  token: '',
  cwd: '',
  harness: '',
  sessionId: '',
  writes: false,
  auto: true,
}

async function readAgentSettings(): Promise<AgentSettings> {
  try {
    const stored = await figma.clientStorage.getAsync(AGENT_KEY)
    if (stored && typeof stored === 'object') {
      const settings = stored as Record<string, unknown>
      const text = (key: keyof AgentSettings, fallback: string) =>
        typeof settings[key] === 'string' && settings[key] !== '' ? (settings[key] as string) : fallback
      return {
        url: text('url', AGENT_URL),
        token: text('token', ''),
        cwd: text('cwd', ''),
        harness: text('harness', ''),
        sessionId: text('sessionId', ''),
        writes: settings.writes === true,
        // Absent means settings written before this switch existed.
        auto: settings.auto !== false,
      }
    }
  } catch {
    // Nothing stored means a first run, which is the defaults.
  }
  return { ...NO_AGENT }
}

async function sendAgentSettings(): Promise<void> {
  send({ type: 'agent-settings', ...(await readAgentSettings()) })
}

async function saveAgentSettings(next: AgentSettings): Promise<void> {
  try {
    await figma.clientStorage.setAsync(AGENT_KEY, next)
  } catch (error) {
    send({
      type: 'error',
      message: `Could not save agent settings: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

async function saveSettings(url: string, token: string, email: string): Promise<void> {
  const previous = await readSettings()
  const profiles = [{ url, token, email }, ...previous.profiles.filter((entry) => entry.url !== url)].slice(
    0,
    MAX_PROFILES,
  )
  await writeSettings({ url, token, email, profiles })
}

/**
 * Signing out drops the credential and the address keeps its place, so the next
 * sign-in is one form rather than a reconfiguration.
 */
async function signOut(): Promise<void> {
  const previous = await readSettings()
  const profiles = previous.profiles.map((entry) =>
    entry.url === previous.url ? { url: entry.url, token: '', email: '' } : entry,
  )
  await writeSettings({ url: previous.url, token: '', email: '', profiles })
}

async function forgetProfile(url: string): Promise<void> {
  const previous = await readSettings()
  const profiles = previous.profiles.filter((entry) => entry.url !== url)
  await writeSettings({ ...previous, profiles })
}

async function loadSaved(): Promise<void> {
  try {
    const stored = await figma.clientStorage.getAsync(STORAGE_KEY)
    // Older versions stored a bare array. Reading one is the migration: every
    // entry lands at the root, and the next write is in the new shape.
    if (Array.isArray(stored)) {
      saved = (stored as SavedEntry[]).map((entry) => ({ ...entry, folder: '' }))
      folders = []
      savedUpdatedAt = 0
      return
    }
    if (stored && typeof stored === 'object') {
      const store = stored as { folders?: unknown; entries?: unknown; updatedAt?: unknown }
      savedUpdatedAt = typeof store.updatedAt === 'number' ? store.updatedAt : 0
      saved = Array.isArray(store.entries)
        ? (store.entries as SavedEntry[]).map((entry) => ({
            ...entry,
            folder: typeof entry.folder === 'string' ? entry.folder : '',
          }))
        : []
      folders = Array.isArray(store.folders) ? (store.folders as string[]).filter((name) => typeof name === 'string') : []
      return
    }
  } catch {
    // A missing or malformed entry just means an empty set.
  }
  saved = []
  folders = []
  savedUpdatedAt = 0
}

/**
 * The set lives in clientStorage, which is per machine. Asking the panel to sync
 * after every change is what makes it follow an account between machines — the
 * main thread has no network, so the panel does the talking.
 */
function requestSync(): void {
  send({ type: 'sync', fileId: figma.root.id, folders, entries: saved, updatedAt: savedUpdatedAt })
}

async function persistSaved(options: { stamp?: number; sync?: boolean } = {}): Promise<void> {
  savedUpdatedAt = options.stamp ?? Date.now()
  try {
    await figma.clientStorage.setAsync(STORAGE_KEY, { folders, entries: saved, updatedAt: savedUpdatedAt })
  } catch (error) {
    send({ type: 'error', message: `Could not save: ${error instanceof Error ? error.message : String(error)}` })
  }
  // Applying what the relay just sent must not bounce straight back to it.
  if (options.sync !== false) requestSync()
}

// -------------------------------------------------------------- folders

/**
 * Folder names are matched case-insensitively so "Checkout" and "checkout" cannot
 * both exist, and a slash is refused because it would read as a path in an API
 * that has no nesting to offer.
 */
function normaliseFolder(name: unknown): string {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ')
  if (text === '') return ''
  if (text.length > MAX_FOLDER_NAME) throw new Error(`Folder names stop at ${MAX_FOLDER_NAME} characters.`)
  if (text.indexOf('/') !== -1) throw new Error('Folder names cannot contain a slash; folders do not nest.')
  return text
}

/** The stored spelling of an existing folder, or '' for the root. */
function findFolder(name: string): string {
  if (name === '') return ''
  const match = folders.find((entry) => entry.toLowerCase() === name.toLowerCase())
  if (!match) throw new Error(`No folder called ${name}.`)
  return match
}

async function createFolder(name: unknown): Promise<string> {
  const wanted = normaliseFolder(name)
  if (wanted === '') throw new Error('A folder needs a name.')
  const existing = folders.find((entry) => entry.toLowerCase() === wanted.toLowerCase())
  if (existing) return existing
  if (folders.length >= MAX_FOLDERS) throw new Error(`That is the ${MAX_FOLDERS}th folder; remove one first.`)
  folders.push(wanted)
  await persistSaved()
  return wanted
}

async function renameFolder(from: unknown, to: unknown): Promise<string> {
  const current = findFolder(normaliseFolder(from))
  const wanted = normaliseFolder(to)
  if (wanted === '') throw new Error('A folder needs a name.')
  if (current === '') throw new Error('The root is not a folder.')
  const clash = folders.find((entry) => entry.toLowerCase() === wanted.toLowerCase() && entry !== current)
  if (clash) throw new Error(`There is already a folder called ${clash}.`)
  folders = folders.map((entry) => (entry === current ? wanted : entry))
  saved = saved.map((entry) => (entry.folder === current ? { ...entry, folder: wanted } : entry))
  await persistSaved()
  return wanted
}

/** Deleting a folder keeps its entries by default; they move back to the root. */
async function deleteFolder(name: unknown, deleteEntries: boolean): Promise<number> {
  const current = findFolder(normaliseFolder(name))
  if (current === '') throw new Error('The root is not a folder.')
  const affected = saved.filter((entry) => entry.folder === current).length
  folders = folders.filter((entry) => entry !== current)
  saved = deleteEntries
    ? saved.filter((entry) => entry.folder !== current)
    : saved.map((entry) => (entry.folder === current ? { ...entry, folder: '' } : entry))
  await persistSaved()
  return affected
}

async function moveSaved(ids: string[], name: unknown): Promise<number> {
  const target = findFolder(normaliseFolder(name))
  const wanted = new Set(ids)
  let moved = 0
  saved = saved.map((entry) => {
    if (!wanted.has(entry.id) || entry.folder === target) return entry
    moved++
    return { ...entry, folder: target }
  })
  await persistSaved()
  return moved
}

/** Every folder with how much is in it, root included, for a caller listing them. */
function folderCounts(): FolderCount[] {
  const live = (name: string) => saved.filter((entry) => entry.folder === name && entry.missing !== true).length
  return [{ name: '', count: live('') }, ...folders.map((name) => ({ name, count: live(name) }))]
}

/** Layers get deleted or renamed between sessions, so refresh against the file. */
async function refreshSaved(): Promise<SavedEntry[]> {
  const refreshed: SavedEntry[] = []
  for (const entry of saved) {
    const node = await figma.getNodeByIdAsync(entry.id)
    if (node && !node.removed && 'exportAsync' in node) {
      refreshed.push({ ...entry, name: node.name, type: node.type, missing: false })
    } else {
      refreshed.push({ ...entry, missing: true })
    }
  }
  saved = refreshed
  return saved
}

function sendSaved(): void {
  send({ type: 'saved', folders: folderCounts(), entries: saved })
}

type SaveResult = { added: number; already: number; moved: number; full: number }

/**
 * Saving something already saved moves it rather than refusing or duplicating —
 * an id appears at most once in the set. The counts come back so the panel can
 * say which of those happened instead of looking like it did nothing.
 */
async function addSaved(nodes: readonly SceneNode[], folder: unknown = ''): Promise<SaveResult> {
  const target = findFolder(normaliseFolder(folder))
  const existing = new Map(saved.map((entry) => [entry.id, entry]))
  const result: SaveResult = { added: 0, already: 0, moved: 0, full: 0 }

  for (const node of nodes) {
    const already = existing.get(node.id)
    if (already) {
      if (already.folder === target) result.already++
      else {
        already.folder = target
        result.moved++
      }
      continue
    }
    if (saved.length >= MAX_SAVED) {
      result.full++
      continue
    }
    const entry: SavedEntry = { id: node.id, name: node.name, type: node.type, addedAt: Date.now(), folder: target }
    saved.push(entry)
    existing.set(node.id, entry)
    result.added++
  }
  await persistSaved()
  return result
}

async function removeSaved(ids: string[]): Promise<void> {
  const drop = new Set(ids)
  saved = saved.filter((entry) => !drop.has(entry.id))
  await persistSaved()
}

/** `folder` undefined means the whole set; '' means only what sits at the root. */
function savedEntries(folder?: unknown): BatchEntry[] {
  const scoped = folder === undefined ? undefined : findFolder(normaliseFolder(folder))
  const live = saved.filter(
    (entry) => entry.missing !== true && (scoped === undefined || entry.folder === scoped),
  )
  if (live.length === 0) {
    throw new Error(
      scoped === undefined || scoped === ''
        ? 'Nothing saved yet. Select layers and press Save selection.'
        : `Nothing saved in ${scoped}.`,
    )
  }
  return live.map((entry) => ({
    ref: entry.id,
    nodeId: entry.id,
    resolve: () => resolveScene(entry.id),
  }))
}

// ---------------------------------------------------------------- batches

type Outcome =
  | { ref: string; nodeId: string | null; ok: true; extraction: Omit<Extraction, 'type'> }
  | { ref: string; nodeId: string | null; ok: false; error: string }

type BatchEntry = { ref: string; nodeId: string | null; resolve: () => Promise<SceneNode> }

/**
 * Runs a batch one node at a time so a single bad entry cannot sink the rest,
 * and so the panel can show progress while a long batch is still running.
 */
async function extractBatch(
  entries: BatchEntry[],
  options: ExtractOptions,
  onResult?: (outcome: Outcome, index: number, total: number) => void,
): Promise<Outcome[]> {
  const batch = entries.slice(0, MAX_BATCH)
  const outcomes: Outcome[] = []
  for (let index = 0; index < batch.length; index++) {
    const entry = batch[index]
    let outcome: Outcome
    try {
      const node = await entry.resolve()
      const { type: _ignored, ...extraction } = await buildExtraction(node, options)
      outcome = { ref: entry.ref, nodeId: entry.nodeId ?? node.id, ok: true, extraction }
    } catch (error) {
      outcome = {
        ref: entry.ref,
        nodeId: entry.nodeId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    outcomes.push(outcome)
    onResult?.(outcome, index, batch.length)
  }
  return outcomes
}

function urlEntries(text: string): BatchEntry[] {
  const parsed = parseUrls(text)
  if (parsed.length === 0) throw new Error('No Figma links found in that text.')
  return parsed.map((entry) => ({
    ref: entry.url,
    nodeId: entry.nodeId,
    resolve: () => resolveUrl(entry),
  }))
}

function idEntries(ids: unknown): BatchEntry[] {
  const list = Array.isArray(ids) ? ids.map(String).filter((id) => id !== '') : []
  if (list.length === 0) throw new Error('nodeIds must be a non-empty array of node ids.')
  return list.map((id) => ({ ref: id, nodeId: id, resolve: () => resolveScene(id) }))
}

function selectionEntries(): BatchEntry[] {
  const selection = figma.currentPage.selection
  if (selection.length === 0) throw new Error('Nothing is selected on canvas.')
  return selection.map((node) => ({
    ref: node.id,
    nodeId: node.id,
    resolve: async () => node,
  }))
}

// ---------------------------------------------------------------- remote API

async function resolveScene(id: unknown): Promise<SceneNode> {
  if (typeof id === 'string' && id !== '') {
    const node = await figma.getNodeByIdAsync(id)
    if (!node || node.removed || !('exportAsync' in node)) throw new Error(`No exportable node with id ${id}`)
    return node as SceneNode
  }
  const selection = figma.currentPage.selection
  if (selection.length === 0) throw new Error('Pass a nodeId, or select something on canvas')
  return selection[0]
}

/**
 * Which outputs to produce. Absent means all of them, so a caller written before
 * this existed still gets everything. An unknown name is refused rather than
 * ignored: silently returning nothing would look like the node was empty.
 */
function requestedOutputs(value: unknown): OutputName[] {
  if (value === undefined || value === null || value === '' || value === 'all') return ALL_OUTPUTS
  const asked = (Array.isArray(value) ? value : String(value).split(','))
    .map((name) => String(name).trim())
    .filter((name) => name !== '')
  if (asked.length === 0) return ALL_OUTPUTS
  if (asked.indexOf('all') !== -1) return ALL_OUTPUTS

  const unknown = asked.filter((name) => (EVERY_OUTPUT as string[]).indexOf(name) === -1)
  if (unknown.length > 0) {
    throw new Error(`Unknown format ${unknown.join(', ')}. Use one or more of: ${EVERY_OUTPUT.join(', ')}, or all.`)
  }
  // Kept in a fixed order so the response keys do not depend on how it was asked.
  return EVERY_OUTPUT.filter((name) => asked.indexOf(name) !== -1)
}

function optionsFrom(params: Record<string, unknown>): ExtractOptions {
  const scale = Number(params.scale)
  return {
    scale: Number.isFinite(scale) && scale >= 1 && scale <= 4 ? scale : defaults.scale,
    selectionOnly: params.topLayerOnly === true,
    inlineInstances: params.inlineInstances === true,
    outputs: requestedOutputs(params.format ?? params.formats ?? params.outputs),
  }
}

// ------------------------------------------------------------------- writing
//
// The first commands in this plugin that change the file rather than read it.
// Three things hold for every one of them, which is why they share a section:
//
//  · A plugin's actions are not in undo history unless it says so, so each ends
//    with `figma.commitUndo()`. One approved edit is then one Cmd-Z, rather
//    than a run of them collapsing into whatever the user did before.
//  · A node id from an agent is a guess until it has been resolved and its type
//    checked. The error should say which of those two failed.
//  · Nothing here is reachable until the daemon has been told the designer
//    turned editing on; see `mutates` in agent/lib/tools.mjs.

/**
 * What every write ends with.
 *
 * `commitUndo` is what puts the change in undo history at all — a plugin's
 * actions are not there by default — so one approved edit becomes one Cmd-Z.
 * The re-extract is what makes the change visible: the panel's preview and code
 * are a snapshot taken when the selection last changed, and an agent editing
 * the file does not change the selection. Without this the canvas moves on and
 * the panel goes on showing the design as it was, which reads as a broken edit.
 *
 * It is debounced, so a run of five fills costs one re-render rather than five.
 */
function afterMutation(structural = false): void {
  figma.commitUndo()
  if (structural) sendTree()
  scheduleSelectionExtract()
}

/** The colour as a designer would read it back, for confirming an edit landed. */
function toHex(color: RGB): string {
  const part = (value: number) =>
    Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

/** Resolves a node and insists it is the kind of thing the caller assumed. */
async function resolveFor(
  id: unknown,
  ok: (node: SceneNode) => boolean,
  expected: string,
): Promise<SceneNode> {
  const node = await resolveScene(id)
  if (!ok(node)) throw new Error(`${node.name} is a ${node.type}; ${expected}`)
  return node
}

/** The daemon sends 0-1 triples; a hand-written call might not. */
function readColor(value: unknown): RGB {
  const raw = (value ?? {}) as Record<string, unknown>
  const channel = (name: 'r' | 'g' | 'b'): number => {
    const amount = Number(raw[name])
    if (!Number.isFinite(amount) || amount < 0 || amount > 1) {
      throw new Error(`color.${name} must be between 0 and 1, not ${String(raw[name])}`)
    }
    return amount
  }
  return { r: channel('r'), g: channel('g'), b: channel('b') }
}

function readNumber(value: unknown, name: string): number {
  const amount = Number(value)
  if (!Number.isFinite(amount)) throw new Error(`${name} must be a number, not ${String(value)}`)
  return amount
}

/**
 * Every font the node uses, loaded. The setter throws otherwise, and a font
 * this machine does not have cannot be loaded at all — which is worth saying
 * plainly, because the alternative is a layer silently retyped in a substitute.
 */
async function loadFontsOf(node: TextNode): Promise<void> {
  if (node.hasMissingFont) {
    throw new Error(`${node.name} uses a font this machine does not have, so its text cannot be changed`)
  }
  const fonts =
    node.characters.length > 0
      ? node.getRangeAllFontNames(0, node.characters.length)
      : node.fontName === figma.mixed
        ? []
        : [node.fontName]
  for (const font of fonts) await figma.loadFontAsync(font)
}

async function setFill(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveFor(params.nodeId, (candidate) => 'fills' in candidate, 'it has no fills to set')
  const opacity = params.opacity === undefined ? 1 : readNumber(params.opacity, 'opacity')
  const paint: SolidPaint = { type: 'SOLID', color: readColor(params.color), opacity }

  // What is being thrown away is worth naming: one solid replacing a gradient
  // or a photograph is a much bigger edit than the caller probably meant, and
  // it will not be obvious from a thumbnail.
  const before = (node as GeometryMixin).fills
  const replaced =
    before === figma.mixed ? 'mixed' : (before as readonly Paint[]).map((fill) => fill.type).join(', ')

  ;(node as GeometryMixin).fills = [paint]
  afterMutation()

  // Read back rather than echo: an agent that cannot see the canvas has no
  // other way to tell a refused write from a successful one.
  const after = (node as GeometryMixin).fills
  const applied = after !== figma.mixed && (after as readonly Paint[])[0]
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    replaced: replaced === '' ? 'nothing' : replaced,
    fill: applied && applied.type === 'SOLID' ? toHex(applied.color) : null,
  }
}

async function setStroke(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveFor(params.nodeId, (candidate) => 'strokes' in candidate, 'it has no strokes to set')
  const target = node as GeometryMixin & { strokeWeight: number | typeof figma.mixed }

  if (params.remove === true) {
    target.strokes = []
    afterMutation()
    return { id: node.id, name: node.name, strokes: 0 }
  }

  const opacity = params.opacity === undefined ? 1 : readNumber(params.opacity, 'opacity')
  target.strokes = [{ type: 'SOLID', color: readColor(params.color), opacity }]
  if (params.weight !== undefined) {
    const weight = readNumber(params.weight, 'weight')
    if (weight < 0) throw new Error('weight cannot be negative')
    target.strokeWeight = weight
  }
  afterMutation()

  const applied = (target.strokes as readonly Paint[])[0]
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    stroke: applied && applied.type === 'SOLID' ? toHex(applied.color) : null,
    weight: target.strokeWeight === figma.mixed ? 'mixed' : target.strokeWeight,
  }
}

async function setText(params: Record<string, unknown>): Promise<unknown> {
  const node = (await resolveFor(
    params.nodeId,
    (candidate) => candidate.type === 'TEXT',
    'only a TEXT layer has characters to set',
  )) as TextNode
  const text = String(params.text ?? '')
  await loadFontsOf(node)
  node.characters = text
  afterMutation()
  return { id: node.id, name: node.name, characters: text.length }
}

const AUTO_LAYOUT_NUMBERS = [
  'itemSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
] as const

async function setAutoLayout(params: Record<string, unknown>): Promise<unknown> {
  const node = (await resolveFor(
    params.nodeId,
    (candidate) => 'layoutMode' in candidate,
    'only a frame, component or instance can be laid out',
  )) as FrameNode
  const mode = String(params.mode ?? '')
  if (['HORIZONTAL', 'VERTICAL', 'NONE'].indexOf(mode) === -1) {
    throw new Error(`mode must be HORIZONTAL, VERTICAL or NONE, not ${mode}`)
  }
  node.layoutMode = mode as FrameNode['layoutMode']

  // Only what was named is changed: an agent adjusting spacing should not also
  // silently reset the padding somebody set by hand.
  if (mode !== 'NONE') {
    for (const key of AUTO_LAYOUT_NUMBERS) {
      if (params[key] !== undefined) node[key] = readNumber(params[key], key)
    }
    if (params.primaryAxisAlignItems !== undefined) {
      node.primaryAxisAlignItems = params.primaryAxisAlignItems as FrameNode['primaryAxisAlignItems']
    }
    if (params.counterAxisAlignItems !== undefined) {
      node.counterAxisAlignItems = params.counterAxisAlignItems as FrameNode['counterAxisAlignItems']
    }
  }
  afterMutation()
  return {
    id: node.id,
    name: node.name,
    layoutMode: node.layoutMode,
    itemSpacing: node.itemSpacing,
    padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
  }
}

async function createFrame(params: Record<string, unknown>): Promise<unknown> {
  const parent =
    params.parentId === undefined || params.parentId === ''
      ? figma.currentPage
      : await resolveFor(params.parentId, (candidate) => 'appendChild' in candidate, 'it cannot hold children')

  const frame = figma.createFrame()
  frame.name = typeof params.name === 'string' && params.name !== '' ? params.name : 'Frame'
  frame.x = params.x === undefined ? 0 : readNumber(params.x, 'x')
  frame.y = params.y === undefined ? 0 : readNumber(params.y, 'y')
  frame.resize(
    params.width === undefined ? 100 : Math.max(1, readNumber(params.width, 'width')),
    params.height === undefined ? 100 : Math.max(1, readNumber(params.height, 'height')),
  )
  if (params.fill !== undefined) {
    frame.fills = [{ type: 'SOLID', color: readColor(params.fill) }]
  }
  ;(parent as ChildrenMixin).appendChild(frame)
  // A new layer changes the tree the panel is showing, not only the picture.
  afterMutation(true)
  return { ...toRow(frame), parentId: parent.id }
}

async function saveVersion(params: Record<string, unknown>): Promise<unknown> {
  const title = String(params.title ?? '').trim()
  if (title === '') throw new Error('Give the checkpoint a title')
  const description = typeof params.description === 'string' ? params.description : undefined
  const result = await figma.saveVersionHistoryAsync(title, description)
  return { id: result?.id ?? null, title }
}

// ------------------------------------------------------------ making things
//
// The first writes could only change what was already there. These make it.
//
// One rule runs through them: a create returns the new node's id, because the
// call after it almost always needs one. An agent building a card does
// create_frame, create_text, create_rectangle, move_node — and every step needs
// the answer to the step before.

/** Where a new node goes. The current page unless a parent is named. */
async function resolveParent(id: unknown): Promise<BaseNode & ChildrenMixin> {
  if (id === undefined || id === null || id === '') return figma.currentPage
  const node = await resolveFor(id, (candidate) => 'appendChild' in candidate, 'it cannot hold children')
  return node as unknown as BaseNode & ChildrenMixin
}

/** Name it, put it where it was asked for, and report it back. */
async function place(node: SceneNode, params: Record<string, unknown>): Promise<unknown> {
  if (typeof params.name === 'string' && params.name !== '') node.name = params.name
  const parent = await resolveParent(params.parentId)
  parent.appendChild(node)
  // Position after appending: a child of an auto-layout frame has its position
  // decided for it, and setting x/y first would be silently thrown away.
  if (params.x !== undefined) node.x = readNumber(params.x, 'x')
  if (params.y !== undefined) node.y = readNumber(params.y, 'y')
  afterMutation(true)
  return { ...toRow(node), parentId: parent.id }
}

/** The font a new or restyled text node should use, loaded and ready. */
async function readFont(params: Record<string, unknown>, fallback: FontName): Promise<FontName> {
  const font: FontName = {
    family: typeof params.fontFamily === 'string' && params.fontFamily !== '' ? params.fontFamily : fallback.family,
    style: typeof params.fontStyle === 'string' && params.fontStyle !== '' ? params.fontStyle : fallback.style,
  }
  try {
    await figma.loadFontAsync(font)
    return font
  } catch {
    throw new Error(
      `This machine has no "${font.family} ${font.style}". Use a font that is installed, or leave the font alone.`,
    )
  }
}

async function createText(params: Record<string, unknown>): Promise<unknown> {
  const node = figma.createText()
  node.fontName = await readFont(params, { family: 'Inter', style: 'Regular' })
  node.characters = String(params.text ?? '')
  if (params.fontSize !== undefined) node.fontSize = readNumber(params.fontSize, 'fontSize')
  if (params.color !== undefined) node.fills = [{ type: 'SOLID', color: readColor(params.color) }]
  if (params.width !== undefined) {
    // A fixed width is the only way to get wrapping; the default hugs its text.
    node.textAutoResize = 'HEIGHT'
    node.resize(Math.max(1, readNumber(params.width, 'width')), node.height)
  }
  if (typeof params.name !== 'string' || params.name === '') node.name = node.characters.slice(0, 40) || 'Text'
  return place(node, params)
}

async function createRectangle(params: Record<string, unknown>): Promise<unknown> {
  const node = figma.createRectangle()
  node.resize(
    params.width === undefined ? 100 : Math.max(0.01, readNumber(params.width, 'width')),
    params.height === undefined ? 100 : Math.max(0.01, readNumber(params.height, 'height')),
  )
  if (params.cornerRadius !== undefined) node.cornerRadius = readNumber(params.cornerRadius, 'cornerRadius')
  node.fills = params.fill === undefined ? [] : [{ type: 'SOLID', color: readColor(params.fill) }]
  return place(node, params)
}

async function createEllipse(params: Record<string, unknown>): Promise<unknown> {
  const node = figma.createEllipse()
  node.resize(
    params.width === undefined ? 100 : Math.max(0.01, readNumber(params.width, 'width')),
    params.height === undefined ? 100 : Math.max(0.01, readNumber(params.height, 'height')),
  )
  node.fills = params.fill === undefined ? [] : [{ type: 'SOLID', color: readColor(params.fill) }]
  return place(node, params)
}

async function createSvg(params: Record<string, unknown>): Promise<unknown> {
  const svg = String(params.svg ?? '').trim()
  if (svg === '') throw new Error('Pass the SVG markup')
  let node: FrameNode
  try {
    node = figma.createNodeFromSvg(svg)
  } catch (error) {
    throw new Error(`Figma could not read that SVG: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (params.width !== undefined || params.height !== undefined) {
    node.resize(
      params.width === undefined ? node.width : Math.max(0.01, readNumber(params.width, 'width')),
      params.height === undefined ? node.height : Math.max(0.01, readNumber(params.height, 'height')),
    )
  }
  return place(node, params)
}

async function createInstance(params: Record<string, unknown>): Promise<unknown> {
  const source = await figma.getNodeByIdAsync(String(params.componentId ?? ''))
  if (source === null || source.removed) throw new Error(`No component with id ${String(params.componentId)}`)
  // A variant set cannot be instantiated; its default variant can, and that is
  // what a caller naming the set almost certainly meant.
  const component =
    source.type === 'COMPONENT_SET' ? (source.defaultVariant as ComponentNode | null) : (source as ComponentNode)
  if (component === null || component.type !== 'COMPONENT') {
    throw new Error(`${(source as SceneNode).name} is a ${source.type}, not a component`)
  }
  return place(component.createInstance(), params)
}

// ---------------------------------------------------------- moving them about

async function cloneNode(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveScene(params.nodeId)
  const copy = node.clone()
  const parent = params.parentId === undefined ? node.parent : await resolveParent(params.parentId)
  if (parent === null) throw new Error('That node has no parent to copy into')
  ;(parent as ChildrenMixin).appendChild(copy)
  if (params.x !== undefined) copy.x = readNumber(params.x, 'x')
  if (params.y !== undefined) copy.y = readNumber(params.y, 'y')
  afterMutation(true)
  return { ...toRow(copy), parentId: parent.id }
}

async function moveNode(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveScene(params.nodeId)
  const parent = params.parentId === undefined ? node.parent : await resolveParent(params.parentId)
  if (parent === null) throw new Error('That node has no parent')
  const children = (parent as ChildrenMixin).children
  const index = params.index === undefined ? children.length : Math.max(0, readNumber(params.index, 'index'))
  ;(parent as ChildrenMixin).insertChild(Math.min(index, children.length), node)
  afterMutation(true)
  return { ...toRow(node), parentId: parent.id, index: (parent as ChildrenMixin).children.indexOf(node) }
}

async function deleteNode(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveScene(params.nodeId)
  const gone = { id: node.id, name: node.name, type: node.type }
  node.remove()
  afterMutation(true)
  return gone
}

// -------------------------------------------------------------- appearance

async function setBounds(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveScene(params.nodeId)
  if (params.x !== undefined) node.x = readNumber(params.x, 'x')
  if (params.y !== undefined) node.y = readNumber(params.y, 'y')
  if (params.width !== undefined || params.height !== undefined) {
    // A handful of node types have a size but no way to set it.
    if (!('resize' in node)) throw new Error(`A ${node.type} cannot be resized`)
    node.resize(
      params.width === undefined ? node.width : Math.max(0.01, readNumber(params.width, 'width')),
      params.height === undefined ? node.height : Math.max(0.01, readNumber(params.height, 'height')),
    )
  }
  afterMutation()
  return toRow(node)
}

const CORNERS = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'] as const

async function setCornerRadius(params: Record<string, unknown>): Promise<unknown> {
  const node = (await resolveFor(
    params.nodeId,
    (candidate) => 'cornerRadius' in candidate,
    'it has no corners to round',
  )) as SceneNode & CornerMixin & Partial<RectangleCornerMixin>
  const named = CORNERS.filter((corner) => params[corner] !== undefined)
  if (named.length > 0) {
    for (const corner of named) node[corner] = readNumber(params[corner], corner)
  } else {
    node.cornerRadius = readNumber(params.radius, 'radius')
  }
  afterMutation()
  return { id: node.id, name: node.name, cornerRadius: node.cornerRadius === figma.mixed ? 'mixed' : node.cornerRadius }
}

async function setNodeName(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveScene(params.nodeId)
  const name = String(params.name ?? '').trim()
  if (name === '') throw new Error('A layer needs a name')
  node.name = name
  afterMutation(true)
  return { id: node.id, name: node.name }
}

async function setVisibility(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveScene(params.nodeId)
  if (params.opacity !== undefined) {
    const opacity = readNumber(params.opacity, 'opacity')
    if (opacity < 0 || opacity > 1) throw new Error('opacity must be between 0 and 1')
    ;(node as SceneNode & MinimalBlendMixin).opacity = opacity
  }
  if (params.visible !== undefined) node.visible = params.visible === true
  if (params.locked !== undefined) node.locked = params.locked === true
  afterMutation(true)
  return { id: node.id, name: node.name, visible: node.visible, locked: node.locked }
}

async function setEffects(params: Record<string, unknown>): Promise<unknown> {
  const node = (await resolveFor(
    params.nodeId,
    (candidate) => 'effects' in candidate,
    'it takes no effects',
  )) as SceneNode & BlendMixin

  const asked = Array.isArray(params.effects) ? params.effects : []
  const effects: Effect[] = asked.map((raw) => {
    const entry = (raw ?? {}) as Record<string, unknown>
    const kind = String(entry.type ?? 'DROP_SHADOW')
    const radius = entry.radius === undefined ? 4 : readNumber(entry.radius, 'radius')
    if (kind === 'LAYER_BLUR' || kind === 'BACKGROUND_BLUR') {
      return { type: kind, radius, visible: true } as Effect
    }
    if (kind !== 'DROP_SHADOW' && kind !== 'INNER_SHADOW') {
      throw new Error(`Unknown effect ${kind}. Use DROP_SHADOW, INNER_SHADOW, LAYER_BLUR or BACKGROUND_BLUR.`)
    }
    const colour = entry.color === undefined ? { r: 0, g: 0, b: 0 } : readColor(entry.color)
    const alpha = entry.alpha === undefined ? 0.25 : readNumber(entry.alpha, 'alpha')
    return {
      type: kind,
      color: { ...colour, a: alpha },
      offset: {
        x: entry.offsetX === undefined ? 0 : readNumber(entry.offsetX, 'offsetX'),
        y: entry.offsetY === undefined ? 2 : readNumber(entry.offsetY, 'offsetY'),
      },
      radius,
      spread: entry.spread === undefined ? 0 : readNumber(entry.spread, 'spread'),
      visible: true,
      blendMode: 'NORMAL',
    } as Effect
  })

  node.effects = effects
  afterMutation()
  return { id: node.id, name: node.name, effects: effects.length }
}

// -------------------------------------------------------------------- text

async function setTextStyle(params: Record<string, unknown>): Promise<unknown> {
  const node = (await resolveFor(
    params.nodeId,
    (candidate) => candidate.type === 'TEXT',
    'only a TEXT layer has type to set',
  )) as TextNode
  await loadFontsOf(node)

  if (params.fontFamily !== undefined || params.fontStyle !== undefined) {
    const current = node.fontName === figma.mixed ? { family: 'Inter', style: 'Regular' } : node.fontName
    node.fontName = await readFont(params, current)
  }
  if (params.fontSize !== undefined) node.fontSize = readNumber(params.fontSize, 'fontSize')
  if (params.lineHeight !== undefined) {
    node.lineHeight = { unit: 'PIXELS', value: readNumber(params.lineHeight, 'lineHeight') }
  }
  if (params.letterSpacing !== undefined) {
    node.letterSpacing = { unit: 'PIXELS', value: readNumber(params.letterSpacing, 'letterSpacing') }
  }
  if (params.align !== undefined) node.textAlignHorizontal = params.align as TextNode['textAlignHorizontal']
  if (params.color !== undefined) node.fills = [{ type: 'SOLID', color: readColor(params.color) }]
  if (params.autoResize !== undefined) node.textAutoResize = params.autoResize as TextNode['textAutoResize']

  afterMutation()
  return {
    id: node.id,
    name: node.name,
    fontSize: node.fontSize === figma.mixed ? 'mixed' : node.fontSize,
    fontName: node.fontName === figma.mixed ? 'mixed' : node.fontName,
  }
}

// ------------------------------------------------------------------ layout

async function setLayoutSizing(params: Record<string, unknown>): Promise<unknown> {
  const node = (await resolveFor(
    params.nodeId,
    (candidate) => 'layoutSizingHorizontal' in candidate,
    'only a child of an auto-layout frame is sized this way',
  )) as SceneNode & AutoLayoutChildrenMixin & { layoutSizingHorizontal: 'FIXED' | 'HUG' | 'FILL' }
  const sized = node as unknown as {
    layoutSizingHorizontal: 'FIXED' | 'HUG' | 'FILL'
    layoutSizingVertical: 'FIXED' | 'HUG' | 'FILL'
  }
  if (params.horizontal !== undefined) {
    sized.layoutSizingHorizontal = params.horizontal as 'FIXED' | 'HUG' | 'FILL'
  }
  if (params.vertical !== undefined) {
    sized.layoutSizingVertical = params.vertical as 'FIXED' | 'HUG' | 'FILL'
  }
  afterMutation()
  return {
    id: node.id,
    name: node.name,
    horizontal: sized.layoutSizingHorizontal,
    vertical: sized.layoutSizingVertical,
  }
}

// --------------------------------------------------------- the design system
//
// An agent asked to "match our button" needs to know what "our button" is. One
// read answers that: the components it can instantiate, the styles it can
// apply, and the variables it can bind — with the ids each of those needs.

const MAX_LIBRARY = 200

async function listLibrary(params: Record<string, unknown>): Promise<unknown> {
  const want = (name: string) =>
    params.only === undefined || params.only === '' || String(params.only) === name || params.only === 'all'

  const out: Record<string, unknown> = {}

  if (want('components')) {
    const found = figma.currentPage.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })
    out.components = found.slice(0, MAX_LIBRARY).map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      width: Math.round(node.width),
      height: Math.round(node.height),
    }))
    out.componentsTruncated = found.length > MAX_LIBRARY
  }

  if (want('styles')) {
    const [paints, texts, effects] = await Promise.all([
      figma.getLocalPaintStylesAsync(),
      figma.getLocalTextStylesAsync(),
      figma.getLocalEffectStylesAsync(),
    ])
    const shape = (style: BaseStyle) => ({ id: style.id, name: style.name })
    out.styles = {
      paint: paints.slice(0, MAX_LIBRARY).map(shape),
      text: texts.slice(0, MAX_LIBRARY).map(shape),
      effect: effects.slice(0, MAX_LIBRARY).map(shape),
    }
  }

  if (want('variables')) {
    const collections = await figma.variables.getLocalVariableCollectionsAsync()
    const variables = await figma.variables.getLocalVariablesAsync()
    out.variables = variables.slice(0, MAX_LIBRARY).map((variable) => ({
      id: variable.id,
      name: variable.name,
      type: variable.resolvedType,
      collection: collections.find((entry) => entry.id === variable.variableCollectionId)?.name ?? null,
    }))
    out.variablesTruncated = variables.length > MAX_LIBRARY
  }

  return out
}

async function applyStyle(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveScene(params.nodeId)
  const id = String(params.styleId ?? '')
  const style = await figma.getStyleByIdAsync(id)
  if (style === null) throw new Error(`No style with id ${id}`)

  if (style.type === 'PAINT') {
    if (!('setFillStyleIdAsync' in node)) throw new Error(`${node.name} takes no fill style`)
    await (node as SceneNode & MinimalFillsMixin).setFillStyleIdAsync(id)
  } else if (style.type === 'TEXT') {
    if (node.type !== 'TEXT') throw new Error(`${node.name} is a ${node.type}, not a TEXT layer`)
    await loadFontsOf(node)
    await node.setTextStyleIdAsync(id)
  } else if (style.type === 'EFFECT') {
    await (node as SceneNode & BlendMixin).setEffectStyleIdAsync(id)
  } else {
    throw new Error(`${style.name} is a ${style.type} style, which cannot be applied to a layer this way`)
  }

  afterMutation()
  return { id: node.id, name: node.name, style: style.name }
}

async function bindVariable(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveScene(params.nodeId)
  const variable = await figma.variables.getVariableByIdAsync(String(params.variableId ?? ''))
  if (variable === null) throw new Error(`No variable with id ${String(params.variableId)}`)
  const field = String(params.field ?? '')

  // A colour lives inside a paint, not on the node, so it binds differently
  // from a number like cornerRadius. Both are "bind a variable" to a caller.
  if (field === 'fill' || field === 'stroke') {
    const key = field === 'fill' ? 'fills' : 'strokes'
    const target = node as unknown as Record<string, readonly Paint[] | typeof figma.mixed>
    const current = target[key]
    if (current === figma.mixed || !Array.isArray(current) || current.length === 0) {
      throw new Error(`${node.name} has no single ${field} to bind; set one first with figma_set_${field}`)
    }
    target[key] = [figma.variables.setBoundVariableForPaint(current[0] as SolidPaint, 'color', variable)]
  } else {
    ;(node as SceneNode & { setBoundVariable: (field: string, value: Variable) => void }).setBoundVariable(
      field,
      variable,
    )
  }

  afterMutation()
  return { id: node.id, name: node.name, field, variable: variable.name }
}

// --------------------------------------------------- the rest of the file
//
// Everything above answers about the page that happens to be open, which is a
// silent lie on a file that has five. `get_tree` returning nothing for a frame
// on another page reads as "it does not exist" rather than "look elsewhere",
// and an agent has no way to tell those apart. So: a way to see the pages, and
// a way to search across them.
//
// Searching is also the cheaper half of a habit worth encouraging. Walking the
// tree to find one component costs a round trip per level and a page of rows;
// asking for it by type and name costs one call and a handful.

const MAX_FIND = 200

/** Case-insensitive substring, not a regex: a model's bad regex is a hang. */
function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function findWithin(scope: BaseNode & ChildrenMixin, types: NodeType[]): SceneNode[] {
  // `findAllWithCriteria` uses Figma's own index and is hundreds of times
  // faster, but it is only offered where the node keeps one.
  if (types.length > 0 && 'findAllWithCriteria' in scope) {
    return (scope as PageNode).findAllWithCriteria({ types: types as ('FRAME' | 'TEXT')[] }) as SceneNode[]
  }
  return scope.findAll(() => true) as SceneNode[]
}

/**
 * Nodes matching type, name and text. Every filter is optional and they narrow
 * together, so no argument at all means "everything on this page", bounded.
 */
async function findNodes(params: Record<string, unknown>): Promise<unknown> {
  const asked = Array.isArray(params.types) ? params.types.map((value) => String(value).toUpperCase()) : []
  const unknown = asked.filter((type) => !FINDABLE_TYPES.includes(type))
  if (unknown.length > 0) {
    throw new Error(`Not a type this can search for: ${unknown.join(', ')}. Use one of ${FINDABLE_TYPES.join(', ')}`)
  }
  const types = asked as NodeType[]
  const name = typeof params.name === 'string' ? params.name.trim() : ''
  const text = typeof params.text === 'string' ? params.text.trim() : ''
  const limitAsked = Number(params.limit)
  const limit = Number.isFinite(limitAsked) && limitAsked > 0 ? Math.min(Math.floor(limitAsked), MAX_FIND) : 50

  /** Where to look: one subtree, this page, or the whole file. */
  const scopes: { page: string; scope: BaseNode & ChildrenMixin }[] = []
  if (typeof params.nodeId === 'string' && params.nodeId !== '') {
    const node = await resolveFor(params.nodeId, (candidate) => 'children' in candidate, 'it has no children to search')
    scopes.push({ page: figma.currentPage.name, scope: node as SceneNode & ChildrenMixin })
  } else if (params.allPages === true) {
    // Another page's contents are not loaded under dynamic-page access, and
    // searching one without loading it finds nothing rather than failing.
    for (const page of figma.root.children) {
      await page.loadAsync()
      scopes.push({ page: page.name, scope: page })
    }
  } else {
    scopes.push({ page: figma.currentPage.name, scope: figma.currentPage })
  }

  const rows: (TreeRow & { page: string })[] = []
  let searched = 0
  let truncated = false
  for (const { page, scope } of scopes) {
    for (const node of findWithin(scope, types)) {
      searched += 1
      if (types.length > 0 && !types.includes(node.type)) continue
      if (name !== '' && !contains(node.name, name)) continue
      if (text !== '') {
        if (node.type !== 'TEXT') continue
        if (!contains(node.characters, text)) continue
      }
      if (rows.length >= limit) {
        truncated = true
        break
      }
      rows.push({ ...toRow(node), page })
    }
    if (truncated) break
  }
  return { rows, searched, truncated, scopes: scopes.map((entry) => entry.page) }
}

/**
 * The pages, and moving between them. Opening one is driving the canvas rather
 * than editing it — nothing in the file changes and there is nothing to undo —
 * so it sits outside the Edits gate, next to selecting.
 */
async function pages(params: Record<string, unknown>): Promise<unknown> {
  const action = String(params.action ?? '')
  const listed = () =>
    figma.root.children.map((page) => ({
      id: page.id,
      name: page.name,
      current: page.id === figma.currentPage.id,
    }))

  if (action === 'list') return { file: figma.root.name, pages: listed() }

  if (action === 'open') {
    const wanted = String(params.pageId ?? params.name ?? '')
    if (wanted === '') throw new Error('Pass pageId, or name, for the page to open')
    const page =
      figma.root.children.find((candidate) => candidate.id === wanted) ??
      figma.root.children.find((candidate) => contains(candidate.name, wanted))
    if (page === undefined) throw new Error(`No page called ${wanted}. Try action "list".`)
    await page.loadAsync()
    await figma.setCurrentPageAsync(page)
    // The panel is showing the old page's tree, and Figma does not promise an
    // event for a programmatic switch.
    sendTree()
    scheduleSelectionExtract()
    return { page: page.name, id: page.id, pages: listed() }
  }

  throw new Error(`Unknown pages action: ${action}. Use list or open.`)
}

/**
 * A component's properties, and what an instance currently has them set to.
 *
 * This exists because `setProperties` needs the exact key, and for anything but
 * a variant that key carries an id suffix — `Label#8:2`, not `Label`. Guessing
 * it is not possible, so reading has to come first.
 */
async function componentProperties(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveFor(
    params.nodeId,
    (candidate) => candidate.type === 'INSTANCE' || candidate.type === 'COMPONENT' || candidate.type === 'COMPONENT_SET',
    'only a component, a component set or an instance has properties',
  )

  const describe = (definitions: ComponentPropertyDefinitions) =>
    Object.entries(definitions).map(([key, definition]) => ({
      key,
      type: definition.type,
      defaultValue: definition.defaultValue ?? null,
      // Variant options, or the components an instance-swap will accept.
      options: definition.variantOptions ?? definition.preferredValues ?? null,
    }))

  if (node.type === 'COMPONENT_SET' || node.type === 'COMPONENT') {
    return { ...toRow(node), properties: describe(node.componentPropertyDefinitions) }
  }

  // The predicate above has already refused anything else; `resolveFor` hands
  // back a SceneNode, so the narrowing has to be said out loud.
  const instance = node as InstanceNode
  const main = await instance.getMainComponentAsync()
  // A variant's properties are defined on the set, not on the variant.
  const owner = main === null ? null : main.parent?.type === 'COMPONENT_SET' ? main.parent : main
  return {
    ...toRow(instance),
    mainComponent: main === null ? null : { id: main.id, name: main.name },
    properties: owner === null ? [] : describe(owner.componentPropertyDefinitions),
    values: Object.entries(instance.componentProperties).map(([key, property]) => ({
      key,
      type: property.type,
      value: property.value,
    })),
  }
}

// ------------------------------------------------------------- more writing

/**
 * Group and ungroup. Figma needs a parent for a new group, and the answer is
 * always the first node's own parent: a group that lands somewhere else is not
 * what anybody meant by "group these".
 */
async function groupNodes(params: Record<string, unknown>): Promise<unknown> {
  const action = String(params.action ?? 'group')

  if (action === 'ungroup') {
    const node = await resolveFor(
      params.nodeId,
      (candidate) => candidate.type === 'GROUP' || candidate.type === 'FRAME',
      'only a group or a frame can be ungrouped',
    )
    const parentId = node.parent?.id ?? null
    const children = figma.ungroup(node as SceneNode & ChildrenMixin)
    afterMutation(true)
    return { ungrouped: children.map(toRow), parentId }
  }

  if (action !== 'group') throw new Error(`Unknown group action: ${action}. Use group or ungroup.`)

  const ids = Array.isArray(params.nodeIds) ? params.nodeIds.map(String).filter((id) => id !== '') : []
  if (ids.length === 0) throw new Error('Pass nodeIds as a non-empty array of node ids')
  const nodes: SceneNode[] = []
  for (const id of ids.slice(0, MAX_BATCH)) nodes.push(await resolveScene(id))

  const parent = nodes[0].parent
  if (parent === null || !('appendChild' in parent)) throw new Error(`${nodes[0].name} has no parent to group inside`)
  const group = figma.group(nodes, parent as BaseNode & ChildrenMixin)
  if (typeof params.name === 'string' && params.name !== '') group.name = params.name
  afterMutation(true)
  return { ...toRow(group), parentId: parent.id }
}

/**
 * Base64 in, an image on the canvas out.
 *
 * Bytes rather than a URL because the manifest's `allowedDomains` names the
 * relay and the local daemon and nothing else — `createImageAsync` against
 * anywhere a designer would actually keep an image is blocked, and would fail
 * as a network error that says nothing about why.
 */
const MAX_INSERT_BASE64 = 700_000

/** The sandbox has no atob, so this is the other direction of `toBase64`. */
function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/^data:[^,]*,/, '').replace(/[\s]/g, '')
  const sized = clean.replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor((sized.length * 3) / 4))
  let at = 0
  let buffer = 0
  let bits = 0
  for (const character of sized) {
    const value = BASE64_ALPHABET.indexOf(character)
    if (value === -1) throw new Error('The image data is not base64')
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[at++] = (buffer >> bits) & 0xff
    }
  }
  return bytes.subarray(0, at)
}

async function insertImage(params: Record<string, unknown>): Promise<unknown> {
  const data = typeof params.data === 'string' ? params.data : ''
  if (data === '') throw new Error('Pass data: the image as base64, PNG, JPG or GIF')
  if (data.length > MAX_INSERT_BASE64) {
    throw new Error(
      `That image is ${Math.ceil(data.length / 1000)}KB of base64 and the limit is ${MAX_INSERT_BASE64 / 1000}KB. ` +
        'Export it smaller, or at a lower scale.',
    )
  }

  let image: Image
  try {
    image = figma.createImage(fromBase64(data))
  } catch (error) {
    throw new Error(`Figma would not read that as an image: ${error instanceof Error ? error.message : String(error)}`)
  }
  const size = await image.getSizeAsync()
  const scaleMode = (typeof params.scaleMode === 'string' ? params.scaleMode.toUpperCase() : 'FILL') as
    | 'FILL'
    | 'FIT'
    | 'CROP'
    | 'TILE'
  const paint: ImagePaint = { type: 'IMAGE', imageHash: image.hash, scaleMode }

  // Onto a layer that already exists, which is how a placeholder gets its
  // picture without anything moving.
  if (typeof params.nodeId === 'string' && params.nodeId !== '') {
    const node = await resolveFor(params.nodeId, (candidate) => 'fills' in candidate, 'it cannot take a fill')
    ;(node as GeometryMixin).fills = [paint]
    afterMutation()
    return { ...toRow(node), image: size, scaleMode }
  }

  const parent =
    params.parentId === undefined || params.parentId === ''
      ? figma.currentPage
      : await resolveFor(params.parentId, (candidate) => 'appendChild' in candidate, 'it cannot hold children')
  const rectangle = figma.createRectangle()
  rectangle.name = typeof params.name === 'string' && params.name !== '' ? params.name : 'Image'
  rectangle.x = params.x === undefined ? 0 : readNumber(params.x, 'x')
  rectangle.y = params.y === undefined ? 0 : readNumber(params.y, 'y')
  // Its own size unless told otherwise: an image squeezed into a default 100x100
  // is a bug report waiting to happen.
  rectangle.resize(
    params.width === undefined ? Math.max(1, size.width) : Math.max(1, readNumber(params.width, 'width')),
    params.height === undefined ? Math.max(1, size.height) : Math.max(1, readNumber(params.height, 'height')),
  )
  rectangle.fills = [paint]
  ;(parent as ChildrenMixin).appendChild(rectangle)
  afterMutation(true)
  return { ...toRow(rectangle), parentId: parent.id, image: size, scaleMode }
}

/**
 * Set an instance's properties: which variant it is, and the text and booleans
 * the component exposes. `figma_component_properties` is where the keys come
 * from, and a wrong one is refused with the list rather than ignored.
 */
async function setInstanceProperties(params: Record<string, unknown>): Promise<unknown> {
  const node = await resolveFor(params.nodeId, (candidate) => candidate.type === 'INSTANCE', 'only an instance has properties to set')
  const instance = node as InstanceNode
  const wanted = params.properties
  if (wanted === null || typeof wanted !== 'object' || Array.isArray(wanted)) {
    throw new Error('Pass properties as an object of key to value, from figma_component_properties')
  }

  const known = Object.keys(instance.componentProperties)
  const properties: { [key: string]: string | boolean } = {}
  for (const [key, value] of Object.entries(wanted as Record<string, unknown>)) {
    // A key that is nearly right — the name without its id suffix — is the
    // predictable mistake, so it is named rather than left to Figma's message.
    const match = known.includes(key) ? key : known.find((candidate) => candidate.split('#')[0] === key)
    if (match === undefined) throw new Error(`${instance.name} has no property ${key}. It has: ${known.join(', ') || 'none'}`)
    properties[match] = typeof value === 'boolean' ? value : String(value)
  }

  try {
    instance.setProperties(properties)
  } catch (error) {
    throw new Error(`That value was refused: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Swapping a variant can change the layer's whole subtree.
  afterMutation(true)
  return {
    ...toRow(instance),
    values: Object.entries(instance.componentProperties).map(([key, property]) => ({ key, value: property.value })),
  }
}

/** Commands the relay can issue. Errors are returned to the caller, not thrown away. */
async function handleRequest(command: string, params: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case 'get_tree':
      return treeData(requestedDepth(params.depth))
    case 'get_children':
      return childrenData(String(params.id ?? ''), requestedDepth(params.depth))
    case 'get_selection': {
      const selection = figma.currentPage.selection
      return { page: figma.currentPage.name, rows: selection.map(toRow) }
    }
    // Driving the canvas rather than reading it, but not editing it: nothing in
    // the file changes, so this is not behind the Edits gate and leaves no undo
    // step. Selecting and scrolling are one act to a person — an agent that has
    // found the CTA is trying to point at it — so they happen together, exactly
    // as they do when the panel's own tree is clicked.
    case 'set_selection': {
      const ids = Array.isArray(params.nodeIds)
        ? params.nodeIds.map(String).filter((id) => id !== '')
        : typeof params.nodeId === 'string' && params.nodeId !== ''
          ? [params.nodeId]
          : []
      if (ids.length === 0) throw new Error('Pass nodeId, or nodeIds as a non-empty array of node ids.')
      const nodes: SceneNode[] = []
      for (const id of ids.slice(0, MAX_BATCH)) nodes.push(await resolveScene(id))
      figma.currentPage.selection = nodes
      figma.viewport.scrollAndZoomIntoView(nodes)
      // The panel is told the way a click on the canvas would tell it. Figma
      // does not promise `selectionchange` for a programmatic assignment, and a
      // panel still previewing the previous layer reads as a selection that
      // did not take.
      scheduleSelectionExtract()
      return { page: figma.currentPage.name, rows: nodes.map(toRow) }
    }
    case 'extract_urls': {
      const text = typeof params.urls === 'string' ? params.urls : Array.isArray(params.urls) ? params.urls.join('\n') : String(params.url ?? '')
      return { results: await extractBatch(urlEntries(text), optionsFrom(params)) }
    }
    case 'extract_nodes':
      return { results: await extractBatch(idEntries(params.nodeIds), optionsFrom(params)) }
    case 'extract_selection':
      return { results: await extractBatch(selectionEntries(), optionsFrom(params)) }
    case 'extract_saved':
      await refreshSaved()
      return { results: await extractBatch(savedEntries(params.folder), optionsFrom(params)) }
    case 'list_saved': {
      const entries = await refreshSaved()
      const scoped = params.folder === undefined ? undefined : findFolder(normaliseFolder(params.folder))
      return {
        folders: folderCounts(),
        entries: scoped === undefined ? entries : entries.filter((entry) => entry.folder === scoped),
      }
    }
    case 'list_folders':
      await refreshSaved()
      return { folders: folderCounts() }
    case 'create_folder': {
      const name = await createFolder(params.name)
      sendSaved()
      return { name, folders: folderCounts() }
    }
    case 'rename_folder': {
      const name = await renameFolder(params.from, params.to)
      sendSaved()
      return { name, folders: folderCounts(), entries: saved }
    }
    case 'delete_folder': {
      const affected = await deleteFolder(params.name, params.deleteEntries === true)
      sendSaved()
      return { affected, folders: folderCounts(), entries: saved }
    }
    case 'move_saved': {
      const ids = Array.isArray(params.nodeIds) ? (params.nodeIds as string[]).map(String) : []
      const moved = await moveSaved(ids, params.folder)
      sendSaved()
      return { moved, folders: folderCounts(), entries: saved }
    }
    case 'save_selection': {
      const result = await addSaved(figma.currentPage.selection, params.folder)
      await refreshSaved()
      sendSaved()
      return { ...result, folders: folderCounts(), entries: saved }
    }
    case 'save_nodes': {
      const ids = Array.isArray(params.nodeIds) ? params.nodeIds.map(String) : []
      const nodes: SceneNode[] = []
      for (const id of ids) nodes.push(await resolveScene(id))
      const result = await addSaved(nodes, params.folder)
      await refreshSaved()
      sendSaved()
      return { ...result, folders: folderCounts(), entries: saved }
    }
    case 'unsave': {
      const ids = Array.isArray(params.nodeIds) ? params.nodeIds.map(String) : []
      await removeSaved(ids)
      sendSaved()
      return { folders: folderCounts(), entries: saved }
    }
    case 'clear_saved': {
      // Clearing one folder empties it without removing the folder itself;
      // `all` means the whole set, whatever folder was also named.
      const scoped =
        params.all === true || params.folder === undefined ? undefined : findFolder(normaliseFolder(params.folder))
      const doomed = saved.filter((entry) => scoped === undefined || entry.folder === scoped)
      await removeSaved(doomed.map((entry) => entry.id))
      sendSaved()
      return { removed: doomed.length, folders: folderCounts(), entries: saved }
    }
    case 'resolve_urls': {
      const text = typeof params.urls === 'string' ? params.urls : Array.isArray(params.urls) ? params.urls.join('\n') : String(params.url ?? '')
      const parsed = parseUrls(text)
      const rows = []
      for (const entry of parsed.slice(0, MAX_BATCH)) {
        try {
          const node = await resolveUrl(entry)
          rows.push({ url: entry.url, nodeId: entry.nodeId, ok: true, node: toRow(node) })
        } catch (error) {
          rows.push({ url: entry.url, nodeId: entry.nodeId, ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return { fileKey: figma.fileKey ?? null, rows }
    }
    case 'export_png': {
      // Just the image: no CSS walk, so an image URL can be re-rendered cheaply.
      const node = await resolveScene(params.nodeId)
      const scale = Number(params.scale)
      const png = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: Number.isFinite(scale) && scale >= 1 && scale <= 4 ? scale : 2 },
        useAbsoluteBounds: true,
      })
      return { png }
    }
    case 'set_fill':
      return setFill(params)
    case 'create_text':
      return createText(params)
    case 'create_rectangle':
      return createRectangle(params)
    case 'create_ellipse':
      return createEllipse(params)
    case 'create_svg':
      return createSvg(params)
    case 'create_instance':
      return createInstance(params)
    case 'clone_node':
      return cloneNode(params)
    case 'move_node':
      return moveNode(params)
    case 'delete_node':
      return deleteNode(params)
    case 'set_bounds':
      return setBounds(params)
    case 'set_corner_radius':
      return setCornerRadius(params)
    case 'set_node_name':
      return setNodeName(params)
    case 'set_visibility':
      return setVisibility(params)
    case 'set_effects':
      return setEffects(params)
    case 'set_text_style':
      return setTextStyle(params)
    case 'set_layout_sizing':
      return setLayoutSizing(params)
    case 'list_library':
      return listLibrary(params)
    case 'apply_style':
      return applyStyle(params)
    case 'bind_variable':
      return bindVariable(params)
    case 'set_stroke':
      return setStroke(params)
    case 'set_text':
      return setText(params)
    case 'set_auto_layout':
      return setAutoLayout(params)
    case 'create_frame':
      return createFrame(params)
    case 'find_nodes':
      return findNodes(params)
    case 'pages':
      return pages(params)
    case 'component_properties':
      return componentProperties(params)
    case 'group_nodes':
      return groupNodes(params)
    case 'insert_image':
      return insertImage(params)
    case 'set_instance_properties':
      return setInstanceProperties(params)
    case 'save_version':
      return saveVersion(params)
    case 'extract': {
      const node = typeof params.url === 'string' && params.url !== ''
        ? await resolveUrl(parseUrl(params.url) ?? { url: params.url, fileKey: '', nodeId: null })
        : await resolveScene(params.nodeId)
      const extraction = await buildExtraction(node, optionsFrom(params))
      const { type: _ignored, ...rest } = extraction
      return rest
    }
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

figma.ui.onmessage = (msg: FromUI) => {
  switch (msg.type) {
    case 'ready':
      void restoreSize()
      void sendSettings()
      void sendAgentSettings()
      sendTree()
      scheduleSelectionExtract()
      loadSaved()
        .then(refreshSaved)
        .then(() => {
          sendSaved()
          // Opened on another machine since? This is where that is settled.
          requestSync()
        })
      break
    case 'save-selection':
      addSaved(figma.currentPage.selection, msg.folder ?? '')
        .then(async (result) => {
          await refreshSaved()
          sendSaved()
          send({ type: 'save-result', ...result, folder: msg.folder ?? '' })
        })
        .catch(reportFailure)
      break
    case 'create-folder':
      createFolder(msg.name).then(sendSaved, reportFailure)
      break
    case 'rename-folder':
      renameFolder(msg.from, msg.to).then(sendSaved, reportFailure)
      break
    case 'delete-folder':
      deleteFolder(msg.name, msg.deleteEntries === true).then(sendSaved, reportFailure)
      break
    case 'move-saved':
      moveSaved(msg.ids, msg.folder).then(sendSaved, reportFailure)
      break
    case 'sync-apply': {
      // The relay's copy was newer, so it replaces this machine's without
      // being written back — the stamp travels with it.
      folders = msg.folders
      saved = msg.entries
      persistSaved({ stamp: msg.updatedAt, sync: false })
        .then(refreshSaved)
        .then(sendSaved)
        .catch(reportFailure)
      break
    }
    case 'unsave':
      removeSaved(msg.ids).then(sendSaved)
      break
    case 'clear-saved': {
      const scope = msg.folder
      const doomed = saved.filter((entry) => scope === undefined || entry.folder === scope)
      removeSaved(doomed.map((entry) => entry.id)).then(sendSaved, reportFailure)
      break
    }
    case 'refresh-saved':
      refreshSaved().then(sendSaved)
      break
    case 'resize':
      void rememberSize(msg.width, msg.height)
      break
    case 'minimise':
      minimised = msg.on
      if (msg.on) {
        // The strip first; the preview and its height follow from the selection.
        resizeMini(0)
        scheduleSelectionExtract()
      } else {
        // Back to whatever size the user had dragged it to, not the default,
        // and with a preview of whatever they picked while it was out of the way.
        void restoreSize()
        scheduleSelectionExtract()
      }
      break
    case 'save-settings':
      void saveSettings(msg.url, msg.token, msg.email ?? '')
      break
    case 'save-agent-settings':
      void saveAgentSettings({
        url: msg.url,
        token: msg.token,
        cwd: msg.cwd,
        harness: msg.harness,
        sessionId: msg.sessionId,
        writes: msg.writes,
        auto: msg.auto,
      })
      break
    case 'sign-out':
      void signOut()
      break
    case 'forget-relay':
      void forgetProfile(msg.url)
      break
    case 'open-url':
      // A plugin iframe cannot open a tab itself; only the main thread can.
      if (/^https:\/\//.test(msg.url)) figma.openExternal(msg.url)
      break
    case 'expand':
      void sendChildren(msg.id)
      break
    case 'pick':
      void extractById(msg.id, msg.additive === true)
      break
    case 'capture':
      scheduleSelectionExtract()
      break
    case 'scale':
      defaults.scale = msg.value
      scheduleSelectionExtract()
      break
    case 'scope':
      defaults.selectionOnly = msg.selectionOnly
      scheduleSelectionExtract()
      break
    case 'instances':
      defaults.inlineInstances = msg.inline
      scheduleSelectionExtract()
      break
    case 'cancel':
      figma.closePlugin()
      break
    case 'batch': {
      const options = { ...defaults }
      let entries: BatchEntry[]
      try {
        if (msg.source === 'selection') entries = selectionEntries()
        else if (msg.source === 'saved') entries = savedEntries(msg.folder)
        else entries = urlEntries(msg.text ?? '')
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        break
      }
      extractBatch(entries, options, (outcome, index, total) => {
        send({
          type: 'batch-progress',
          index,
          total,
          ref: outcome.ref,
          nodeId: outcome.nodeId,
          ok: outcome.ok,
          name: outcome.ok ? outcome.extraction.name : undefined,
          nodeType: outcome.ok ? outcome.extraction.nodeType : undefined,
          layerCount: outcome.ok ? outcome.extraction.layerCount : undefined,
          error: outcome.ok ? undefined : outcome.error,
        })
        // The panel shows the last successful extraction, matching a click.
        if (outcome.ok) send({ type: 'extract', ...outcome.extraction })
      }).then(
        (outcomes) => send({ type: 'batch-done', total: outcomes.length, okCount: outcomes.filter((o) => o.ok).length }),
        (error: unknown) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
      )
      break
    }
    case 'req':
      handleRequest(msg.command, msg.params).then(
        (data) => send({ type: 'res', id: msg.id, ok: true, data }),
        (error: unknown) =>
          send({
            type: 'res',
            id: msg.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      )
      break
  }
}
