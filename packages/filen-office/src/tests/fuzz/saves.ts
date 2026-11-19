import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import { basename, extname, join, relative } from "node:path"
import { bytesSource } from "@filen/office/core/opc"
import {
	BreakType,
	Item,
	RevisionView,
	SdtLevel,
	buildDocxModel,
	modelStats,
	openDocxPackage,
	type DocxModel,
	type Story,
	type StoryPart
} from "@filen/office/core/docx"

// Saved outputs of the fuzzers and the scripted edit suite, kept for the oracles that read files (LibreOffice,
// the schema and Open XML SDK validators). FILEN_OFFICE_FUZZ_SAVES=<dir> turns it on; each save is
// <dir>/<family>/<corpus stem>__s<seed>__<n>.<extension> with a sidecar <same>.json (SaveSidecar), and
// <dir>/manifest.json lists them all (writeManifest). FILEN_OFFICE_FUZZ_SAVES_EVERY=<k> keeps one run in k
// (by a hash of file, seed and slot) and FILEN_OFFICE_FUZZ_SAVES_MAX_BYTES (5 MB) skips bigger sources, so
// disk use stays bounded.

export interface SavesConfig {
	readonly dir: string
	readonly every: number
	readonly maxBytes: number
}

export function savesConfig(env: NodeJS.ProcessEnv = process.env): SavesConfig | undefined {
	const dir = env["FILEN_OFFICE_FUZZ_SAVES"]

	if (dir === undefined || dir === "") return undefined

	const every = Number(env["FILEN_OFFICE_FUZZ_SAVES_EVERY"] || "1")
	const maxBytes = Number(env["FILEN_OFFICE_FUZZ_SAVES_MAX_BYTES"] || "5000000")

	if (!Number.isInteger(every) || every < 1) throw new Error("FILEN_OFFICE_FUZZ_SAVES_EVERY must be a whole number from 1")
	if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error("FILEN_OFFICE_FUZZ_SAVES_MAX_BYTES must be a number")

	return { dir, every, maxBytes }
}

// The text and counts of a document as our model reads it.
export interface DocumentSummary {
	// Body text, one line per paragraph (table cells included, text boxes and notes not): tracked changes
	// accepted, rejected, and all shown.
	readonly final: string
	readonly original: string
	readonly markup: string
	readonly counts: Readonly<Record<string, number>>
}

export interface SaveSidecar {
	// The corpus file, relative to the corpus directory.
	readonly source: string
	readonly family: string
	readonly harness: "paged" | "damage" | "script"
	readonly mode: string
	readonly seed: number
	readonly n: number
	// The revision view the run opened in, and the one it ended in.
	readonly view: string
	readonly endView: string
	readonly ops: readonly string[]
	readonly changedParts: readonly string[]
	readonly oursBefore: string
	readonly oursAfter: string
	readonly oursBeforeOriginal: string
	readonly oursAfterOriginal: string
	readonly oursBeforeMarkup: string
	readonly oursAfterMarkup: string
	readonly countsBefore: Readonly<Record<string, number>>
	readonly counts: Readonly<Record<string, number>>
	readonly sha256: string
	readonly bytes: number
}

// Kinds inside a paragraph whose content is another story or not shown: skipped with their subtrees.
const SKIPPED: ReadonlySet<number> = new Set([Item.Paragraph, Item.Textbox, Item.Note, Item.Comment, Item.RubyText])
const OTHER_STORIES: ReadonlySet<number> = new Set([Item.Textbox, Item.Note, Item.Comment])

// Fields whose result a reader computes again (page numbers, dates, document properties): their cached result
// is not the document's text. The ODF side leaves out the matching fields (interop/odfSummary.ts).
export const COMPUTED_FIELDS: ReadonlySet<string> = new Set([
	"PAGE",
	"NUMPAGES",
	"SECTIONPAGES",
	"SECTION",
	"DATE",
	"TIME",
	"CREATEDATE",
	"SAVEDATE",
	"PRINTDATE",
	"EDITTIME",
	"FILENAME",
	"FILESIZE",
	"NUMWORDS",
	"NUMCHARS",
	"AUTHOR",
	"LASTSAVEDBY",
	"TITLE",
	"SUBJECT",
	"KEYWORDS",
	"COMMENTS",
	"DOCPROPERTY",
	"USERNAME",
	"USERINITIALS",
	"TEMPLATE",
	"INFO",
	// References and numbering LibreOffice resolves again; a table of contents it keeps as an index of its own.
	"REF",
	"PAGEREF",
	"NOTEREF",
	"SEQ",
	"STYLEREF",
	"TOC",
	// A macro button shows its instruction's display text, never a result (ECMA-376 Part 1 §17.16.5.36).
	"MACROBUTTON"
])

// A table of contents building block (w:docPartObj, w:docPartGallery "Table of Contents", ECMA-376 Part 1
// §17.5.2.12, §17.5.2.13): LibreOffice imports the whole control as its index, title and body.
function tocBlock(part: StoryPart, sdt: number): boolean {
	const document = part.document
	const sdtPr = part.sdts.sdtPr[sdt] ?? -1

	for (let child = sdtPr < 0 ? -1 : document.firstChildElement(sdtPr); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) !== "docPartObj") continue

		for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property))
			if (document.localName(property) === "docPartGallery")
				return document.attributes(property).find(attribute => /(^|:)val$/.test(attribute.name))?.value === "Table of Contents"
	}

	return false
}

// The paragraph an item is in, or -1.
function fieldParagraph(part: StoryPart, item: number): number {
	let at = part.parent(item)

	while (at >= 0 && part.kind(at) !== Item.Paragraph) at = part.parent(at)

	return at
}

// Whether text (a space even) comes before `item` in its paragraph.
function textBefore(part: StoryPart, item: number): boolean {
	const paragraph = fieldParagraph(part, item)

	for (let at = paragraph + 1; paragraph >= 0 && at < item; at++) if (part.kind(at) === Item.Text && part.text(at) !== "") return true

	return false
}

// Whether text of the field's own result (not of a field nested in it) comes after its separator in that
// paragraph.
function resultTextAfter(part: StoryPart, field: number): boolean {
	const fields = part.fields
	const separate = fields.separate[field] ?? -1
	const paragraph = fieldParagraph(part, separate)
	const end = paragraph < 0 ? separate : part.end(paragraph)

	for (let at = separate + 1; at < end; at++) {
		const nested = nestedField(part, field, at)

		if (nested >= 0) at = fields.end[nested] ?? end
		else if (part.kind(at) === Item.Text && part.text(at) !== "") return true
	}

	return false
}

// The field nested in `field` that begins at `item`, or -1.
function nestedField(part: StoryPart, field: number, item: number): number {
	const fields = part.fields

	for (let other = 0; other < fields.count; other++) if (fields.begin[other] === item && fields.parent[other] === field) return other

	return -1
}

// The table of contents field in [from, to), or -1.
function tocField(part: StoryPart, from: number, to: number): number {
	const fields = part.fields

	for (let field = 0; field < fields.count; field++) {
		const begin = fields.begin[field] ?? -1

		if (begin > from && begin < to && fields.simple[field] !== 1 && part.fieldType(field, RevisionView.Markup) === "TOC") return field
	}

	return -1
}

// Items in the results of computed fields (a field's type read with every change shown: a deleted instruction,
// w:delInstrText, ECMA-376 Part 1 §17.16.13, or one in a deleted row still names it), and in table of contents
// building blocks holding one. LibreOffice imports such a block as its index, title and body; when the paragraph the table of
// contents field begins in holds text before the field and none of its own result (a nested field's may), the index ends with that paragraph
// and the entries after it, with the results of the fields in them, are body text.
function computedResults(part: StoryPart): Uint8Array {
	const out = new Uint8Array(part.count)
	const fields = part.fields
	const shown = new Set<number>()

	for (let sdt = 0; sdt < part.sdts.count; sdt++) {
		const item = part.sdts.item[sdt] ?? -1

		if (item < 0 || !tocBlock(part, sdt)) continue

		const toc = tocField(part, item, part.end(item))

		// One without its field is content (LibreOffice writes body text into one it empties).
		if (toc < 0) continue

		const begin = fields.begin[toc] ?? -1
		const separate = fields.separate[toc] ?? -1

		if (
			begin >= 0 &&
			separate >= 0 &&
			fieldParagraph(part, separate) === fieldParagraph(part, begin) &&
			textBefore(part, begin) &&
			!resultTextAfter(part, toc)
		) {
			shown.add(toc)
			out.fill(1, item + 1, part.end(fieldParagraph(part, begin)))
		} else out.fill(1, item + 1, part.end(item))
	}

	for (let field = 0; field < fields.count; field++) {
		if (!COMPUTED_FIELDS.has(part.fieldType(field, RevisionView.Markup))) continue

		let outer = field

		while (outer >= 0 && !shown.has(outer)) outer = fields.parent[outer] ?? -1

		if (outer >= 0) continue

		const begin = fields.begin[field] ?? -1
		const from = fields.simple[field] === 1 ? begin : (fields.separate[field] ?? -1)
		const to = fields.simple[field] === 1 ? part.end(begin) : (fields.end[field] ?? -1)

		if (from >= 0 && to > from) out.fill(1, from + 1, to)
	}

	return out
}

function noteReferenceRun(part: StoryPart, run: number): boolean {
	for (let item = run + 1; item < part.end(run); item++) {
		const kind = part.kind(item)

		if (kind === Item.FootnoteReference || kind === Item.EndnoteReference) return true
	}

	return false
}

// Whether an item (a table, a row) is in a DrawingML text box (wps:txbx), which LibreOffice imports as a shape
// whose text holds no table (interop/accepted.ts); a VML one (v:textbox) is a frame that keeps it.
function inDrawingTextbox(part: StoryPart, item: number): boolean {
	const document = part.document

	for (let node = document.parent(part.node(item)); node >= 0; node = document.parent(node))
		if (document.localName(node) === "txbx") return true

	return false
}

// A cell that continues a vertical merge (w:vMerge without val, or "continue"): ODF holds it as a covered cell,
// which LibreOffice leaves without content.
function coveredCell(part: StoryPart, cell: number): boolean {
	const document = part.document

	for (let child = document.firstChildElement(part.node(cell)); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) !== "tcPr") continue

		for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property))
			if (document.localName(property) === "vMerge") {
				const value = document.attributes(property).find(attribute => /(^|:)val$/.test(attribute.name))?.value

				return value === undefined || value === "continue"
			}
	}

	return false
}

// A story's paragraphs as text lines in `view` (undefined: every change shown), and how many paragraphs that
// view has. Content a view hides is left out (changes, and rows and cells inserted or deleted), a paragraph
// whose mark it hides runs on into the next one in the same cell (or the body: never into or out of a table),
// and the run of a note reference (its custom mark is the note's, not text) and the results of computed fields
// are left out. `odf`: counted as an ODF body holds the story: rows and cells stay whatever their tracked state,
// a cell continuing a vertical merge holds nothing, and a page or column break before the text of the
// story's first paragraph starts a paragraph of its own. `paragraphs` also counts a page or column break
// between text as a paragraph of its own.
function storyLines(
	part: StoryPart,
	story: Story,
	view: RevisionView | undefined,
	odf = false
): { lines: string[]; paragraphs: number; breakAnchors: number } {
	const lines: string[] = []
	let paragraphs = 0
	// Breaks counted as paragraph starts whose next content is a floating (anchored) drawing.
	let breakAnchors = 0
	let line = ""
	const end = part.end(story.item)
	const hidden = (item: number): boolean =>
		view !== undefined && !(odf && (part.kind(item) === Item.Row || part.kind(item) === Item.Cell)) && part.hidden(item, view)
	const computed = computedResults(part)
	// Open cells, innermost last; the cell (or -1, the story) of the paragraph whose hidden mark runs on.
	const cells: number[] = []
	let runOn: number | undefined
	let first = true
	// The text of a drop cap, for the paragraph after it.
	let dropped: string | undefined

	for (let item = story.item + 1; item < end; item++) {
		while (cells.length > 0 && item >= part.end(cells[cells.length - 1] as number)) cells.pop()

		const kind = part.kind(item)

		if (OTHER_STORIES.has(kind) || hidden(item) || (odf && kind === Item.Cell && coveredCell(part, item))) {
			item = part.end(item) - 1
			continue
		}

		if (kind === Item.Cell) cells.push(item)
		if (kind !== Item.Paragraph) continue

		const container = cells[cells.length - 1] ?? -1

		if (runOn !== undefined && runOn !== container) {
			lines.push(line)
			line = ""
			paragraphs++
		}

		runOn = undefined
		line = (dropped ?? "") + line
		dropped = undefined

		const stop = part.end(item)
		// Page and column breaks between text in the paragraph (`paragraphs` counts the paragraphs each starts, as
		// LibreOffice has no break inside a paragraph).
		let text = false
		let pending = 0
		let pendingAnchored = 0
		// After a counted break: whether its next content is still to be seen.
		let afterBreak = false

		for (let inner = item + 1; inner < stop; inner++) {
			const innerKind = part.kind(inner)

			if (SKIPPED.has(innerKind) || hidden(inner) || (innerKind === Item.Run && noteReferenceRun(part, inner))) {
				inner = part.end(inner) - 1
				continue
			}

			if (computed[inner] === 1) continue

			if (afterBreak && innerKind === Item.Drawing) {
				afterBreak = false
				if (anchoredDrawing(part, inner)) pendingAnchored++
			} else if (afterBreak && CONTENT.has(innerKind)) afterBreak = false

			if (innerKind === Item.Text || innerKind === Item.DeletedText) {
				const value = part.text(inner)

				line += value

				if (value !== "") {
					paragraphs += pending
					breakAnchors += pendingAnchored
					pending = 0
					pendingAnchored = 0
					afterBreak = false
					text = true
				}
			} else if (innerKind === Item.Break && part.breakType(inner) !== BreakType.TextWrapping) {
				line += "\n"

				// LibreOffice keeps a break before the text of a section's first paragraph (the document's first
				// included) with an empty paragraph.
				if (text || (odf && first && container === -1)) {
					pending++
					afterBreak = true
				}
			} else if (innerKind === Item.Tab || innerKind === Item.PositionalTab) line += "\t"
			else if (innerKind === Item.Break || innerKind === Item.CarriageReturn) line += "\n"
			else if (innerKind === Item.NoBreakHyphen) line += "\u2011"
			else if (innerKind === Item.SoftHyphen) line += "\u00ad"
		}

		first = odf && container === -1 && hasProperty(part, item, "sectPr")

		// A drop cap is a paragraph of its own in WordprocessingML (w:framePr w:dropCap, ECMA-376 Part 1
		// §17.3.1.11) but a property of the paragraph it starts in ODF (style:drop-cap): its text begins the next
		// paragraph, wherever that is (LibreOffice moves it into a table's first cell).
		if (dropCap(part, item)) {
			dropped = line
			line = ""
		} else if (view === undefined || !part.paragraphMarkHidden(item, view)) {
			lines.push(line)
			line = ""
			paragraphs++
		} else runOn = container

		// Nested paragraphs (text boxes) were skipped; tables' paragraphs come next in item order.
		item = stop - 1
	}

	if (line !== "") lines.push(line)

	// A drop cap with no paragraph after it stays a paragraph.
	if (dropped !== undefined) {
		lines.push(dropped)
		paragraphs++
	}

	return { lines, paragraphs, breakAnchors }
}

// Tables of contents inside another one's result (a TOC field begun between a TOC field's separator and end;
// fields nest, ECMA-376 Part 1 §17.16.18): LibreOffice 26.8 ends the outer index at the inner one's end.
function nestedTocs(model: DocxModel): number {
	let count = 0

	for (const part of model.parts) {
		if (part === undefined) continue

		const fields = part.fields
		const tocs: number[] = []

		for (let field = 0; field < fields.count; field++)
			if (part.fieldType(field) === "TOC" && fields.simple[field] !== 1) tocs.push(field)

		for (const inner of tocs) {
			const begin = fields.begin[inner] ?? -1

			if (
				tocs.some(
					outer =>
						outer !== inner &&
						(fields.separate[outer] ?? -1) >= 0 &&
						(fields.separate[outer] ?? -1) < begin &&
						begin < (fields.end[outer] ?? -1)
				)
			)
				count++
		}
	}

	return count
}

// Whether a paragraph is a drop cap (w:framePr w:dropCap drop or margin, ECMA-376 Part 1 §17.3.1.11, §17.18.21).
function dropCap(part: StoryPart, paragraph: number): boolean {
	const document = part.document

	for (let child = document.firstChildElement(part.node(paragraph)); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) !== "pPr") continue

		for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property))
			if (document.localName(property) === "framePr") {
				const value = document.attributes(property).find(attribute => /(^|:)dropCap$/.test(attribute.name))?.value

				return value === "drop" || value === "margin"
			}

		return false
	}

	return false
}

// Whether a w:drawing item is a floating (wp:anchor) one.
function anchoredDrawing(part: StoryPart, drawing: number): boolean {
	const document = part.document

	for (let child = document.firstChildElement(part.node(drawing)); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === "anchor") return true

	return false
}

// The grid columns a row leaves empty before and after its cells (w:trPr w:gridBefore, w:gridAfter, ECMA-376
// Part 1 §17.4.15, §17.4.14).
function gridGap(part: StoryPart, row: number): number {
	const document = part.document
	let gap = 0

	for (let child = document.firstChildElement(part.node(row)); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) !== "trPr") continue

		for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
			const name = document.localName(property)

			if (name !== "gridBefore" && name !== "gridAfter") continue

			const value = Number(document.attributes(property).find(attribute => /(^|:)val$/.test(attribute.name))?.value)

			if (Number.isInteger(value) && value > 0) gap += value
		}
	}

	return gap
}

// Whether a section's properties name a header or footer of its own (w:headerReference, w:footerReference).
function ownHeaders(part: StoryPart, paragraph: number): boolean {
	const document = part.document

	for (let child = document.firstChildElement(part.node(paragraph)); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) !== "pPr") continue

		for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
			if (document.localName(property) !== "sectPr") continue

			for (let reference = document.firstChildElement(property); reference >= 0; reference = document.nextSiblingElement(reference)) {
				const name = document.localName(reference)

				if (name === "headerReference" || name === "footerReference") return true
			}
		}
	}

	return false
}

// Whether a paragraph's own properties hold the element `name` (w:sectPr: it ends a section; w:framePr: it is
// framed).
function hasProperty(part: StoryPart, paragraph: number, name: string): boolean {
	const document = part.document

	for (let child = document.firstChildElement(part.node(paragraph)); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === "pPr") {
			for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property))
				if (document.localName(property) === name) return true

			return false
		}

	return false
}

// Items that make a paragraph hold something besides its mark (text, objects, notes).
const CONTENT = new Set<number>([
	Item.Symbol,
	Item.Tab,
	Item.PositionalTab,
	Item.Break,
	Item.CarriageReturn,
	Item.NoBreakHyphen,
	Item.SoftHyphen,
	Item.Drawing,
	Item.VmlPicture,
	Item.EmbeddedObject,
	Item.FootnoteReference,
	Item.EndnoteReference,
	Item.PageNumber,
	Item.Math,
	Item.MathParagraph
])

// Whether a paragraph shows nothing but its mark with every change accepted.
function emptyInFinal(part: StoryPart, paragraph: number): boolean {
	for (let item = paragraph + 1; item < part.end(paragraph); item++) {
		const kind = part.kind(item)

		if (part.hidden(item, RevisionView.Final)) {
			item = part.end(item) - 1
			continue
		}

		if (CONTENT.has(kind) || (kind === Item.Text && part.text(item) !== "")) return false
	}

	return true
}

// Body-level paragraphs LibreOffice reads its own way (interop/accepted.ts): empty ones ending a section (it drops
// them), ones ending a section whose mark is deleted as a tracked change (it keeps them), ones whose mark moved
// away that also hold an insertion (it keeps them), framed ones (it may add a paragraph to anchor the frame); and
// whether the last section holds no paragraph (it gives it an empty one).
function libreOfficeParagraphs(
	part: StoryPart,
	story: Story
): {
	emptySection: number
	deletedSectionMark: number
	movedMarkInserted: number
	framed: number
	emptyLastSection: number
} {
	const out = {
		emptySection: 0,
		deletedSectionMark: 0,
		movedMarkInserted: 0,
		framed: 0,
		emptyLastSection: 0
	}
	let lastEndsSection = false

	for (let item = story.item + 1; item < part.end(story.item); item++) {
		const kind = part.kind(item)

		if (kind === Item.Table || OTHER_STORIES.has(kind)) {
			lastEndsSection = false
			item = part.end(item) - 1
			continue
		}

		if (kind !== Item.Paragraph) continue

		const section = hasProperty(part, item, "sectPr")
		const markHidden = part.paragraphMarkHidden(item, RevisionView.Final)

		lastEndsSection = section

		if (hasProperty(part, item, "framePr") && !dropCap(part, item)) out.framed++
		if (section && markHidden) out.deletedSectionMark++
		else if (section && emptyInFinal(part, item)) out.emptySection++

		if (markHidden && !section) {
			let inserted = false

			for (let inner = item + 1; inner < part.end(item) && !inserted; inner++) inserted = part.kind(inner) === Item.Insertion

			if (inserted && movedMark(part, item)) out.movedMarkInserted++
		}

		item = part.end(item) - 1
	}

	if (lastEndsSection) out.emptyLastSection = 1

	return out
}

// Whether a paragraph's mark carries w:moveFrom (moved away as a tracked change).
function movedMark(part: StoryPart, paragraph: number): boolean {
	const document = part.document

	for (let child = document.firstChildElement(part.node(paragraph)); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) !== "pPr") continue

		for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
			if (document.localName(property) !== "rPr") continue

			for (let mark = document.firstChildElement(property); mark >= 0; mark = document.nextSiblingElement(mark))
				if (document.localName(mark) === "moveFrom") return true
		}
	}

	return false
}

function mathChildren(part: StoryPart, item: number): number {
	const document = part.document
	const node = part.node(item)
	let count = 0

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === "oMath") count++

	return count
}

// Equations of stories LibreOffice may not import (interop/accepted.ts): note separators (it draws its own
// separator line), first-page and even-page headers and footers (it imports only those a page shows), and
// comments (it imports a comment's text only).
function storyEquations(model: DocxModel): {
	separators: number
	headers: number
	comments: number
} {
	const out = { separators: 0, headers: 0, comments: 0 }
	const shown = new Set<number>()
	const typed = new Set<number>()

	for (const section of model.sections)
		for (const set of [section.headers, section.footers]) {
			shown.add(set.default)
			typed.add(set.first)
			typed.add(set.even)
		}

	for (const story of model.stories) {
		const separator = (story.kind === "footnote" || story.kind === "endnote") && story.noteType !== "normal"
		const header = typed.has(story.index) && !shown.has(story.index)
		const comment = story.kind === "comment"

		if (!separator && !header && !comment) continue

		const part = model.parts[story.part] as StoryPart
		let equations = 0

		for (let item = story.item + 1; item < part.end(story.item); item++) {
			if (part.kind(item) === Item.Math) equations++
			else if (part.kind(item) === Item.MathParagraph) equations += mathChildren(part, item)
		}

		if (separator) out.separators += equations
		else if (comment) out.comments += equations
		else out.headers += equations
	}

	return out
}

// Floating drawings in notes of a document whose footer and header drawings are taller, together, than half its
// first page (max of each drawing's sides, a turn may stand it up): LibreOffice may lay such a document out forever
// (interop/accepted.ts).
function noteFloatsUnderTallFooters(model: DocxModel): number {
	const body = model.body
	const bodyPart = body === undefined ? undefined : model.parts[body.part]
	let pageHeight = 15840 * 635

	if (bodyPart !== undefined) {
		const document = bodyPart.document

		for (let node = 0; node < document.count; node++)
			if (document.localName(node) === "pgSz") {
				const h = Number(document.attributes(node).find(attribute => /(^|:)h$/.test(attribute.name))?.value)

				if (Number.isFinite(h) && h > 0) pageHeight = h * 635

				break
			}
	}

	const kindOf = new Map<number, string>()

	for (const story of model.stories) if (story.parent < 0) kindOf.set(story.part, story.kind)

	let tall = 0
	let floats = 0

	for (const drawing of model.drawings) {
		const kind = kindOf.get(drawing.part)

		if (kind === "footer" || kind === "header") tall += Math.max(drawing.width, drawing.height)
		else if ((kind === "footnote" || kind === "endnote") && drawing.placement === "anchor") floats++
	}

	return tall > pageHeight / 2 ? floats : 0
}

// 1 when the body's last block is a table (ECMA-376 Part 1 §17.2.2 allows it; Word keeps a paragraph after it):
// LibreOffice 26.8's plain-text export of such a body never ends (interop/accepted.ts).
function bodyEndsWithTable(model: DocxModel): number {
	const body = model.body

	if (body === undefined) return 0

	const part = model.parts[body.part] as StoryPart
	let last = -1

	for (let item = body.item + 1; item < part.end(body.item); item = part.end(item)) {
		const kind = part.kind(item)

		if (kind === Item.Paragraph || kind === Item.Table || kind === Item.Sdt) last = kind
	}

	return last === Item.Table ? 1 : 0
}

// Notes whose first block is a table: LibreOffice 7.5 may hang laying such a document out (interop/accepted.ts).
function notesStartingWithTable(model: DocxModel): number {
	let count = 0

	for (const story of model.stories) {
		if ((story.kind !== "footnote" && story.kind !== "endnote") || story.noteType !== "normal") continue

		const part = model.parts[story.part] as StoryPart

		if (story.item + 1 < part.end(story.item) && part.kind(story.item + 1) === Item.Table) count++
	}

	return count
}

// Whether a run's properties record a format change (w:rPrChange).
function formatChanged(part: StoryPart, run: number): boolean {
	const document = part.document

	for (let child = document.firstChildElement(part.node(run)); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) !== "rPr") continue

		for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property))
			if (document.localName(property) === "rPrChange") return true
	}

	return false
}

// Tracked changes LibreOffice represents its own way (interop/accepted.ts): inserted or deleted body runs that also
// record a format change, deletions of inserted or moved body text, and paragraph marks inserted or deleted in
// comments.
// Framed paragraphs in table cells (interop/accepted.ts: LibreOffice 7.5 then drops every tracked change).
function framedCellParagraphs(model: DocxModel): number {
	const body = model.body

	if (body === undefined) return 0

	const part = model.parts[body.part] as StoryPart
	let count = 0

	for (let item = body.item + 1; item < part.end(body.item); item++) {
		if (part.kind(item) !== Item.Paragraph || !hasProperty(part, item, "framePr")) continue

		for (let at = part.parent(item); at >= 0; at = part.parent(at))
			if (part.kind(at) === Item.Cell) {
				count++
				break
			}
	}

	return count
}

// Whether `node`'s subtree holds an element named `local` (whose attribute `attribute`, when given, starts with
// `prefix`).
function holds(part: StoryPart, node: number, local: string, attribute?: string, prefix?: string): boolean {
	const document = part.document

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (
			document.localName(child) === local &&
			(attribute === undefined ||
				(
					document.attributes(child).find(entry => entry.name === attribute || entry.name.endsWith(`:${attribute}`))?.value ?? ""
				).startsWith(prefix ?? ""))
		)
			return true
		if (holds(part, child, local, attribute, prefix)) return true
	}

	return false
}

// Constructs LibreOffice reads as Word does but writes back differently in its DOCX (what G7 compares), counted in
// the body (interop/accepted.ts).
function exportWitnesses(model: DocxModel): {
	tocLinks: number
	bodyWatermarks: number
	placeholderChanges: number
	linkBeforeTextboxGroup: number
} {
	const out = {
		tocLinks: 0,
		bodyWatermarks: 0,
		placeholderChanges: 0,
		linkBeforeTextboxGroup: 0
	}
	const body = model.body

	if (body === undefined) return out

	const part = model.parts[body.part] as StoryPart
	const document = part.document
	const computed = computedResults(part)
	const end = part.end(body.item)
	let paragraph = -1
	let linked = false

	for (let item = body.item + 1; item < end; item++) {
		const kind = part.kind(item)

		if (kind === Item.Paragraph) {
			if (paragraph < 0 || item >= part.end(paragraph)) {
				paragraph = item
				linked = false
			}
		} else if (kind === Item.Hyperlink) {
			linked = true

			// A link to a "_Toc" bookmark outside an index: LibreOffice writes its text as a PAGEREF field's result.
			const anchor = document.attributes(part.node(item)).find(entry => /(^|:)anchor$/.test(entry.name))?.value ?? ""

			if (anchor.startsWith("_Toc") && computed[item] === 0) out.tocLinks++
		} else if (kind === Item.VmlPicture) {
			// Word's watermark shape (id "PowerPlusWaterMarkObject…") in the body: LibreOffice drops its paragraph.
			if (holds(part, part.node(item), "shape", "id", "PowerPlusWaterMarkObject")) out.bodyWatermarks++
		} else if (kind === Item.Drawing && linked && holds(part, part.node(item), "wgp") && holds(part, part.node(item), "txbxContent")) {
			// A drawing group with a text box after a link in its paragraph: LibreOffice 7.5 writes malformed XML.
			out.linkBeforeTextboxGroup++
		}
	}

	// Tracked changes in a block content control showing its placeholder: LibreOffice 7.5 reads the control as an
	// input field ending in a carriage return and moves the changes to its end.
	for (let sdt = 0; sdt < part.sdts.count; sdt++) {
		const item = part.sdts.item[sdt] ?? -1
		const sdtPr = part.sdts.sdtPr[sdt] ?? -1

		if (item < 0 || part.sdts.level[sdt] !== SdtLevel.Block || sdtPr < 0 || !holds(part, sdtPr, "showingPlcHdr")) continue

		for (let inner = item + 1; inner < part.end(item); inner++) {
			const kind = part.kind(inner)

			if (
				kind === Item.Insertion ||
				kind === Item.Deletion ||
				kind === Item.MoveFrom ||
				kind === Item.MoveTo ||
				(kind === Item.Paragraph &&
					(part.paragraphMarkHidden(inner, RevisionView.Final) || part.paragraphMarkHidden(inner, RevisionView.Original)))
			)
				out.placeholderChanges++
		}
	}

	return out
}

function changeWitnesses(model: DocxModel): {
	formattedChangeRuns: number
	nestedDeletions: number
	commentMarkRevisions: number
} {
	const out = {
		formattedChangeRuns: 0,
		nestedDeletions: 0,
		commentMarkRevisions: 0
	}
	const body = model.body

	if (body !== undefined) {
		const part = model.parts[body.part] as StoryPart
		let inserted = -1
		let changed = -1

		for (let item = body.item + 1; item < part.end(body.item); item++) {
			const kind = part.kind(item)

			if (item < inserted && kind === Item.Deletion) out.nestedDeletions++
			if ((kind === Item.Insertion || kind === Item.MoveTo) && item >= inserted) inserted = part.end(item)
			if ((kind === Item.Insertion || kind === Item.Deletion) && item >= changed) changed = part.end(item)
			else if (item < changed && kind === Item.Run && formatChanged(part, item)) out.formattedChangeRuns++
		}
	}

	for (const story of model.stories) {
		if (story.kind !== "comment") continue

		const part = model.parts[story.part] as StoryPart

		for (let item = story.item + 1; item < part.end(story.item); item++)
			if (
				part.kind(item) === Item.Paragraph &&
				(part.paragraphMarkHidden(item, RevisionView.Final) || part.paragraphMarkHidden(item, RevisionView.Original))
			)
				out.commentMarkRevisions++
	}

	return out
}

// Body note references whose custom mark (w:customMarkFollows, the text after the reference in its run) is longer
// than one character: LibreOffice also keeps such a mark as body text (interop/accepted.ts).
function longCustomMarks(model: DocxModel): number {
	const body = model.body

	if (body === undefined) return 0

	const part = model.parts[body.part] as StoryPart
	const document = part.document
	let count = 0

	for (let item = body.item + 1; item < part.end(body.item); item++) {
		const kind = part.kind(item)

		if (kind !== Item.FootnoteReference && kind !== Item.EndnoteReference) continue

		const custom = document.attributes(part.node(item)).find(attribute => /(^|:)customMarkFollows$/.test(attribute.name))?.value

		if (custom !== "1" && custom !== "true" && custom !== "on") continue

		let mark = ""

		for (let inner = item + 1; inner < part.count && part.kind(inner) === Item.Text; inner++) mark += part.text(inner)

		if ([...mark].length > 1) count++
	}

	return count
}

// Whether a table's own properties place it floating (w:tblPr/w:tblpPr).
function floatingTable(part: StoryPart, table: number): boolean {
	const document = part.document

	for (let child = document.firstChildElement(part.node(table)); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === "tblPr") {
			for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property))
				if (document.localName(property) === "tblpPr") return true

			return false
		}

	return false
}

// The paragraph an item is in (-1 for none).
function paragraphOf(part: StoryPart, from: number, item: number): number {
	for (let at = item - 1; at > from; at--) if (part.kind(at) === Item.Paragraph && part.end(at) > item) return at

	return -1
}

const BLOCKS = new Set<number>([Item.Paragraph, Item.Table, Item.Sdt])
const ANNOTATIONS = new Set<number>([Item.FootnoteReference, Item.EndnoteReference, Item.CommentRangeStart, Item.CommentReference])

// Constructs LibreOffice reads its own way around content controls, comments and tracked paragraph marks
// (interop/accepted.ts), in the body:
// - commentsAfterShapeRange: comments with no text in their range after the end of another comment's range
//   that holds a drawing, referenced before that comment's reference (LibreOffice 26.8 drops them);
// - insertedSectionMarks: paragraph marks inserted as a tracked change that end a section with headers or
//   footers of its own (rejected, LibreOffice keeps the paragraph);
// - insertedAnchorMarks: paragraph marks inserted as a tracked change in a paragraph holding a floating drawing
//   (rejected, LibreOffice keeps the paragraph);
// - boundDateControls: date controls bound to custom XML (LibreOffice 7.5 shows the bound value as a date);
// - blockControlRevisions, blockControlInsertedMarks: tracked changes, and inserted paragraph marks, inside
//   block-level content controls (LibreOffice 7.5 reads the control as an input field that keeps no change).
function controlWitnesses(model: DocxModel): {
	commentsAfterShapeRange: number
	insertedSectionMarks: number
	insertedAnchorMarks: number
	boundDateControls: number
	blockControlRevisions: number
	blockControlInsertedMarks: number
} {
	const out = {
		commentsAfterShapeRange: 0,
		insertedSectionMarks: 0,
		insertedAnchorMarks: 0,
		boundDateControls: 0,
		blockControlRevisions: 0,
		blockControlInsertedMarks: 0
	}
	const body = model.body

	if (body === undefined) return out

	const part = model.parts[body.part] as StoryPart
	const end = part.end(body.item)
	const document = part.document
	// Comment rows with an open range, and whether it holds a drawing; ranges holding one that ended before their
	// reference; whether a range has text after the last such end.
	const open = new Map<number, boolean>()
	const pending = new Set<number>()
	const text = new Map<number, boolean>()

	for (let item = body.item + 1; item < end; item++) {
		const kind = part.kind(item)
		const row = part.aux[item] ?? -1

		if (kind === Item.CommentRangeStart) {
			open.set(row, false)
			text.set(row, false)
		} else if (kind === Item.Drawing || kind === Item.VmlPicture) {
			for (const key of open.keys()) open.set(key, true)
		} else if (kind === Item.Text && part.text(item) !== "") {
			for (const key of text.keys()) text.set(key, true)
		} else if (kind === Item.CommentRangeEnd) {
			if (open.get(row) === true) {
				pending.add(row)

				for (const key of open.keys()) text.set(key, false)
			}

			open.delete(row)
		} else if (kind === Item.CommentReference) {
			if ([...pending].some(other => other !== row) && text.get(row) !== true) out.commentsAfterShapeRange++

			pending.delete(row)
			text.delete(row)
		} else if (kind === Item.Paragraph && part.paragraphMarkHidden(item, RevisionView.Original)) {
			if (ownHeaders(part, item)) out.insertedSectionMarks++

			for (let inner = item + 1; inner < part.end(item); inner++)
				if (part.kind(inner) === Item.Drawing && anchoredDrawing(part, inner)) {
					out.insertedAnchorMarks++
					break
				}
		}
	}

	for (let sdt = 0; sdt < part.sdts.count; sdt++) {
		const item = part.sdts.item[sdt] ?? -1
		const sdtPr = part.sdts.sdtPr[sdt] ?? -1

		if (item < 0) continue

		if (sdtPr >= 0) {
			let bound = false
			let date = false

			for (let child = document.firstChildElement(sdtPr); child >= 0; child = document.nextSiblingElement(child)) {
				const name = document.localName(child)

				if (name === "dataBinding") bound = true
				else if (name === "date") date = true
			}

			if (bound && date) out.boundDateControls++
		}

		if (part.sdtLevel(sdt) !== SdtLevel.Block) continue

		for (let inner = item + 1; inner < part.end(item); inner++) {
			const kind = part.kind(inner)

			if (kind === Item.Insertion || kind === Item.Deletion) out.blockControlRevisions++
			else if (kind === Item.Paragraph && part.paragraphMarkHidden(inner, RevisionView.Original)) {
				out.blockControlRevisions++
				out.blockControlInsertedMarks++
			} else if (kind === Item.Paragraph && part.paragraphMarkHidden(inner, RevisionView.Final)) out.blockControlRevisions++
		}
	}

	return out
}

// Body constructs LibreOffice lays out in paragraphs its own way (interop/accepted.ts): a body that starts with a
// table and holds a note reference or a comment (7.5 puts an empty paragraph before the table); floating tables
// directly followed by a table (26.8 gives them an empty anchor paragraph); paragraphs that start with a break and
// hold a note reference after a custom-marked note (26.8 moves the break to the reference and splits there); TOC
// fields in a block content control whose begin follows text in its paragraph (the text keeps a paragraph of its
// own); TOC fields whose end's paragraph mark is deleted (the index keeps its last paragraph apart); paragraphs of
// floating tables' rows inserted or deleted as tracked changes (held in a text frame, where the rows' changes are
// not row changes).
function layoutWitnesses(model: DocxModel): {
	startTableAnnotated: number
	floatingTableBeforeTable: number
	customMarkBreaks: number
	tocSdtLeadingText: number
	indexTailDeletedMarks: number
	floatingTrackedRows: number
} {
	const out = {
		startTableAnnotated: 0,
		floatingTableBeforeTable: 0,
		customMarkBreaks: 0,
		tocSdtLeadingText: 0,
		indexTailDeletedMarks: 0,
		floatingTrackedRows: 0
	}
	const body = model.body

	if (body === undefined) return out

	const part = model.parts[body.part] as StoryPart
	const end = part.end(body.item)
	const document = part.document
	let firstBlock = -1
	let annotated = false
	let previousTable = -1
	let seenCustom = false

	for (let item = body.item + 1; item < end; item++) {
		const kind = part.kind(item)

		if (OTHER_STORIES.has(kind)) {
			item = part.end(item) - 1
			continue
		}

		if (ANNOTATIONS.has(kind)) annotated = true
		if (firstBlock < 0 && (kind === Item.Paragraph || kind === Item.Table)) firstBlock = kind

		if (kind === Item.Table && floatingTable(part, item)) {
			for (let row = item + 1; row < part.end(item); row++) {
				if (part.kind(row) !== Item.Row) continue

				if (part.hidden(row, RevisionView.Final) || part.hidden(row, RevisionView.Original))
					for (let inner = row + 1; inner < part.end(row); inner++)
						if (part.kind(inner) === Item.Paragraph) out.floatingTrackedRows++
			}
		}

		if (kind === Item.Paragraph) {
			const stop = part.end(item)
			let startsWithBreak: boolean | undefined
			let note = false
			let custom = false

			for (let inner = item + 1; inner < stop; inner++) {
				const innerKind = part.kind(inner)

				if (startsWithBreak === undefined && innerKind === Item.Break)
					startsWithBreak = part.breakType(inner) !== BreakType.TextWrapping
				else if (startsWithBreak === undefined && innerKind === Item.Text && part.text(inner) !== "") startsWithBreak = false

				if (innerKind === Item.FootnoteReference || innerKind === Item.EndnoteReference) {
					note = true

					const value = document
						.attributes(part.node(inner))
						.find(attribute => /(^|:)customMarkFollows$/.test(attribute.name))?.value

					if (value === "1" || value === "true" || value === "on") custom = true
				}
			}

			if (seenCustom && note && startsWithBreak === true) out.customMarkBreaks++
			if (custom) seenCustom = true
		}
	}

	// Top-level blocks in order (wrappers' children at their own level).
	for (let item = body.item + 1; item < end; item++) {
		const kind = part.kind(item)

		if (kind === Item.Sdt || kind === Item.CustomXml) continue
		if (!BLOCKS.has(kind)) continue

		if (kind === Item.Table) {
			if (previousTable >= 0 && part.end(previousTable) <= item) out.floatingTableBeforeTable++

			previousTable = floatingTable(part, item) ? item : -1
		} else previousTable = -1

		item = part.end(item) - 1
	}

	if (firstBlock === Item.Table && annotated) out.startTableAnnotated = 1

	const fields = part.fields

	for (let field = 0; field < fields.count; field++) {
		if (part.fieldType(field) !== "TOC" || fields.simple[field] === 1) continue

		const begin = fields.begin[field] ?? -1
		const fieldEnd = fields.end[field] ?? -1

		if (begin < 0) continue

		const paragraph = paragraphOf(part, body.item, begin)
		let inSdt = false

		for (let at = begin - 1; at > body.item && !inSdt; at--) inSdt = part.kind(at) === Item.Sdt && part.end(at) > begin

		if (inSdt && paragraph >= 0) {
			let before = false

			for (let inner = paragraph + 1; inner < begin && !before; inner++)
				before = part.kind(inner) === Item.Text && part.text(inner) !== ""

			if (before) out.tocSdtLeadingText++
		}

		const last = fieldEnd < 0 ? -1 : paragraphOf(part, body.item, fieldEnd)

		if (last >= 0 && part.paragraphMarkHidden(last, RevisionView.Final)) out.indexTailDeletedMarks++
	}

	return out
}

function countsOf(model: DocxModel): Record<string, number> {
	const stats = modelStats(model, { fieldTypes: true })
	let bodyParagraphs = 0
	let equations = 0
	let images = 0
	// Equations in cells continuing a vertical merge (LibreOffice keeps no content there: interop/accepted.ts).
	let coveredEquations = 0
	const body = model.body

	for (const part of model.parts) {
		let coveredEnd = -1

		for (let item = 0; item < part.count; item++) {
			const kind = part.kind(item)
			let found = 0

			if (item >= coveredEnd && kind === Item.Cell && coveredCell(part, item)) coveredEnd = part.end(item)
			if (kind === Item.Math) found = 1
			// A display equation is kept whole: its m:oMath children count (as LibreOffice makes an object of each).
			else if (kind === Item.MathParagraph) found = mathChildren(part, item)
			// An embedded Microsoft Equation 3.0 object: LibreOffice reads it as an equation of its own.
			else if (kind === Item.EmbeddedObject && model.vml[part.aux[item] ?? -1]?.progId === "Equation.3") found = 1
			if (kind === Item.VmlPicture) images++

			equations += found
			if (item < coveredEnd) coveredEquations += found
		}
	}

	const inBody = { tables: 0, rows: 0, cells: 0, textboxTables: 0, textboxRows: 0 }
	let lo = {
		emptySection: 0,
		deletedSectionMark: 0,
		movedMarkInserted: 0,
		framed: 0,
		emptyLastSection: 0
	}
	let breakAnchors = 0

	// Paragraphs of the body with every change accepted (as an ODF body holds them), and the body part's tables
	// (headers are counted once here, once per page style in LibreOffice).
	if (body !== undefined) {
		const part = model.parts[body.part] as StoryPart

		// Rows and cells deleted as tracked changes stay: ODF cannot hold their deletion, so LibreOffice keeps them,
		// each cell with the paragraph it ends with. Cells continuing a vertical merge are ODF's covered cells.
		const lines = storyLines(part, body, RevisionView.Final, true)

		bodyParagraphs = lines.paragraphs
		breakAnchors = lines.breakAnchors
		lo = libreOfficeParagraphs(part, body)

		for (let item = 0; item < part.count; item++) {
			const kind = part.kind(item)

			if (kind === Item.Table) {
				inBody.tables++

				if (inDrawingTextbox(part, item)) inBody.textboxTables++
			} else if (kind === Item.Row) {
				inBody.rows++

				if (inDrawingTextbox(part, item)) inBody.textboxRows++

				// Grid columns a row leaves out before or after its cells (w:gridBefore, w:gridAfter): an ODF row
				// has no such gap, so LibreOffice fills each with an empty cell (one paragraph).
				const grid = gridGap(part, item)

				inBody.cells += grid
				bodyParagraphs += grid
			} else if (kind === Item.Cell && !coveredCell(part, item)) inBody.cells++
		}
	}

	const stories = storyEquations(model)
	const changes = changeWitnesses(model)
	const layout = layoutWitnesses(model)
	const notes = (map: ReadonlyMap<string, Story>): number => [...map.values()].filter(story => story.noteType === "normal").length
	const sdts = stats.sdts

	return {
		paragraphs: stats.paragraphs,
		bodyParagraphs,
		emptySectionParagraphs: lo.emptySection,
		deletedSectionMarks: lo.deletedSectionMark,
		movedMarksInserted: lo.movedMarkInserted,
		framedParagraphs: lo.framed,
		emptyLastSection: lo.emptyLastSection,
		tables: inBody.tables,
		rows: inBody.rows,
		cells: inBody.cells,
		drawingTextboxTables: inBody.textboxTables,
		drawingTextboxRows: inBody.textboxRows,
		comments: stats.comments,
		insertions: (stats.revisions["Insertion"] ?? 0) + (stats.revisions["MoveTo"] ?? 0),
		deletions: (stats.revisions["Deletion"] ?? 0) + (stats.revisions["MoveFrom"] ?? 0),
		formatChanges: (stats.revisions["RunProperties"] ?? 0) + (stats.revisions["ParagraphProperties"] ?? 0),
		footnotes: notes(model.footnotes),
		endnotes: notes(model.endnotes),
		headers: stats.stories["header"] ?? 0,
		footers: stats.stories["footer"] ?? 0,
		images: images + (stats.drawings["picture"] ?? 0),
		drawings: Object.values(stats.drawings).reduce((sum, value) => sum + value, 0),
		fields: stats.fields.complex + stats.fields.simple,
		toc: stats.fieldTypes["TOC"] ?? 0,
		sections: stats.sections,
		bookmarks: stats.bookmarks,
		contentControls: sdts.block + sdts.run + sdts.row + sdts.cell,
		equations,
		separatorEquations: stories.separators,
		coveredEquations,
		formattedChangeRuns: changes.formattedChangeRuns,
		nestedDeletions: changes.nestedDeletions,
		longCustomMarks: longCustomMarks(model),
		commentMarkRevisions: changes.commentMarkRevisions,
		framedCellParagraphs: framedCellParagraphs(model),
		notesStartingWithTable: notesStartingWithTable(model),
		bodyEndsWithTable: bodyEndsWithTable(model),
		noteFloatsUnderTallFooters: noteFloatsUnderTallFooters(model),
		headerEquations: stories.headers,
		commentEquations: stories.comments,
		nestedTocs: nestedTocs(model),
		...exportWitnesses(model),
		breakAnchors,
		...layout,
		...controlWitnesses(model)
	}
}

export async function summarizeDocument(bytes: Uint8Array): Promise<DocumentSummary | undefined> {
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) return undefined

	const model = await buildDocxModel(opened.package)
	const body = model.body
	// Changes accepted and rejected as an ODF body holds them (rows deleted or inserted as tracked changes stay, as in
	// the counts); shown as they are.
	const text = (view: RevisionView | undefined): string =>
		body === undefined ? "" : storyLines(model.parts[body.part] as StoryPart, body, view, view !== undefined).lines.join("\n")

	return {
		final: text(RevisionView.Final),
		original: text(RevisionView.Original),
		markup: text(undefined),
		counts: countsOf(model)
	}
}

// FNV-1a over the run's identity: which runs keep their saves under FILEN_OFFICE_FUZZ_SAVES_EVERY.
function sampled(config: SavesConfig, key: string): boolean {
	if (config.every === 1) return true

	let hash = 0x811c9dc5

	for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193)

	return (hash >>> 0) % config.every === 0
}

export interface SaveInput {
	readonly source: string
	readonly sourceBytes: Uint8Array
	readonly family: string
	readonly harness: SaveSidecar["harness"]
	readonly mode: string
	readonly seed: number
	readonly n: number
	readonly view: string
	readonly endView: string
	readonly ops: readonly string[]
	readonly changedParts: readonly string[]
	readonly bytes: Uint8Array
}

// A save's name without its extension: <corpus stem>.<source extension>__s<seed>__<n>. The save is this name with the
// source's extension last (LibreOffice picks its import filter from it), its sidecar this name with .json.
export function saveName(stem: string, extension: string, seed: number, n: number): string {
	return `${stem}.${extension.slice(1)}__s${seed}__${n}`
}

// Writes one save and its sidecar (each to a temporary name first, so a reader never sees half a file);
// false when the run is not sampled or the source is too big.
export async function writeSave(
	config: SavesConfig,
	input: SaveInput,
	before: () => Promise<DocumentSummary | undefined>
): Promise<boolean> {
	if (input.sourceBytes.length > config.maxBytes) return false
	if (!sampled(config, `${input.source}|${input.harness}|${input.seed}|${input.n}`)) return false

	const after = await summarizeDocument(input.bytes)
	const was = await before()

	if (after === undefined || was === undefined) return false

	const extension = extname(input.source) || ".docx"
	const stem = basename(input.source, extension)
	const directory = join(config.dir, input.family)
	// The source's extension in the name too: corpus files of one stem (a .docm and a .dotm) keep a sidecar each.
	const name = saveName(stem, extension, input.seed, input.n)
	const sidecar: SaveSidecar = {
		source: input.source,
		family: input.family,
		harness: input.harness,
		mode: input.mode,
		seed: input.seed,
		n: input.n,
		view: input.view,
		endView: input.endView,
		ops: input.ops,
		changedParts: input.changedParts,
		oursBefore: was.final,
		oursAfter: after.final,
		oursBeforeOriginal: was.original,
		oursAfterOriginal: after.original,
		oursBeforeMarkup: was.markup,
		oursAfterMarkup: after.markup,
		countsBefore: was.counts,
		counts: after.counts,
		sha256: createHash("sha256").update(input.bytes).digest("hex"),
		bytes: input.bytes.length
	}

	mkdirSync(directory, { recursive: true })

	const file = join(directory, `${name}${extension}`)

	writeFileSync(`${file}.part`, input.bytes)
	renameSync(`${file}.part`, file)
	writeFileSync(join(directory, `${name}.json.part`), JSON.stringify(sidecar))
	renameSync(join(directory, `${name}.json.part`), join(directory, `${name}.json`))

	return true
}

export interface ManifestEntry {
	readonly source: string
	readonly family: string
	readonly harness: string
	readonly mode: string
	readonly seed: number
	readonly n: number
	readonly view: string
	readonly endView: string
	// Relative to the saves directory.
	readonly path: string
	readonly sidecar: string
	readonly bytes: number
	readonly changedParts: readonly string[]
}

// Lists every save with a sidecar in <dir>/manifest.json (sorted, rewritten whole); returns the count.
export function writeManifest(dir: string): number {
	const entries: ManifestEntry[] = []

	if (!existsSync(dir)) return 0

	for (const family of readdirSync(dir).sort()) {
		const directory = join(dir, family)

		if (!statSync(directory).isDirectory()) continue

		for (const name of readdirSync(directory).sort()) {
			if (!name.endsWith(".json")) continue

			let sidecar: SaveSidecar

			try {
				sidecar = JSON.parse(readFileSync(join(directory, name), "utf8")) as SaveSidecar
			} catch {
				continue
			}

			const extension = extname(sidecar.source) || ".docx"
			const path = join(directory, `${name.slice(0, -".json".length)}${extension}`)

			if (!existsSync(path)) continue

			entries.push({
				source: sidecar.source,
				family: sidecar.family,
				harness: sidecar.harness,
				mode: sidecar.mode,
				seed: sidecar.seed,
				n: sidecar.n,
				view: sidecar.view,
				endView: sidecar.endView,
				path: relative(dir, path),
				sidecar: relative(dir, join(directory, name)),
				bytes: sidecar.bytes,
				changedParts: sidecar.changedParts
			})
		}
	}

	const manifest = join(dir, "manifest.json")

	writeFileSync(
		`${manifest}.part`,
		JSON.stringify(
			{
				contract:
					"<family>/<corpus stem>.<ext>__s<seed>__<n>.<ext> + sidecar <corpus stem>.<ext>__s<seed>__<n>.json (source, family, harness, mode, seed, view, ops, oursBefore/After text, counts); n: paged 3*mode+view, damage sequence 0, script 0",
				count: entries.length,
				entries
			},
			null,
			1
		)
	)
	renameSync(`${manifest}.part`, manifest)

	return entries.length
}
