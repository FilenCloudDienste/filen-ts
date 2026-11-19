import type { Relationships } from "../../opc/index"
import { NodeKind, decodeCharacterData, type XmlDocument } from "../../xml/index"
import { symbolTable, symbolToUnicode } from "../../fonts/symbols"
import type { XmlNodeRef } from "../props/types"
import { BreakType, FieldCharType, Item, RevisionView, TRANSPARENT, revisionHidden, type SdtLevel } from "./kinds"
import { macroButtonText } from "./macroButton"
import { Ns } from "./namespaces"
import type { PartReader } from "./reader"

// Per-kind tables. Row r of a table describes one item; the item's aux slot holds r. Property columns are
// node indices into the part's XmlDocument (-1 when absent): parsing and resolving them is the styles
// layer's job. Style columns index the model's string table.

export interface ParagraphTable {
	readonly count: number
	readonly item: Int32Array
	readonly pPr: Int32Array
	readonly style: Int32Array
	readonly numPr: Int32Array
	readonly sectPr: Int32Array
	// pPr/rPr: the paragraph mark's run properties.
	readonly markRPr: Int32Array
	readonly pPrChange: Int32Array
	// RevisionFlag bits of the paragraph mark (inserted, deleted, moved) and the first of those revisions.
	readonly markRevision: Int32Array
	readonly markRevisionRow: Int32Array
}

export interface RunTable {
	readonly count: number
	readonly item: Int32Array
	readonly rPr: Int32Array
	readonly style: Int32Array
	readonly rPrChange: Int32Array
}

export interface TableTable {
	readonly count: number
	readonly item: Int32Array
	readonly tblPr: Int32Array
	readonly tblGrid: Int32Array
	readonly style: Int32Array
	// 0 for a table directly in a story, n for one nested in n tables.
	readonly depth: Int32Array
}

export interface RowTable {
	readonly count: number
	readonly item: Int32Array
	readonly trPr: Int32Array
	readonly tblPrEx: Int32Array
	// RevisionFlag bits (inserted, deleted) and the first revision row.
	readonly revision: Int32Array
	readonly revisionRow: Int32Array
}

export interface CellTable {
	readonly count: number
	readonly item: Int32Array
	readonly tcPr: Int32Array
	// RevisionFlag bits (inserted, deleted, merged) and the first revision row.
	readonly revision: Int32Array
	readonly revisionRow: Int32Array
}

export interface SdtTable {
	readonly count: number
	readonly item: Int32Array
	readonly sdtPr: Int32Array
	readonly sdtEndPr: Int32Array
	readonly content: Int32Array
	readonly level: Int32Array
}

// Complex fields (fldChar begin/separate/end) and simple fields (w:fldSimple, whose begin is the wrapper
// item). Items are -1 when the field is not terminated or has no result; parent is the enclosing field.
export interface FieldTable {
	readonly count: number
	readonly begin: Int32Array
	readonly separate: Int32Array
	readonly end: Int32Array
	readonly parent: Int32Array
	readonly simple: Uint8Array
	// First instruction text item of a complex field; each one links to the next (see nextInstruction).
	readonly instruction: Int32Array
}

export interface BookmarkTable {
	readonly count: number
	readonly start: Int32Array
	readonly end: Int32Array
	// w:id -> row.
	readonly ids: ReadonlyMap<string, number>
}

// Tracked changes. `item` is the wrapper (ins/del/moveFrom/moveTo, range start) or the item owning the
// property element the change sits in; `node` is the revision element itself.
export interface RevisionTable {
	readonly count: number
	readonly kind: Int32Array
	readonly item: Int32Array
	readonly node: Int32Array
	readonly id: Int32Array
	readonly author: Int32Array
	readonly date: Int32Array
}

// mc:AlternateContent: every branch is recorded for saving; children of the item are the selected one.
// Branch nodes (each mc:Choice and the mc:Fallback, in order) are branches[firstBranch, +branchCount).
export interface AlternateTable {
	readonly count: number
	readonly item: Int32Array
	readonly selected: Int32Array
	readonly fallback: Int32Array
	readonly firstBranch: Int32Array
	readonly branchCount: Int32Array
	readonly branches: Int32Array
}

export interface PartTables {
	readonly paragraphs: ParagraphTable
	readonly runs: RunTable
	readonly tables: TableTable
	readonly rows: RowTable
	readonly cells: CellTable
	readonly sdts: SdtTable
	readonly fields: FieldTable
	readonly bookmarks: BookmarkTable
	readonly revisions: RevisionTable
	readonly alternates: AlternateTable
}

export interface PartItems {
	readonly count: number
	readonly kinds: Uint8Array
	readonly nodes: Int32Array
	readonly ends: Int32Array
	readonly parents: Int32Array
	readonly aux: Int32Array
}

export interface HyperlinkTarget {
	readonly relationshipId: string | undefined
	// Internal target (a bookmark name).
	readonly anchor: string | undefined
	// The relationship's target as written; never fetched. External targets are classified at click time.
	readonly target: string | undefined
	readonly external: boolean
	readonly tooltip: string | undefined
	readonly targetFrame: string | undefined
	readonly docLocation: string | undefined
}

function textOf(reader: PartReader, node: number): string {
	const document = reader.document
	const first = document.firstChild(node)

	if (first < 0) return ""

	if (document.nextSibling(first) < 0 && document.kinds[first] === NodeKind.Text) {
		try {
			return decodeCharacterData(document.bytes, document.start(first), document.end(first), false)
		} catch {
			// Bad references: fall through to the lenient reader.
		}
	}

	return reader.text(node)
}

// One story-bearing part (document, header, footer, notes, comments) as a flat item stream in document
// order. Every item points at the XML element it came from, so a writer can re-emit untouched items from
// their source bytes. Iterate children of a container c with `for (let i = c + 1; i < ends[c]; i = ends[i])`.
export class StoryPart implements PartItems, PartTables {
	readonly index: number
	readonly name: string
	readonly document: XmlDocument
	readonly reader: PartReader
	readonly relationships: Relationships
	readonly count: number
	readonly kinds: Uint8Array
	readonly nodes: Int32Array
	readonly ends: Int32Array
	readonly parents: Int32Array
	readonly aux: Int32Array
	readonly paragraphs: ParagraphTable
	readonly runs: RunTable
	readonly tables: TableTable
	readonly rows: RowTable
	readonly cells: CellTable
	readonly sdts: SdtTable
	readonly fields: FieldTable
	readonly bookmarks: BookmarkTable
	readonly revisions: RevisionTable
	readonly alternates: AlternateTable

	constructor(index: number, name: string, reader: PartReader, relationships: Relationships, items: PartItems, tables: PartTables) {
		this.index = index
		this.name = name
		this.document = reader.document
		this.reader = reader
		this.relationships = relationships
		this.count = items.count
		this.kinds = items.kinds
		this.nodes = items.nodes
		this.ends = items.ends
		this.parents = items.parents
		this.aux = items.aux
		this.paragraphs = tables.paragraphs
		this.runs = tables.runs
		this.tables = tables.tables
		this.rows = tables.rows
		this.cells = tables.cells
		this.sdts = tables.sdts
		this.fields = tables.fields
		this.bookmarks = tables.bookmarks
		this.revisions = tables.revisions
		this.alternates = tables.alternates
	}

	kind(item: number): Item {
		return (this.kinds[item] ?? 0) as Item
	}

	node(item: number): number {
		return this.nodes[item] ?? -1
	}

	end(item: number): number {
		return this.ends[item] ?? item + 1
	}

	parent(item: number): number {
		return this.parents[item] ?? -1
	}

	// First child item, or -1.
	firstChild(item: number): number {
		return this.end(item) > item + 1 ? item + 1 : -1
	}

	// Next sibling item, or -1.
	nextSibling(item: number): number {
		const next = this.end(item)
		const parent = this.parent(item)

		return next < (parent < 0 ? this.count : this.end(parent)) ? next : -1
	}

	// Source byte span [start, end) of an item in the part's bytes.
	start(item: number): number {
		return this.document.start(this.node(item))
	}

	byteEnd(item: number): number {
		return this.document.end(this.node(item))
	}

	// Raw property XML as the styles layer consumes it.
	ref(node: number): XmlNodeRef | undefined {
		return node < 0 ? undefined : { document: this.document, node }
	}

	paragraphRow(item: number): number {
		return this.kinds[item] === Item.Paragraph ? (this.aux[item] ?? -1) : -1
	}

	runRow(item: number): number {
		return this.kinds[item] === Item.Run ? (this.aux[item] ?? -1) : -1
	}

	// Decoded text of a Text, DeletedText, InstrText or DeletedInstrText item.
	text(item: number): string {
		return textOf(this.reader, this.node(item))
	}

	// Byte span of a text item's character data, written to `out`; returns its byte length.
	textSpan(item: number, out: Int32Array): number {
		const document = this.document
		const node = this.node(item)
		const start = document.contentStart(node)
		const end = document.contentEnd(node)

		out[0] = start
		out[1] = end

		return end - start
	}

	// xml:space="preserve" on a text item.
	preservesSpace(item: number): boolean {
		return ((this.aux[item] ?? 0) & 1) === 1
	}

	breakType(item: number): number {
		return (this.aux[item] ?? 0) & 3
	}

	breakClear(item: number): number {
		return ((this.aux[item] ?? 0) >> 2) & 3
	}

	fieldCharType(item: number): number {
		return (this.aux[item] ?? 0) & 3
	}

	fieldCharDirty(item: number): boolean {
		return ((this.aux[item] ?? 0) & 4) !== 0
	}

	fieldCharLocked(item: number): boolean {
		return ((this.aux[item] ?? 0) & 8) !== 0
	}

	// The field a FieldChar item belongs to, or -1 when it matched none.
	fieldOf(item: number): number {
		return ((this.aux[item] ?? 0) >> 4) - 1
	}

	// w:sym: the code point (Word writes symbol-font characters in the private use area F0xx) and its font.
	symbol(item: number): { char: number; font: string | undefined } {
		return { char: this.aux[item] ?? -1, font: this.reader.attr(this.node(item), Ns.W, "font") }
	}

	hyperlink(item: number): HyperlinkTarget {
		const node = this.node(item)
		const reader = this.reader
		const relationshipId = reader.attr(node, Ns.R, "id")
		const relationship = relationshipId === undefined ? undefined : this.relationships.byId(relationshipId)

		return {
			relationshipId,
			anchor: reader.attr(node, Ns.W, "anchor"),
			target: relationship?.target,
			external: relationship?.external ?? false,
			tooltip: reader.attr(node, Ns.W, "tooltip"),
			targetFrame: reader.attr(node, Ns.W, "tgtFrame"),
			docLocation: reader.attr(node, Ns.W, "docLocation")
		}
	}

	// w:id of a marker, note reference or revision element, as written.
	id(item: number): string | undefined {
		return this.reader.attr(this.node(item), Ns.W, "id")
	}

	bookmarkName(bookmark: number): string | undefined {
		const start = this.bookmarks.start[bookmark] ?? -1

		return start < 0 ? undefined : this.reader.attr(this.node(start), Ns.W, "name")
	}

	// w14:paraId of a paragraph (what commentsExtended keys on).
	paragraphId(item: number): string | undefined {
		return this.reader.attr(this.node(item), Ns.W14, "paraId")
	}

	sdtLevel(sdt: number): SdtLevel {
		return (this.sdts.level[sdt] ?? 0) as SdtLevel
	}

	// The content control's type: the first type element in w:sdtPr ("text", "richText", "checkbox",
	// "dropDownList", "comboBox", "date", "picture", "docPartObj", "group", "citation", "bibliography",
	// "equation", "repeatingSection"...), or "richText" when none is given.
	sdtType(sdt: number): string {
		const sdtPr = this.sdts.sdtPr[sdt] ?? -1
		const document = this.document

		if (sdtPr < 0) return "richText"

		for (let child = document.firstChildElement(sdtPr); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (SDT_TYPES.has(local)) return local
		}

		return "richText"
	}

	// A field's instruction: its own instrText items (or w:fldSimple@w:instr), nested fields left out, as
	// the view shows them (Final drops deleted instruction text, Original inserted).
	fieldInstruction(field: number, view: RevisionView = RevisionView.Final): string {
		const begin = this.fields.begin[field] ?? -1

		if (begin < 0) return ""

		if (this.fields.simple[field] === 1) return this.reader.attr(this.node(begin), Ns.W, "instr") ?? ""

		let out = ""

		for (let item = this.fields.instruction[field] ?? -1; item >= 0; item = this.nextInstruction(item)) {
			if (view === RevisionView.Final && this.kinds[item] === Item.DeletedInstrText) continue
			if (view !== RevisionView.Markup && this.hiddenByAncestor(item, view)) continue

			out += this.text(item)
		}

		return out
	}

	// What a MACROBUTTON field shows when it has no result: its display text, the instruction's second argument
	// (ECMA-376 Part 1 §17.16.5.34). The instruction of a field can hold other fields (§17.16.2): their values,
	// the results they last stored, are part of it, so a nested HYPERLINK's text shows as the button. Undefined
	// for other fields.
	macroButtonDisplay(field: number, view: RevisionView = RevisionView.Final): string | undefined {
		const instruction = this.fieldInstruction(field, view)

		if (macroButtonText(instruction) === undefined) return undefined
		if (this.fields.simple[field] === 1) return macroButtonText(instruction)

		const begin = this.fields.begin[field] ?? -1
		// The field's own end, else its separator: an unterminated field shows its instruction's display text
		// (scanning to the end of the part would read later paragraphs, once per field).
		const fieldEnd = this.fields.end[field] ?? -1
		const last = fieldEnd >= 0 ? fieldEnd : (this.fields.separate[field] ?? -1)

		if (last < 0) return macroButtonText(instruction)

		// Per nested field, whether its result is being read; and how many are not (text shows only when none is).
		const nested: boolean[] = []
		let inCode = 0
		let out = ""

		for (let item = begin + 1; item >= 0 && item < last; item++) {
			if (view !== RevisionView.Markup && this.hidden(item, view)) {
				item = this.end(item) - 1

				continue
			}

			const kind = this.kinds[item]

			if (kind === Item.FieldChar) {
				const type = this.fieldCharType(item)

				if (type === FieldCharType.Begin) {
					nested.push(false)
					inCode++
				} else if (nested.length === 0) break
				else if (type === FieldCharType.Separate) {
					if (nested[nested.length - 1] === false) inCode--

					nested[nested.length - 1] = true
				} else if (nested.pop() === false) inCode--

				continue
			}

			if (kind === Item.InstrText || kind === Item.DeletedInstrText) {
				if (nested.length === 0 && !(view === RevisionView.Final && kind === Item.DeletedInstrText)) out += this.text(item)
			} else if ((kind === Item.Text || kind === Item.DeletedText) && nested.length > 0 && inCode === 0) {
				if (!(view === RevisionView.Final && kind === Item.DeletedText)) out += this.text(item)
			}
		}

		return macroButtonText(out)
	}

	// Whether a revision wrapper, row or cell around the item hides it in `view` (up to its story).
	hiddenByAncestor(item: number, view: RevisionView): boolean {
		for (let at = this.parent(item); at >= 0; at = this.parent(at)) {
			const kind = this.kinds[at] ?? 0

			if (kind >= Item.Body && kind <= Item.Textbox) return false
			if (this.hidden(at, view)) return true
		}

		return false
	}

	// The next instruction text item of the same field, or -1.
	nextInstruction(item: number): number {
		return ((this.aux[item] ?? 0) >>> 1) - 1
	}

	// Whether an item is absent from `view` because of a tracked change: revision wrappers, and rows and
	// cells whose properties mark them inserted or deleted. A paragraph's own mark is separate (see
	// paragraphMarkHidden): when it is hidden the paragraph joins the next one, which layout does.
	hidden(item: number, view: RevisionView): boolean {
		switch (this.kinds[item]) {
			case Item.Deletion:
			case Item.MoveFrom:
				return view === RevisionView.Final
			case Item.Insertion:
			case Item.MoveTo:
				return view === RevisionView.Original
			case Item.Row:
				return revisionHidden(this.rows.revision[this.aux[item] ?? -1] ?? 0, view)
			case Item.Cell:
				return revisionHidden(this.cells.revision[this.aux[item] ?? -1] ?? 0, view)
			default:
				return false
		}
	}

	paragraphMarkHidden(item: number, view: RevisionView): boolean {
		return this.kinds[item] === Item.Paragraph && revisionHidden(this.paragraphs.markRevision[this.aux[item] ?? -1] ?? 0, view)
	}

	// The instruction's field type ("PAGE", "TOC", "HYPERLINK", ...), upper case; "" when there is none.
	fieldType(field: number, view: RevisionView = RevisionView.Final): string {
		const match = /^\s*([^\s\\"]+)/.exec(this.fieldInstruction(field, view))

		return match?.[1]?.toUpperCase() ?? ""
	}

	// The code point a w:sym shows: the Unicode character its symbol font draws there, else its own code.
	symbolChar(item: number): number {
		const symbol = this.symbol(item)
		const table = symbol.font === undefined ? undefined : symbolTable(symbol.font)

		return table === undefined ? symbol.char : symbolToUnicode(table, symbol.char) || symbol.char
	}

	// Plain text of a paragraph (or any container) for search and tests: tabs as "\t", breaks as "\n",
	// non-breaking hyphens as U+2011, soft hyphens as U+00AD, symbols as their code point (as the editing
	// document holds them); field codes and nested text boxes left out, field results kept, a MACROBUTTON without a
	// result as its display text. `offsets`, when given (length end(item) - item + 1), receives the text's
	// length before each item (index item - `item`; a field's display text counts before the item after the
	// field) and its whole length last.
	paragraphText(item: number, view: RevisionView = RevisionView.Final, offsets?: Int32Array): string {
		let out = ""
		const end = this.end(item)
		let filled = 1
		let fieldDepth = 0
		let codeDepth = 0
		let paragraphs = 0
		let joinNext = false
		const codeStack: number[] = []
		// Per open field: a MACROBUTTON's display text (shown where its result shows nothing, as layout shows it)
		// and where its result starts (-1 before its separator); a w:fldSimple one's end, text and start.
		const displays: (string | undefined)[] = []
		const resultStarts: number[] = []
		let simpleEnd = -1
		let simpleDisplay = ""
		let simpleStart = 0

		for (let i = item + 1; i < end;) {
			const kind = this.kinds[i] ?? 0

			if (simpleEnd >= 0 && i >= simpleEnd) {
				if (out.length === simpleStart) out += simpleDisplay

				simpleEnd = -1
			}

			if (offsets !== undefined) for (; filled <= i - item; filled++) offsets[filled] = out.length

			if (view !== RevisionView.Markup && this.hidden(i, view)) {
				i = this.end(i)

				continue
			}

			switch (kind) {
				case Item.FieldChar: {
					const type = this.fieldCharType(i)

					if (type === FieldCharType.Begin) {
						const field = fieldDepth === 0 ? this.fieldOf(i) : -1

						// Inside another field a MACROBUTTON shows nothing.
						displays.push(field < 0 ? undefined : this.macroButtonDisplay(field, view))
						resultStarts.push(-1)
						codeStack.push(codeDepth)
						fieldDepth++
						codeDepth = fieldDepth
					} else if (type === FieldCharType.Separate) {
						codeDepth = codeStack[codeStack.length - 1] ?? 0
						resultStarts[resultStarts.length - 1] = out.length
					} else if (type === FieldCharType.End && fieldDepth > 0) {
						fieldDepth--
						codeDepth = codeStack.pop() ?? 0

						const display = displays.pop()
						const start = resultStarts.pop() ?? -1

						if (display !== undefined && codeDepth === 0 && (start < 0 || out.length === start)) out += display
					}

					break
				}
				case Item.Text:
				case Item.DeletedText:
					if (codeDepth === 0) out += this.text(i)

					break
				case Item.Tab:
				case Item.PositionalTab:
					if (codeDepth === 0) out += "\t"

					break
				case Item.Break:
					if (codeDepth === 0) out += this.breakType(i) === BreakType.TextWrapping ? "\n" : "\f"

					break
				case Item.CarriageReturn:
					if (codeDepth === 0) out += "\n"

					break
				case Item.NoBreakHyphen:
					if (codeDepth === 0) out += "\u2011"

					break
				case Item.SoftHyphen:
					if (codeDepth === 0) out += "\u00ad"

					break
				case Item.Symbol: {
					const char = this.aux[i] ?? -1

					if (codeDepth === 0 && char > 0 && char <= 0x10ffff) out += String.fromCodePoint(char)

					break
				}
				case Item.FieldSimple: {
					const display =
						fieldDepth === 0 && simpleEnd < 0 ? macroButtonText(this.fieldInstruction(this.aux[i] ?? -1, view)) : undefined

					if (display !== undefined) {
						simpleEnd = this.end(i)
						simpleDisplay = display
						simpleStart = out.length
					}

					break
				}
				case Item.Paragraph:
					if (paragraphs++ > 0 && !joinNext) out += "\n"

					joinNext = this.paragraphMarkHidden(i, view)

					break
			}

			i =
				TRANSPARENT[kind] === 1 || kind === Item.Paragraph || kind === Item.Table || kind === Item.Row || kind === Item.Cell
					? i + 1
					: this.end(i)
		}

		if (simpleEnd >= 0 && out.length === simpleStart) out += simpleDisplay
		if (offsets !== undefined) for (; filled < offsets.length; filled++) offsets[filled] = out.length

		return out
	}
}

const SDT_TYPES = new Set<string>([
	"text",
	"richText",
	"checkbox",
	"dropDownList",
	"comboBox",
	"date",
	"picture",
	"docPartObj",
	"docPartList",
	"group",
	"citation",
	"bibliography",
	"equation",
	"repeatingSection",
	"repeatingSectionItem"
])
