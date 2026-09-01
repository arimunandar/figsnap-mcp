// The layer types a search may ask for.
//
// Two sandboxes need this list and neither can import the other's: the daemon
// puts it in the `figma_find_nodes` schema, so a harness is shown what it may
// ask for, and the plugin checks against it, because Figma throws on a type it
// does not recognise and the thrown message does not say what would have
// worked. A list that drifted between them would refuse something the schema
// had just advertised.
//
// Not every NodeType — the ones a designer would search for. Absent on purpose:
// PAGE and DOCUMENT, which `figma_pages` covers, and SLICE, STICKY, WIDGET and
// the FigJam shapes, which this plugin does not read.

export const FINDABLE_TYPES = [
  'FRAME',
  'GROUP',
  'SECTION',
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'TEXT',
  'RECTANGLE',
  'ELLIPSE',
  'POLYGON',
  'STAR',
  'LINE',
  'VECTOR',
  'BOOLEAN_OPERATION',
]
