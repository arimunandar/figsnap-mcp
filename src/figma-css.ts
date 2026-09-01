// Figma's legacy "Copy as CSS" format, regenerated from node properties.
//
// getCSSAsync() returns Dev Mode CSS: tokenised, shorthand, and it stops at
// instance boundaries. The older format Figma's right-click Copy as CSS produces
// is flat bare declarations under layer-name comments, with explicit width and
// height, raw hex colours, absolute geometry for non-auto-layout children, and
// the "Inside auto layout" block. The plugin API does not expose that generator,
// so this rebuilds it from layoutMode, constraints, fills, strokes and geometry.

const MAX_NODES = 500

function num(value: number, decimals: number): string {
  const factor = Math.pow(10, decimals)
  return String(Math.round(value * factor) / factor)
}

/** Geometry and percentages round to two decimals, the way Figma prints them. */
function px(value: number): string {
  return `${num(value, 2)}px`
}

function pct(fraction: number): string {
  return `${num(fraction * 100, 2)}%`
}

/** Stroke weight is the exception: Figma prints it unrounded (0.861111px). */
function weight(value: number): string {
  return `${num(value, 6)}px`
}

function trim(value: number): string {
  return num(value, 4)
}

function channel(value: number): string {
  return Math.round(value * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
}

function hex({ r, g, b }: RGB): string {
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

function rgba(color: RGB, alpha: number): string {
  const parts = [Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255)]
  return `rgba(${parts.join(', ')}, ${trim(alpha)})`
}

function colorOf(paint: SolidPaint): string {
  const alpha = paint.opacity === undefined ? 1 : paint.opacity
  return alpha >= 1 ? hex(paint.color) : rgba(paint.color, alpha)
}

/**
 * Figma stores a gradient as a transform matrix whose first *row* is the
 * gradient's direction vector. CSS measures the angle clockwise from "to top",
 * a quarter turn from the matrix's own frame.
 */
function gradientAngle(transform: Transform): number {
  const [a, b] = [transform[0][0], transform[0][1]]
  const degrees = (Math.atan2(b, a) * 180) / Math.PI + 90
  return Math.round(((degrees % 360) + 360) % 360)
}

function gradientStops(paint: GradientPaint): string {
  return paint.gradientStops
    .map((stop) => {
      const alpha = stop.color.a
      const color = alpha >= 1 ? hex(stop.color) : rgba(stop.color, alpha)
      return `${color} ${pct(stop.position)}`
    })
    .join(', ')
}

function background(paints: readonly Paint[] | typeof figma.mixed): string | null {
  if (paints === figma.mixed || paints.length === 0) return null
  const paint = paints.find((entry) => entry.visible !== false)
  if (!paint) return null
  if (paint.type === 'SOLID') return colorOf(paint)
  if (paint.type === 'GRADIENT_LINEAR') {
    return `linear-gradient(${gradientAngle(paint.gradientTransform)}deg, ${gradientStops(paint)})`
  }
  if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') {
    return `radial-gradient(${gradientStops(paint)})`
  }
  if (paint.type === 'IMAGE') return 'url(image.png)'
  return null
}

function radius(node: SceneNode): string | null {
  if (!('cornerRadius' in node)) return null
  const corner = node.cornerRadius
  if (typeof corner === 'number') return corner > 0 ? px(corner) : null
  if (corner !== figma.mixed) return null
  const frame = node as FrameNode
  const corners = [
    frame.topLeftRadius,
    frame.topRightRadius,
    frame.bottomRightRadius,
    frame.bottomLeftRadius,
  ]
  return corners.some((value) => value > 0) ? corners.map(px).join(' ') : null
}

function border(node: SceneNode): string | null {
  if (!('strokes' in node) || node.strokes.length === 0) return null
  const stroke = node.strokes.find((entry) => entry.visible !== false)
  if (!stroke || stroke.type !== 'SOLID') return null
  const thickness = 'strokeWeight' in node && node.strokeWeight !== figma.mixed ? node.strokeWeight : 1
  return `${weight(thickness)} solid ${colorOf(stroke)}`
}

function shadows(node: SceneNode): string | null {
  if (!('effects' in node)) return null
  const casts = node.effects.filter(
    (effect): effect is DropShadowEffect | InnerShadowEffect =>
      (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') && effect.visible !== false,
  )
  if (casts.length === 0) return null
  return casts
    .map((effect) => {
      const inset = effect.type === 'INNER_SHADOW' ? 'inset ' : ''
      const spread = effect.spread ? ` ${px(effect.spread)}` : ' 0px'
      return `${inset}${px(effect.offset.x)} ${px(effect.offset.y)} ${px(effect.radius)}${spread} ${rgba(effect.color, effect.color.a)}`
    })
    .join(', ')
}

function padding(frame: BaseFrameMixin): string | null {
  const top = frame.paddingTop
  const right = frame.paddingRight
  const bottom = frame.paddingBottom
  const left = frame.paddingLeft
  if (top === bottom && left === right) {
    return top === left ? px(top) : `${px(top)} ${px(left)}`
  }
  return `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`
}

const JUSTIFY: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
}

const ALIGN: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  BASELINE: 'baseline',
}

function hasAutoLayout(node: SceneNode): node is SceneNode & BaseFrameMixin {
  return 'layoutMode' in node && node.layoutMode !== 'NONE'
}

/** Groups are transparent for positioning: only a frame is a containing block. */
function isFrameLike(node: BaseNode): boolean {
  return (
    node.type === 'FRAME' ||
    node.type === 'INSTANCE' ||
    node.type === 'COMPONENT' ||
    node.type === 'COMPONENT_SET'
  )
}

type Axis = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE'

/**
 * Offsets are measured against the containing frame, which is what Figma's
 * constraints are relative to. A group in between contributes nothing, so
 * absolute bounding boxes are used rather than parent-relative coordinates.
 */
function absoluteGeometry(node: SceneNode, frame: SceneNode): string[] {
  const box = node.absoluteBoundingBox
  const frameBox = frame.absoluteBoundingBox
  if (!box || !frameBox) return ['position: absolute;', `width: ${px(node.width)};`, `height: ${px(node.height)};`]

  const x = box.x - frameBox.x
  const y = box.y - frameBox.y

  // Groups carry no constraints of their own; Figma centres them in the export.
  const constraints =
    'constraints' in node ? node.constraints : { horizontal: 'CENTER' as Axis, vertical: 'CENTER' as Axis }
  const horizontal = constraints.horizontal as Axis
  const vertical = constraints.vertical as Axis
  const spansX = horizontal === 'STRETCH' || horizontal === 'SCALE'
  const spansY = vertical === 'STRETCH' || vertical === 'SCALE'

  const sizes: string[] = []
  if (!spansX) sizes.push(`width: ${px(box.width)};`)
  if (!spansY) sizes.push(`height: ${px(box.height)};`)

  const offsets: string[] = []
  if (spansX) {
    offsets.push(`left: ${pct(x / frameBox.width)};`)
    offsets.push(`right: ${pct((frameBox.width - x - box.width) / frameBox.width)};`)
  } else if (horizontal === 'MAX') {
    offsets.push(`right: ${px(frameBox.width - x - box.width)};`)
  } else if (horizontal === 'CENTER') {
    const delta = x + box.width / 2 - frameBox.width / 2
    offsets.push(
      `left: calc(50% - ${px(box.width)}/2 ${delta < 0 ? '-' : '+'} ${px(Math.abs(delta))});`,
    )
  } else {
    offsets.push(`left: ${px(x)};`)
  }

  if (spansY) {
    offsets.push(`top: ${pct(y / frameBox.height)};`)
    offsets.push(`bottom: ${pct((frameBox.height - y - box.height) / frameBox.height)};`)
  } else if (vertical === 'MAX') {
    offsets.push(`bottom: ${px(frameBox.height - y - box.height)};`)
  } else if (vertical === 'CENTER') {
    const delta = y + box.height / 2 - frameBox.height / 2
    offsets.push(
      `top: calc(50% - ${px(box.height)}/2 ${delta < 0 ? '-' : '+'} ${px(Math.abs(delta))});`,
    )
  } else {
    offsets.push(`top: ${px(y)};`)
  }

  return ['position: absolute;', ...sizes, ...offsets]
}

function lineHeightOf(node: TextNode): { value: string; comment: string | null } | null {
  const lineHeight = node.lineHeight
  if (lineHeight === figma.mixed || lineHeight.unit === 'AUTO') return null
  const fontSize = node.fontSize === figma.mixed ? 0 : node.fontSize
  if (lineHeight.unit === 'PERCENT') {
    return { value: `${trim(lineHeight.value)}%`, comment: null }
  }
  const ratio = fontSize > 0 ? Math.round((lineHeight.value / fontSize) * 100) : 0
  const identical = Math.abs(lineHeight.value - node.height) < 0.5
  const comment = ratio > 0 ? `${identical ? 'identical to box height, or ' : ''}${ratio}%` : null
  return { value: px(lineHeight.value), comment }
}

async function textBlock(node: TextNode): Promise<string[]> {
  const lines: string[] = []

  if (node.textStyleId !== figma.mixed && node.textStyleId !== '') {
    try {
      const style = await figma.getStyleByIdAsync(node.textStyleId)
      if (style) lines.push(`/* ${style.name} */`)
    } catch {
      // A remote or deleted text style just means no comment.
    }
  }

  const font = node.fontName === figma.mixed ? node.getRangeFontName(0, 1) : node.fontName
  if (font !== figma.mixed) {
    lines.push(`font-family: '${font.family}';`)
    lines.push(`font-style: ${font.style.toLowerCase().indexOf('italic') === -1 ? 'normal' : 'italic'};`)
  }
  const weight = node.fontWeight
  if (weight !== figma.mixed) lines.push(`font-weight: ${weight};`)
  if (node.fontSize !== figma.mixed) lines.push(`font-size: ${px(node.fontSize)};`)

  const lineHeight = lineHeightOf(node)
  if (lineHeight) {
    lines.push(`line-height: ${lineHeight.value};`)
    if (lineHeight.comment) lines.push(`/* ${lineHeight.comment} */`)
  }

  if (node.letterSpacing !== figma.mixed && node.letterSpacing.value !== 0) {
    const spacing = node.letterSpacing
    lines.push(
      `letter-spacing: ${spacing.unit === 'PERCENT' ? `${trim(spacing.value)}em` : px(spacing.value)};`,
    )
  }

  const color = background(node.fills)
  if (color) lines.push(`color: ${color};`)
  return lines
}

type Block = { name: string; lines: string[] }

async function describe(
  node: SceneNode,
  parent: SceneNode | null,
  index: number,
  frame: SceneNode | null,
): Promise<Block> {
  const lines: string[] = []

  // A stroke makes Figma switch the box model, and it says so before anything
  // else — except on vectors, where the stroke does not grow the box.
  if (border(node) !== null && node.type !== 'VECTOR') {
    lines.push('box-sizing: border-box;')
    lines.push('')
  }

  if (hasAutoLayout(node)) {
    lines.push('/* Auto layout */')
    lines.push('display: flex;')
    lines.push(`flex-direction: ${node.layoutMode === 'VERTICAL' ? 'column' : 'row'};`)
    if (node.primaryAxisAlignItems !== 'MIN') {
      lines.push(`justify-content: ${JUSTIFY[node.primaryAxisAlignItems]};`)
    }
    lines.push(`align-items: ${ALIGN[node.counterAxisAlignItems]};`)
    const pad = padding(node)
    if (pad) lines.push(`padding: ${pad};`)
    if (node.itemSpacing > 0) lines.push(`gap: ${px(node.itemSpacing)};`)
    lines.push('')
  }

  const parentIsAutoLayout = parent !== null && hasAutoLayout(parent)

  // Hidden layers are exported, not dropped: Figma turns them off in CSS instead,
  // and they still occupy their slot in the parent's order.
  if (!node.visible) lines.push('display: none;')

  if (!parentIsAutoLayout && frame !== null) {
    lines.push(...absoluteGeometry(node, frame))
    lines.push('')
  } else {
    lines.push(`width: ${px(node.width)};`)
    lines.push(`height: ${px(node.height)};`)
    lines.push('')
  }

  if (node.type === 'TEXT') {
    lines.push(...(await textBlock(node)))
    lines.push('')
  } else {
    const paints = 'fills' in node ? background(node.fills) : null
    if (paints) lines.push(`background: ${paints};`)
    const stroke = border(node)
    if (stroke) lines.push(`border: ${stroke};`)
    const corner = radius(node)
    if (corner) lines.push(`border-radius: ${corner};`)
    const shadow = shadows(node)
    if (shadow) lines.push(`box-shadow: ${shadow};`)
    if ('opacity' in node && node.opacity < 1) lines.push(`opacity: ${trim(node.opacity)};`)
    if (lines[lines.length - 1] !== '') lines.push('')
  }

  if (parentIsAutoLayout) {
    lines.push('/* Inside auto layout */')
    lines.push('flex: none;')
    lines.push(`order: ${index};`)
    if ('layoutAlign' in node && node.layoutAlign === 'STRETCH') lines.push('align-self: stretch;')
    lines.push(`flex-grow: ${'layoutGrow' in node ? node.layoutGrow : 0};`)
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { name: node.name, lines }
}

/**
 * Walks the whole subtree, instances included, because the legacy export does
 * not treat an instance as a boundary.
 */
export async function renderFigmaCss(root: SceneNode, rootOnly = false): Promise<string> {
  const blocks: Block[] = []
  let truncated = false

  const walk = async (
    node: SceneNode,
    parent: SceneNode | null,
    index: number,
    frame: SceneNode | null,
  ): Promise<void> => {
    if (blocks.length >= MAX_NODES) {
      truncated = true
      return
    }
    blocks.push(await describe(node, parent, index, frame))
    // Compared against the root itself, not against a null parent: the root is
    // deliberately handed its real parent so its "Inside auto layout" block can
    // be worked out, so a null parent only ever meant "selected straight off the
    // page" and left topLayerOnly doing nothing everywhere else.
    if (rootOnly && node === root) return
    if ('children' in node) {
      // A frame becomes the containing block for everything below it; a group
      // passes its own containing block straight through.
      const childFrame = isFrameLike(node) ? node : frame
      const children = node.children
      for (let position = 0; position < children.length; position++) {
        await walk(children[position], node, position, childFrame)
      }
    }
  }

  // The root's own "Inside auto layout" block needs its real parent, which the
  // caller does not pass: a node knows it.
  const rootParent = root.parent
  const rootIsScene = rootParent !== null && 'children' in rootParent
  const siblings = rootIsScene ? (rootParent.children as readonly SceneNode[]) : []
  const rootIndex = Math.max(0, siblings.indexOf(root))
  const parentForRoot = rootIsScene && rootParent.type !== 'PAGE' ? (rootParent as SceneNode) : null
  const frameForRoot =
    parentForRoot !== null && !isFrameLike(parentForRoot) ? null : parentForRoot

  await walk(root, parentForRoot, rootIndex, frameForRoot)

  const out = blocks
    .map((block) => `/* ${block.name} */\n\n${block.lines.join('\n')}\n`)
    .join('\n\n')

  return truncated ? `${out}\n\n/* Stopped after ${MAX_NODES} layers. */` : out
}
