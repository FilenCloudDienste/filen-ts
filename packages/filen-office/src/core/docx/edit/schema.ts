import {
	Fragment,
	Mark,
	Schema,
	type Attrs,
	type MarkSpec,
	type MarkType,
	type Node,
	type NodeSpec,
	type NodeType
} from "prosemirror-model"

// The editing schema of one DOCX story. Nodes built from the file carry `src`, the model item they came
// from in the story's part (-1 for content the editor created); a writer re-emits a block whose node is
// still the one the builder made from its source bytes, and rebuilds only the others. Everything the
// editor cannot change is an atom that keeps its item, so its bytes are copied wherever it ends up.

export const NO_SOURCE = -1

// Range markers: zero-width points that must survive any edit (bookmarks, comment ranges, move ranges,
// editing permissions, custom XML ranges). "commentReference" only appears in survivor lists: the visible
// reference is a comment_ref node.
export type MarkerKind =
	| "bookmarkStart"
	| "bookmarkEnd"
	| "commentRangeStart"
	| "commentRangeEnd"
	| "moveFromRangeStart"
	| "moveFromRangeEnd"
	| "moveToRangeStart"
	| "moveToRangeEnd"
	| "permissionStart"
	| "permissionEnd"
	| "customXmlRange"
	| "commentReference"

export interface MarkerAttrs {
	readonly src: number
	readonly kind: MarkerKind
	// w:id as written (undefined ids are keyed by their item).
	readonly id: string | null
}

// A marker node's attributes: a new bookmark or move range start also has its name (a source one keeps it in
// its bytes), a new move range start its author and date (CT_MoveBookmark).
export interface MarkerNodeAttrs extends MarkerAttrs {
	readonly name: string | null
	readonly author?: string | null
	readonly date?: string | null
}

// The attributes of a marker node standing for `marker` (one of a list, or a node's own).
export function markerNodeAttrs(marker: MarkerAttrs): MarkerNodeAttrs {
	const own = marker as Partial<MarkerNodeAttrs>

	return { src: marker.src, kind: marker.kind, id: marker.id, name: own.name ?? null, author: own.author ?? null, date: own.date ?? null }
}

export type MarkerList = readonly MarkerAttrs[]

export const NO_MARKERS: MarkerList = Object.freeze([])

// Why a block cannot be edited: it is kept as its source bytes and shown read-only.
export type LockReason =
	// An element the model does not read at block level.
	| "opaque"
	| "altChunk"
	// A block-level customXml, revision or AlternateContent wrapper around blocks.
	| "blockWrapper"
	// Rows or cells hold something other than rows, cells and markers, or are empty.
	| "tableStructure"
	// A complex field inside the paragraph whose begin, separate and end are not whole sibling runs.
	| "fieldStructure"
	// A complex field that starts and ends in different paragraphs (a table of contents).
	| "fieldSpansBlocks"
	| "malformed"
	// A content control whose content is locked (w:lock contentLocked / sdtContentLocked).
	| "contentLocked"
	// Something the round-trip proof could not reproduce.
	| "unmodelled"
	| "proof"

export type LockedKind = "paragraph" | "table" | "sdt" | "element"

// How a paragraph's content sits in the XML: inside a w:r (and takes the run's formatting) or directly in
// the paragraph next to runs (markers, fields, math, unknown elements).
export type InlineLevel = "run" | "paragraph"

export interface IndentAttrs {
	readonly start?: number
	readonly startChars?: number
	readonly end?: number
	readonly endChars?: number
	readonly hanging?: number
	readonly hangingChars?: number
	readonly firstLine?: number
	readonly firstLineChars?: number
}

// w:spacing as written (twips; *Lines in hundredths of a line; line in 240ths of a line when lineRule is auto).
export interface SpacingAttrs {
	readonly before?: number
	readonly beforeLines?: number
	readonly beforeAutospacing?: boolean
	readonly after?: number
	readonly afterLines?: number
	readonly afterAutospacing?: boolean
	readonly line?: number
	readonly lineRule?: "auto" | "exact" | "atLeast"
}

export interface ColorAttrs {
	readonly value: string | null
	readonly themeColor: string | null
	readonly themeTint: number | null
	readonly themeShade: number | null
}

// Node marks of paragraphs (and of locked blocks standing for them) in block containers.
const BLOCK_MARKS = "para_id paragraph_change section_change"
// What text and inline atoms may carry: every mark but the node marks of blocks.
const INLINE_MARKS =
	"link insertion deletion move_from move_to content_control wrapper run plain char_style bold italic underline strike " +
	"double_strike caps small_caps vert_align color highlight shading font size spacing lang no_proof web_hidden format_change"

const src = { default: NO_SOURCE }
const before = { default: NO_MARKERS }
const end = { default: NO_MARKERS }
const nil = { default: null }

const nodes = {
	// A story: the body, a header or footer, a note or a comment. `sectPr` is the body's final section
	// properties item; `end` the markers after the last block. Changed only through DocAttrStep by feature
	// commands (so they undo with the story): `comments`, overrides of the document's comments by id
	// (resolved, parent, author...; null: none), and `sectionChanges`, edits to the final section's
	// properties (null: none).
	doc: {
		content: "block+",
		marks: BLOCK_MARKS,
		attrs: { story: { default: -1 }, sectPr: src, end, comments: nil, sectionChanges: nil }
	},
	// w:p. Direct paragraph properties that commands edit are attributes; everything else in w:pPr stays in
	// the source bytes. `sectPr` is the item of the paragraph whose w:pPr holds the section break this
	// paragraph ends (it moves with the paragraph mark when the paragraph splits). `revision` holds the
	// mark's RevisionFlag bits. What feature commands record on a paragraph are node marks (para_id,
	// paragraph_change, section_change), which cost nothing on the paragraphs without them.
	paragraph: {
		group: "block",
		content: "inline*",
		marks: INLINE_MARKS,
		attrs: {
			src,
			before,
			styleId: nil,
			numId: nil,
			ilvl: nil,
			align: nil,
			indent: nil,
			spacing: nil,
			borders: nil,
			// Tab stops a command set (TabStop[]: a table of contents' right tab); null: as the source has them.
			tabs: nil,
			sectPr: src,
			revision: { default: 0 }
		}
	},
	// w:tbl, w:tr, w:tc, one node per element. Merged cells keep their w:vMerge continuation cells, so the
	// grid stays the file's; colspan is w:gridSpan and rowspan is always 1. colwidth comes from w:tblGrid.
	// Properties table commands change (alignment, widths, header row, shading, vertical alignment...): the
	// table's `props` (null: as the source has them), and on rows and cells the node marks row_props and
	// cell_props (none on most of the many rows and cells).
	table: {
		group: "block",
		content: "table_row+",
		isolating: true,
		tableRole: "table",
		marks: "row_props",
		attrs: { src, before, end, styleId: nil, grid: { default: [] }, props: nil }
	},
	table_row: {
		content: "table_cell+",
		tableRole: "row",
		marks: "cell_props",
		attrs: { src, before, end, revision: { default: 0 } }
	},
	table_cell: {
		content: "block+",
		isolating: true,
		tableRole: "cell",
		marks: BLOCK_MARKS,
		attrs: {
			src,
			before,
			end,
			colspan: { default: 1 },
			rowspan: { default: 1 },
			colwidth: nil,
			vMerge: nil,
			revision: { default: 0 }
		}
	},
	// Block-level w:sdt (content control). `lock` is w:lock as written ("sdtLocked" keeps the control from
	// being deleted; content-locked controls are locked blocks instead). `state`: what form commands changed
	// (checked, chosen value, date, placeholder shown); null: as the source has it.
	sdt: {
		group: "block",
		content: "block+",
		isolating: true,
		marks: BLOCK_MARKS,
		attrs: { src, before, end, type: { default: "richText" }, lock: nil, state: nil }
	},
	// A block kept as its source bytes: unmodelled block-level elements and locked islands. `markers` are
	// the range markers and comment references inside it, which outlive its deletion; `deletable` is false
	// when removing it would break structure elsewhere (a section break, a field spanning paragraphs).
	locked_block: {
		group: "block",
		atom: true,
		selectable: true,
		attrs: {
			src,
			before,
			kind: { default: "element" },
			reason: { default: "opaque" },
			text: { default: "" },
			markers: { default: NO_MARKERS },
			deletable: { default: true },
			sectPr: src
		}
	},
	text: { group: "inline" },
	// w:tab.
	tab: { group: "inline", inline: true, atom: true, docxLevel: "run", attrs: { src } },
	// w:br (type textWrapping/page/column, clear) and w:cr.
	break: {
		group: "inline",
		inline: true,
		atom: true,
		docxLevel: "run",
		attrs: { src, type: { default: "textWrapping" }, clear: { default: "none" }, cr: { default: false } }
	},
	// w:softHyphen and w:noBreakHyphen.
	hyphen: { group: "inline", inline: true, atom: true, docxLevel: "run", attrs: { src, soft: { default: true } } },
	// w:sym: a code point (often in the private use area) in a symbol font.
	symbol: { group: "inline", inline: true, atom: true, docxLevel: "run", attrs: { src, char: { default: 0 }, font: nil } },
	// w:footnoteReference / w:endnoteReference; `custom`: a new one followed by the custom mark Word shows
	// instead of the number (w:customMarkFollows).
	note_ref: {
		group: "inline",
		inline: true,
		atom: true,
		docxLevel: "run",
		attrs: { src, kind: { default: "footnote" }, id: nil, custom: { default: false } }
	},
	// w:commentReference: zero-width, survives deletion like a range marker.
	comment_ref: {
		group: "inline",
		inline: true,
		atom: true,
		selectable: false,
		docxLevel: "run",
		attrs: { src, id: nil }
	},
	// w:drawing, w:pict, w:object, or the mc:AlternateContent around one (`src`); `index` is the model's
	// DrawingInfo (kind "drawing") or VmlInfo index, -1 when none was read. `overrides`: what drawing
	// commands set (DrawingOverrides), null when the drawing is as the source has it.
	drawing: {
		group: "inline",
		inline: true,
		atom: true,
		docxLevel: "run",
		attrs: {
			src,
			kind: { default: "drawing" },
			index: { default: -1 },
			anchored: { default: false },
			markers: { default: NO_MARKERS },
			overrides: nil
		}
	},
	// Any other run content (positional tab, ruby, page number, note marks, stray field characters, unknown
	// run children), kept as its bytes. `kind` is the model item name.
	run_object: {
		group: "inline",
		inline: true,
		atom: true,
		docxLevel: "run",
		attrs: { src, kind: { default: "Opaque" }, text: { default: "" }, markers: { default: NO_MARKERS } }
	},
	// A complex field (fldChar begin … end, `src` the begin run and `end` the end run, siblings) or a
	// w:fldSimple (`src` = `end`), kept as its bytes and shown as its cached result. Deleted whole. `state`: the
	// value form commands set on a legacy form field (forms/controls.ts LegacyFieldState); null: as the source
	// has it. `update`: an update of its result made while tracking changes (fields/result.ts FieldUpdate: the
	// result before, who and when, written as w:del and w:ins), null without one.
	field: {
		group: "inline",
		inline: true,
		atom: true,
		docxLevel: "paragraph",
		attrs: {
			src,
			end: src,
			simple: { default: false },
			type: { default: "" },
			instruction: { default: "" },
			result: { default: "" },
			markers: { default: NO_MARKERS },
			state: nil,
			update: nil
		}
	},
	// A range marker inside a paragraph (see MarkerKind); `name` is a new bookmark's or move range's w:name,
	// `author` and `date` a new move range start's.
	marker: {
		group: "inline",
		inline: true,
		atom: true,
		selectable: false,
		docxLevel: "paragraph",
		attrs: { src, kind: { default: "bookmarkStart" }, id: nil, name: nil, author: nil, date: nil }
	},
	// m:oMath / m:oMathPara inside a paragraph; `omml` the equation's new XML (null: as the source has it).
	math: {
		group: "inline",
		inline: true,
		atom: true,
		docxLevel: "paragraph",
		attrs: { src, display: { default: false }, markers: { default: NO_MARKERS }, omml: nil }
	},
	// A w:fldChar of a field spanning paragraphs (a table of contents) or one without partners: `kind` begin,
	// separate or end, or "instruction" ("deletedInstruction") for a w:instrText (w:delInstrText) of a table of
	// contents of the file; the begin holds the field's instruction and whether Word should update it (w:dirty),
	// an instruction text its own text. One of the file's (`src`) is written as its bytes.
	field_char: {
		group: "inline",
		inline: true,
		atom: true,
		selectable: false,
		docxLevel: "run",
		attrs: { src, kind: { default: "begin" }, instruction: { default: "" }, dirty: { default: false } }
	},
	// Word's bookkeeping marks, zero width: w:proofErr (paragraph level; `node` is its XML node, it is no
	// model item) and w:lastRenderedPageBreak (inside a run). Kept so stretches of unchanged runs in an
	// edited paragraph stay byte-exact; a writer may drop them next to edited text (Word regenerates both).
	proof_err: {
		group: "inline",
		inline: true,
		atom: true,
		selectable: false,
		docxLevel: "paragraph",
		attrs: { node: src }
	},
	rendered_break: {
		group: "inline",
		inline: true,
		atom: true,
		selectable: false,
		docxLevel: "run",
		attrs: { src }
	},
	// Anything else at paragraph level (unknown elements, mc:AlternateContent around runs), as its bytes.
	opaque_inline: {
		group: "inline",
		inline: true,
		atom: true,
		docxLevel: "paragraph",
		attrs: { src, kind: { default: "Opaque" }, text: { default: "" }, markers: { default: NO_MARKERS } }
	}
} satisfies Record<string, NodeSpec>

const wrapper = (extra: MarkSpec["attrs"]): MarkSpec => ({ inclusive: false, excludes: "", attrs: { src, ...extra } })
const value = { value: nil }
const colorAttrs = { value: nil, themeColor: nil, themeTint: nil, themeShade: nil }

// Mark order is nesting rank: wrappers first, then the run's source formatting, then its direct
// properties. A writer recovers the source nesting of wrapper elements from the model's item parents.
const marks = {
	// w:hyperlink; `target` is the relationship target as written (never fetched). targetFrame, history and
	// docLocation are carried over from a link of the file a command replaced.
	link: {
		inclusive: false,
		attrs: { src, anchor: nil, target: nil, tooltip: nil, targetFrame: nil, history: nil, docLocation: nil }
	},
	// w:ins / w:del / w:moveFrom / w:moveTo wrappers. Text under deletion or moveFrom is w:delText.
	insertion: wrapper({ id: nil, author: nil, date: nil }),
	deletion: wrapper({ id: nil, author: nil, date: nil }),
	move_from: wrapper({ id: nil, author: nil, date: nil }),
	move_to: wrapper({ id: nil, author: nil, date: nil }),
	// Run-level w:sdt; `state` as the block control's.
	content_control: wrapper({ type: { default: "richText" }, state: nil }),
	// w:smartTag, w:customXml, w:dir, w:bdo.
	wrapper: wrapper({ kind: { default: "customXml" }, rtl: { default: false } }),
	// The source w:r (`src`, so adjacent runs never merge and an unchanged run is written as its bytes) and
	// the w:rPr it was formatted with (`base`, an id in the session's RunBases, -1 for none). Text typed in
	// a run inherits this mark. The marks below hold the base's editable properties; a writer splices only
	// the ones that differ from the base into a copy of its bytes.
	run: { attrs: { src, base: { default: -1 } } },
	// Direct formatting cleared (Ctrl+Space): the base counts only for w:rtl and w:cs; w:rPr is written
	// from the marks alone.
	plain: { attrs: {} },
	char_style: { attrs: { styleId: { default: "" } } },
	// Toggles: true/false as written (false switches off a style's value); null where only the other
	// script's element is present.
	bold: { attrs: { value: nil, cs: nil } },
	italic: { attrs: { value: nil, cs: nil } },
	underline: { attrs: { style: { default: "single" }, ...colorAttrs } },
	strike: { attrs: value },
	double_strike: { attrs: value },
	caps: { attrs: value },
	small_caps: { attrs: value },
	vert_align: { attrs: value },
	color: { attrs: colorAttrs },
	highlight: { attrs: value },
	shading: { attrs: { pattern: { default: "clear" }, color: nil, fill: nil } },
	font: {
		attrs: {
			ascii: nil,
			hAnsi: nil,
			eastAsia: nil,
			cs: nil,
			asciiTheme: nil,
			hAnsiTheme: nil,
			eastAsiaTheme: nil,
			csTheme: nil,
			hint: nil
		}
	},
	// Half-points.
	size: { attrs: { value: nil, cs: nil } },
	// Character spacing, twips.
	spacing: { attrs: value },
	lang: { attrs: { latin: nil, eastAsia: nil, bidi: nil } },
	// w:noProof (no spelling or grammar checks) and w:webHidden (hidden in Web layout: a table of contents' tabs
	// and page numbers under \z), true/false as written.
	no_proof: { attrs: value },
	web_hidden: { attrs: value },
	// w:rPrChange: in the base (a tracked formatting change read from the file, `base` null), or recorded by
	// the editor with the run properties before it (`base`, an id in the session's RunBases) and, when the
	// change replaced the run itself (the format painter), the run before (`run`: its attributes, or false for
	// none).
	format_change: { attrs: { id: nil, author: nil, date: nil, base: nil, run: nil } },
	// Node marks feature commands set on blocks (never on inline content): a paragraph's new w14:paraId
	// (`id`, eight hex digits); and, each `value` an object of the changed properties, a paragraph's
	// properties before a tracked change (w:pPrChange), edits to the section properties a paragraph carries
	// (`value` names its section: equal marks on two paragraphs are a split's halves), a row's or a cell's
	// property overrides. Copies of a paragraph (a paste, a split's new half) do not keep them.
	para_id: { attrs: { id: { default: "" } } },
	paragraph_change: { attrs: value },
	section_change: { attrs: value },
	row_props: { attrs: value },
	cell_props: { attrs: value }
} satisfies Record<string, MarkSpec>

export const docxSchema = new Schema({ nodes, marks })

// Node marks of blocks (see BLOCK_MARKS): only feature commands set them.
export const BLOCK_NODE_MARKS: readonly DocxMarkName[] = ["para_id", "paragraph_change", "section_change", "row_props", "cell_props"]

// What drawing commands override on a drawing (EMUs for sizes and offsets); absent: as the source has it.
export interface DrawingOverrides {
	readonly cx?: number
	readonly cy?: number
	readonly posX?: number
	readonly posY?: number
	readonly relH?: string
	readonly relV?: string
	readonly wrap?: string
	readonly descr?: string
	// The handle (DocxMediaStore) of a new picture's bytes.
	readonly media?: number
	// Degrees clockwise (0, 90, 180, 270).
	readonly rot?: number
	// A new picture's wp:docPr id (allocated when inserted, so every write of it agrees).
	readonly docPr?: number
	// A new SVG picture's PNG (media handle), what Word shows where it cannot draw SVG.
	readonly fallback?: number
}

// The marks inline content may carry (for a check that every mark is either inline or a block's).
export const INLINE_MARK_NAMES: readonly string[] = INLINE_MARKS.split(" ")

export type DocxSchema = typeof docxSchema

// Mark types a formatting command or the writer edits (direct run properties).
export type DocxMarkName = keyof typeof marks
export type DocxNodeName = keyof typeof nodes

export const FORMATTING_MARKS: readonly DocxMarkName[] = [
	"plain",
	"char_style",
	"bold",
	"italic",
	"underline",
	"strike",
	"double_strike",
	"caps",
	"small_caps",
	"vert_align",
	"color",
	"highlight",
	"shading",
	"font",
	"size",
	"spacing",
	"lang",
	"no_proof",
	"web_hidden"
]

// A run's own formatting: the formatting marks and its source run properties (scale, kerning, position).
export const RUN_FORMATTING: ReadonlySet<MarkType> = new Set([
	...FORMATTING_MARKS.map(name => docxSchema.marks[name]),
	docxSchema.marks.run
])

// Source revision wrappers.
export const REVISION_MARKS: readonly DocxMarkName[] = ["insertion", "deletion", "move_from", "move_to"]

// Marks that place content inside source elements: all a paragraph-level atom may carry (with `run` for a
// marker written inside a w:r).
export const WRAPPER_MARKS: readonly DocxMarkName[] = [
	"link",
	"insertion",
	"deletion",
	"move_from",
	"move_to",
	"content_control",
	"wrapper"
]

type NodeConstructor = new (type: NodeType, attrs: Attrs, content: Fragment, marks: readonly Mark[]) => Node
type MarkConstructor = new (type: MarkType, attrs: Attrs) => Mark

// NodeType.create and MarkType.create copy attributes into a null-prototype object, which V8 keeps as a
// dictionary (about 480 bytes for a paragraph's nine attributes against about 100 for a plain object). A
// document has a node per paragraph, cell, run and atom, so the builder constructs them from complete
// attribute objects directly, as ProseMirror's own copy() does. The constructors are checked once against
// create() on a leaf, a node with content and a mark; should they ever differ, create() is used.
const runProbe = docxSchema.marks.run.create({ src: 1, base: 0 })
const leafProbe = docxSchema.nodes.tab.create({ src: 1 }, null, [runProbe])
const textProbe = docxSchema.text("ab", [runProbe])
const NodeClass = leafProbe.constructor as NodeConstructor
const MarkClass = runProbe.constructor as MarkConstructor
const direct = (() => {
	try {
		const mark = new MarkClass(docxSchema.marks.run, { src: 1, base: 0 })
		const leaf = new NodeClass(docxSchema.nodes.tab, { src: 1 }, Fragment.empty, [mark])
		const paragraphAttrs = docxSchema.nodes.paragraph.create().attrs
		const expected = docxSchema.nodes.paragraph.create(paragraphAttrs, [textProbe, leafProbe])
		const made = new NodeClass(docxSchema.nodes.paragraph, { ...paragraphAttrs }, Fragment.fromArray([textProbe, leaf]), Mark.none)

		return (
			mark.eq(runProbe) &&
			leaf.eq(leafProbe) &&
			made.eq(expected) &&
			made.nodeSize === expected.nodeSize &&
			made.child(1).isAtom &&
			made.textContent === "ab" &&
			Object.getPrototypeOf(made) === Object.getPrototypeOf(expected) &&
			Object.getPrototypeOf(mark) === Object.getPrototypeOf(runProbe)
		)
	} catch {
		return false
	}
})()

// A node from an attribute object that holds every attribute of `type` (callers keep the spec's order, so
// nodes of one type share a hidden class). `content` is copied to an exactly sized array.
export function makeNode(type: NodeType, attrs: Attrs, content: readonly Node[] | null = null, marks: readonly Mark[] = Mark.none): Node {
	if (!direct) return type.create(attrs, content === null ? null : Fragment.fromArray(content.slice()), marks)

	return new NodeClass(
		type,
		attrs,
		content === null || content.length === 0 ? Fragment.empty : Fragment.fromArray(content.slice()),
		marks
	)
}

// A mark from an attribute object that holds every attribute of `type`.
export function makeMark(type: MarkType, attrs: Attrs): Mark {
	return direct ? new MarkClass(type, attrs) : type.create(attrs)
}

const runLevel = new Set<NodeType>()
const paragraphLevel = new Set<NodeType>()

for (const type of Object.values(docxSchema.nodes)) {
	const level: unknown = type.spec["docxLevel"]

	if (level === "run") runLevel.add(type)
	else if (level === "paragraph") paragraphLevel.add(type)
}

runLevel.add(docxSchema.nodes.text)

// Whether a container's effective last block (through content controls) is a table: Word wants a cell to
// end with a paragraph.
export function endsWithTable(container: Node): boolean {
	return tableEdge(container.lastChild, true)
}

// Whether a block is a table at its end (`end`) or start: a table, a locked one, or a block control ending
// (starting) with one. Word and LibreOffice show two such edges with no paragraph between them as one table.
export function tableEdge(block: Node | null, end: boolean): boolean {
	let node = block

	while (node !== null && node.type === docxSchema.nodes.sdt) node = end ? node.lastChild : node.firstChild

	return (
		node !== null &&
		(node.type === docxSchema.nodes.table || (node.type === docxSchema.nodes.locked_block && node.attrs["kind"] === "table"))
	)
}

// Where an inline node sits in the XML (text included); undefined for blocks.
export function inlineLevel(node: Node): InlineLevel | undefined {
	return runLevel.has(node.type) ? "run" : paragraphLevel.has(node.type) ? "paragraph" : undefined
}

// Inline nodes a range marker or comment reference must outlive: they and every atom listing survivors.
export function survivorsOf(node: Node): MarkerList {
	const type = node.type.name

	if (type === "marker") {
		const marker: MarkerAttrs = {
			src: node.attrs["src"] as number,
			kind: node.attrs["kind"] as MarkerKind,
			id: node.attrs["id"] as string | null
		}
		const name = node.attrs["name"] as string | null
		const author = node.attrs["author"] as string | null

		// A new bookmark's name, a new move range start's name, author and date (a source one has them in its bytes).
		if (name === null) return [marker]

		return [
			(author === null
				? { ...marker, name }
				: { ...marker, name, author, date: node.attrs["date"] as string | null }) as MarkerNodeAttrs
		]
	}
	if (type === "comment_ref")
		return [{ src: node.attrs["src"] as number, kind: "commentReference", id: node.attrs["id"] as string | null }]

	const markers: unknown = node.attrs["markers"]

	return Array.isArray(markers) ? (markers as MarkerList) : NO_MARKERS
}

// One key per marker: kind and w:id, or the source item when there is no id.
export function markerKey(marker: MarkerAttrs): string {
	return marker.id === null ? `${marker.kind}#${marker.src}` : `${marker.kind}:${marker.id}`
}

export function hasSource(node: Node): boolean {
	return (node.attrs["src"] ?? NO_SOURCE) !== NO_SOURCE
}

export function sourceOf(node: Node | Mark): number {
	const value: unknown = node.attrs["src"]

	return typeof value === "number" ? value : NO_SOURCE
}
