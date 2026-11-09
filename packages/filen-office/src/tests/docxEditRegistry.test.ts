import { TextSelection, type Transaction } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import {
	BLOCK_NODE_MARKS,
	DOCX_COMMAND_FEATURES,
	DOCX_EDITOR_COMMANDS,
	DocxEditorSession,
	DocxIds,
	DocxMediaStore,
	authorInitials,
	REVERTIBLE_UNITS,
	commandInfo,
	docxSchema,
	documentHandler,
	findUnsavableBlocks,
	parseDocxEditorCommand,
	registeredTransformer,
	storyHandler,
	writableNew,
	INLINE_MARK_NAMES,
	type DocxEditorCommand,
	type DocxEditorCommandType
} from "@filen/office/core/docx/edit"
import { RevisionView } from "@filen/office/core/docx"
import { markCommand } from "../core/docx/edit/invariants/index"
import { openSpec, sessionOf } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedFixtures"

// A valid example of every command, as an app or a bridge sends it.
const EXAMPLES: Readonly<Record<DocxEditorCommandType, object>> = {
	"format.bold": {},
	"format.italic": {},
	"format.underline": {},
	"format.strike": {},
	"format.clear": {},
	"style.set": { style: "heading2" },
	"align.start": {},
	"align.center": {},
	"align.end": {},
	"align.justify": {},
	"list.bullet": {},
	"list.numbered": {},
	"list.indent": {},
	"list.outdent": {},
	"history.undo": {},
	"history.redo": {},
	"format.superscript": {},
	"format.subscript": {},
	"format.doubleStrike": {},
	"format.smallCaps": {},
	"format.allCaps": {},
	"format.doubleUnderline": {},
	"format.changeCase": {},
	"format.clearAll": {},
	"font.family": { family: "Calibri" },
	"font.size": { halfPoints: 24 },
	"font.grow": {},
	"font.shrink": {},
	"font.growPoint": {},
	"font.shrinkPoint": {},
	"font.spacing": { twips: -10 },
	"color.text": { color: { kind: "theme", theme: "accent1", tint: 153 } },
	"color.highlight": { name: "yellow" },
	"paragraph.lineSpacing": { rule: "auto", value: 276 },
	"paragraph.spacing": { before: 120, after: 0 },
	"paragraph.indent": { start: 720, hanging: 360 },
	"paragraph.hangingIndent": { direction: 1 },
	"format.copy": {},
	"format.paste": {},
	"link.set": { target: "https://filen.io/", text: "Filen" },
	"link.remove": {},
	"insert.pageBreak": {},
	"insert.lineBreak": {},
	"insert.horizontalLine": {},
	"insert.symbol": { text: "\u00a9" },
	"comment.add": { text: "Looks good\nSecond paragraph" },
	"comment.reply": { id: "3", text: "Agreed" },
	"comment.edit": { id: "3", text: "Edited" },
	"comment.resolve": { id: "3" },
	"comment.reopen": { id: "3" },
	"comment.delete": { id: "3" },
	"comment.next": {},
	"comment.prev": {},
	"review.track": { on: true },
	"review.accept": { id: "12" },
	"review.reject": {},
	"review.acceptAll": {},
	"review.rejectAll": {},
	"review.next": {},
	"review.prev": {},
	"view.markup": { mode: "all" },
	"table.insert": { rows: 3, cols: 4 },
	"table.delete": {},
	"table.row.insertAbove": {},
	"table.row.insertBelow": {},
	"table.row.delete": {},
	"table.column.insertLeft": {},
	"table.column.insertRight": {},
	"table.column.delete": {},
	"table.cells.merge": {},
	"table.cell.split": { rows: 1, cols: 2 },
	"table.row.header": {},
	"table.style": { styleId: "TableGrid" },
	"table.align": { align: "center" },
	"table.column.width": { index: 1, twips: 2400 },
	"table.cell.shading": { fill: "FFEE00" },
	"table.cell.vAlign": { align: "bottom" },
	"table.distributeColumns": {},
	"insert.sectionBreak": { kind: "nextPage" },
	"header.edit": {},
	"footer.edit": {},
	"header.differentFirst": {},
	"header.differentOddEven": {},
	"header.linkToPrevious": {},
	"header.remove": {},
	"footer.remove": {},
	"section.deleteBreak": {},
	"page.setup": { orientation: "landscape", margins: { top: 1440, left: 1080 }, columns: { count: 2, space: 720 } },
	"note.insertFootnote": {},
	"note.insertEndnote": {},
	"note.goto": {},
	"note.delete": {},
	"note.convert": {},
	"note.convertAll": { to: "endnote" },
	"note.options": { kind: "footnote", format: "lowerRoman", restart: "eachPage", scope: "document" },
	"field.update": {},
	"field.updateAll": {},
	"field.unlink": {},
	"toc.insert": { levels: 3, hyperlinks: true },
	"toc.update": { pagesOnly: false },
	"insert.pageNumber": {},
	"insert.pageCount": {},
	"insert.date": { format: "d MMMM yyyy" },
	"bookmark.add": { name: "Results2026" },
	"insert.field": { instruction: "SEQ Figure \\* ARABIC" },
	"bookmark.delete": { name: "_Toc123" },
	"bookmark.rename": { name: "Results2026", to: "Results2027" },
	"control.check": {},
	"control.choose": { value: "Option B" },
	"control.date": { iso: "2026-10-12" },
	"control.clear": {},
	"control.text": { text: "Jane Doe" },
	"control.items": {
		items: [
			{ text: "Yes", value: "Y" },
			{ text: "No", value: "N" }
		]
	},
	"control.insert": {
		kind: "dropDownList",
		items: [
			{ text: "Yes", value: "Y" },
			{ text: "No", value: "N" }
		]
	},
	"control.item.add": {},
	"control.item.remove": {},
	"image.insert": { media: 1 },
	"drawing.resize": { cx: 914400, cy: 457200, keepRatio: true },
	"drawing.position": { x: 0, y: -12700, relH: "page", relV: "paragraph" },
	"drawing.wrap": { mode: "square" },
	"drawing.altText": { text: "A chart of results" },
	"drawing.rotate": { by: 90 },
	"drawing.crop": { left: 10000, top: 0, right: 5000, bottom: -2000 },
	"drawing.delete": {},
	"equation.insert": { latex: "\\frac{a}{b}", display: true },
	"equation.edit": { latex: "x^2" },
	"view.reflow": { on: true },
	"view.fieldCodes": {},
	"view.fieldCode": {},
	"view.formattingMarks": {}
}

// Arguments each command must refuse.
const INVALID: readonly object[] = [
	{ type: "font.family", family: "" },
	{ type: "font.family", family: "x".repeat(32) },
	{ type: "font.size", halfPoints: 1 },
	{ type: "font.size", halfPoints: 24.5 },
	{ type: "color.text", color: { kind: "rgb", value: "#FF0000" } },
	{ type: "color.text", color: { kind: "theme", theme: "accent9" } },
	{ type: "color.text", color: { kind: "theme", theme: "accent1", shade: 300 } },
	{ type: "color.highlight", name: "pink" },
	{ type: "paragraph.lineSpacing", rule: "double", value: 2 },
	{ type: "paragraph.spacing" },
	{ type: "paragraph.indent", firstLine: 360, hanging: 360 },
	{ type: "link.set" },
	{ type: "link.set", target: "https://a", anchor: "B" },
	{ type: "link.set", target: "https://a\u0000b" },
	{ type: "link.set", anchor: "1starts-with-digit" },
	{ type: "comment.add" },
	{ type: "comment.reply", id: "abc", text: "x" },
	{ type: "comment.resolve", id: 3 },
	{ type: "review.track", on: "yes" },
	{ type: "view.markup", mode: "fancy" },
	{ type: "table.insert", rows: 0, cols: 2 },
	{ type: "table.insert", rows: 2, cols: 64 },
	{ type: "table.cell.shading", fill: "red" },
	{ type: "table.column.width", index: 63, twips: 100 },
	{ type: "insert.sectionBreak", kind: "page" },
	{ type: "page.setup" },
	{ type: "page.setup", size: { width: 10, height: 15840 } },
	{ type: "page.setup", columns: { count: 46 } },
	{ type: "toc.insert", levels: 10, hyperlinks: true },
	{ type: "insert.date", format: "<script>" },
	{ type: "bookmark.add", name: "_Toc123" },
	{ type: "insert.field", instruction: "MERGEFIELD Name" },
	{ type: "insert.field", instruction: "PAGE\u0000" },
	{ type: "bookmark.rename", name: "Results", to: "_Toc1" },
	{ type: "control.date", iso: "2026-02-30" },
	{ type: "control.text", text: "a\u0007b" },
	{ type: "control.insert", kind: "button" },
	{ type: "control.items", items: "Yes" },
	{
		type: "control.items",
		items: [
			{ text: "a", value: "a" },
			{ text: "a", value: "b" }
		]
	},
	{ type: "control.insert", kind: "checkbox", items: [{ text: "a", value: "a" }] },
	{
		type: "control.insert",
		kind: "comboBox",
		items: [
			{ text: "a", value: "a" },
			{ text: "b", value: "a" }
		]
	},
	{ type: "image.insert", media: 0 },
	{ type: "image.insert", media: "1" },
	{ type: "drawing.resize", cx: 0, cy: 10 },
	{ type: "drawing.wrap", mode: "around" },
	{ type: "drawing.rotate", by: 45 },
	{ type: "drawing.altText", text: "bell\u0007" },
	{ type: "drawing.crop", left: 60000, top: 0, right: 40000, bottom: 0 },
	{ type: "drawing.crop", left: 0, top: 0, right: 0 },
	{ type: "image.insert", media: 2, fallback: 2 },
	{ type: "equation.insert", latex: "x" },
	{ type: "view.reflow" }
]

// Commands of features whose handlers have not landed (those that have are covered by their own tests).
const FEATURE_TYPES = DOCX_EDITOR_COMMANDS.map(info => info.type).filter(
	type =>
		!DOCX_COMMAND_FEATURES.base.some(info => info.type === type) &&
		storyHandler(type) === undefined &&
		documentHandler(type) === undefined
)

function command(type: DocxEditorCommandType): DocxEditorCommand {
	const parsed = parseDocxEditorCommand({ type, ...EXAMPLES[type] })

	if (parsed === undefined) throw new Error(`${type} does not parse`)

	return parsed
}

describe("docx editor command registry", () => {
	it("describes the whole catalogue with serialisable metadata", () => {
		const types = DOCX_EDITOR_COMMANDS.map(info => info.type)

		expect(new Set(types).size).toBe(types.length)
		expect(Object.keys(EXAMPLES).sort()).toEqual([...types].sort())
		expect(JSON.parse(JSON.stringify(DOCX_EDITOR_COMMANDS))).toEqual(DOCX_EDITOR_COMMANDS)

		for (const info of DOCX_EDITOR_COMMANDS) {
			expect(info.labelKey).toBe(`docx.${info.type}`)
			expect(commandInfo(info.type)).toBe(info)
			// Shortcuts run commands from keys (no arguments to give), save those the host runs.
			if (info.shortcut !== undefined && info.hostShortcut !== true) expect(Object.keys(EXAMPLES[info.type])).toEqual([])
		}

		expect(commandInfo("comment.add")).toMatchObject({
			scope: "document",
			author: true,
			write: true,
			input: "text",
			context: "comment"
		})
		expect(commandInfo("review.track")?.author).toBe(true)
		expect(commandInfo("toc.insert")).toMatchObject({ scope: "document", async: true })
		expect(commandInfo("image.insert")).toMatchObject({ async: true, input: "image" })
		expect(commandInfo("table.row.delete")).toMatchObject({ scope: "story", context: "table" })
		expect(commandInfo("view.reflow")).toMatchObject({ write: false, scope: "document" })
		expect(commandInfo("history.undo")?.scope).toBe("document")
	})

	it("parses every command from bridge input and refuses invalid arguments", () => {
		for (const type of DOCX_EDITOR_COMMANDS.map(info => info.type)) {
			const sent = JSON.parse(JSON.stringify({ type, ...EXAMPLES[type] })) as unknown

			expect(parseDocxEditorCommand(sent), type).toEqual({ type, ...EXAMPLES[type] })
		}

		for (const value of INVALID) expect(parseDocxEditorCommand(value), JSON.stringify(value)).toBeUndefined()

		// Inherited properties are no arguments.
		expect(parseDocxEditorCommand(Object.assign(Object.create({ family: "Arial" }) as object, { type: "font.family" }))).toBeUndefined()
		expect(parseDocxEditorCommand([{ type: "format.bold" }])).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "constructor" })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "page.setup", pageNumbers: { start: null } })).toEqual({
			type: "page.setup",
			pageNumbers: { start: null }
		})
		expect(parseDocxEditorCommand({ type: "table.cell.shading", fill: null })).toEqual({ type: "table.cell.shading", fill: null })
		expect(parseDocxEditorCommand({ type: "link.set", anchor: "_Toc1" })).toEqual({ type: "link.set", anchor: "_Toc1" })
		expect(parseDocxEditorCommand({ type: "color.text", color: { kind: "rgb", value: "ff00aa" } })).toEqual({
			type: "color.text",
			color: { kind: "rgb", value: "FF00AA" }
		})
	})

	it("disables and refuses feature commands that have no handler, leaving the document as it was", async () => {
		const session = await sessionOf({ body: p("one two three") + p("four") })
		const doc = session.state.doc

		session.dispatch(session.state.tr.setSelection(TextSelection.create(doc, 1, 4)))

		const snapshot = session.snapshot()

		expect(FEATURE_TYPES.length).toBeGreaterThan(0)

		for (const type of FEATURE_TYPES) {
			expect(snapshot.enabled[type], type).toBe(false)
			expect(session.execute(command(type)), type).toBe(false)
		}

		expect(session.state.doc).toBe(doc)
		expect(snapshot.enabled["format.bold"]).toBe(true)
		// Tracked changes record through the transformer; it passes edits through while tracking is off.
		expect(registeredTransformer()).toBeDefined()

		// The paged editor routes them and refuses them the same way.
		const { editor } = await pagedEditor(buildDocx({ body: p("one two three") + p("four") }))
		const before = editor.state.doc

		for (const type of FEATURE_TYPES) {
			expect(editor.snapshot().enabled[type], type).toBe(false)
			await expect(Promise.resolve(editor.execute(command(type))), type).resolves.toBe(false)
		}

		expect(editor.state.doc).toBe(before)
		editor.dispose()
	})

	it("adds the providers' parts to the snapshot, the same objects while nothing changes", async () => {
		const session = await sessionOf({ body: p("one two three") + p("four") })
		const first = session.snapshot()

		expect(first.context.story).toEqual({ kind: "body", index: session.story.story.index, header: null, note: null })
		expect(first.context.table).toBeNull()
		// The caret's formatting (a synthetic document without styles: Word's default font).
		expect(first.values.font).toBe("Times New Roman")
		expect(first.values.size).toBe(20)
		expect(first.review).toEqual({ tracking: false, authorNeeded: false, revisionCount: 0, commentCount: 0, skipped: 0, current: null })

		session.dispatch(session.state.tr.insertText("x", 2))
		session.snapshot()
		// A keystroke later (undo was enabled by the first).
		session.dispatch(session.state.tr.insertText("y", 3))

		const second = session.snapshot()

		expect(second).not.toBe(first)
		expect(second.context).toBe(first.context)
		expect(second.values).toBe(first.values)
		expect(second.review).toBe(first.review)
		expect(second.enabled).not.toBe(first.enabled)

		session.dispatch(session.state.tr.insertText("z", 4))
		expect(session.snapshot().enabled).toBe(second.enabled)
		expect(second.readOnlyReasons).toBe(first.readOnlyReasons)
	})

	// The contract every snapshot provider keeps: while what it reports is the same, it returns the same
	// object (toolbars compare by identity, so typing and moving the caret re-render nothing).
	it("keeps the providers' objects across keystrokes and caret moves", async () => {
		const session = await sessionOf({ body: p("one two three four five six") + p("seven eight nine") })
		const first = session.snapshot()

		for (let k = 0; k < 40; k++) {
			const doc = session.state.doc
			const size = doc.child(0).nodeSize

			if (k % 2 === 0) session.dispatch(session.state.tr.insertText("x", 2 + (k % 7)))
			else session.dispatch(session.state.tr.setSelection(TextSelection.create(doc, 1 + ((k * 3) % (size - 2)))))

			const snapshot = session.snapshot()

			expect(snapshot.values).toBe(first.values)
			expect(snapshot.review).toBe(first.review)
			expect(snapshot.context).toBe(first.context)
			expect(snapshot.context.story).toBe(first.context.story)
		}

		// The paged editor's snapshot keeps them too.
		const { editor } = await pagedEditor(buildDocx({ body: p("one two three") + p("four") }))
		const shown = editor.snapshot()

		for (let k = 0; k < 20; k++) {
			editor.dispatch(editor.state.tr.insertText("y", 2))

			const snapshot = editor.snapshot()

			expect(snapshot.values).toBe(shown.values)
			expect(snapshot.context).toBe(shown.context)
			expect(snapshot.review).toBe(shown.review)
		}

		editor.dispose()
	})

	it("runs the transformer over user transactions only", async () => {
		const seen: Transaction[] = []
		const session = await sessionOf(
			{ body: p("one two") },
			{
				transformer: (tr, current) => {
					seen.push(tr)
					expect(current).toBeInstanceOf(DocxEditorSession)

					return tr.insertText("!", tr.doc.content.size - 1)
				}
			}
		)

		session.dispatch(session.state.tr.insertText("x", 1))
		expect(session.state.doc.textContent).toBe("xone two!")
		expect(seen).toHaveLength(1)

		// Undo is not transformed again; a selection change is no edit.
		session.execute({ type: "history.undo" })
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 2)))
		expect(seen).toHaveLength(1)
		expect(session.state.doc.textContent).toBe("one two")
	})

	it("lets feature commands set protected attributes and keeps the new atoms they write", async () => {
		const session = await sessionOf({ body: p("one two") })

		// A host's own transaction may not set what only commands set, nor claim to be a command.
		const paraId = docxSchema.marks.para_id.create({ id: "1A2B3C4D" })

		expect(session.dispatch(session.state.tr.addNodeMark(0, paraId))).toBe(false)
		expect(session.dispatch(session.state.tr.addNodeMark(0, paraId).setMeta("docxCommand$", true))).toBe(false)
		expect(session.dispatch(session.state.tr.setNodeAttribute(0, "src", 999).setMeta("docxInternal$", true))).toBe(false)
		expect(session.dispatch(markCommand(session.state.tr.addNodeMark(0, paraId)))).toBe(true)
		expect(session.state.doc.firstChild?.marks).toEqual([paraId])
		expect(session.dispatch(markCommand(session.state.tr.removeNodeMark(0, paraId)))).toBe(true)
		expect(session.dispatch(markCommand(session.state.tr.setDocAttribute("comments", { "7": { done: true } })))).toBe(true)
		expect(session.state.doc.attrs["comments"]).toEqual({ "7": { done: true } })

		// Node marks of blocks: only commands set them, never on text.
		const change = docxSchema.marks.paragraph_change.create({ value: { styleId: "Old" } })

		expect(session.dispatch(session.state.tr.addNodeMark(0, change))).toBe(false)
		expect(session.dispatch(markCommand(session.state.tr.addNodeMark(0, change)))).toBe(true)
		expect(session.state.doc.firstChild?.marks).toEqual([change])
		expect(docxSchema.nodes.paragraph.allowsMarkType(docxSchema.marks.paragraph_change)).toBe(false)
		expect(docxSchema.nodes.table_row.allowsMarkType(docxSchema.marks.cell_props)).toBe(true)
		expect(session.dispatch(session.state.tr.removeNodeMark(0, docxSchema.marks.paragraph_change))).toBe(false)
		expect(session.dispatch(markCommand(session.state.tr.removeNodeMark(0, docxSchema.marks.paragraph_change)))).toBe(true)
		expect(session.state.doc.firstChild?.marks).toEqual([])

		for (const name of Object.keys(docxSchema.marks)) {
			expect(INLINE_MARK_NAMES.includes(name) !== (BLOCK_NODE_MARKS as readonly string[]).includes(name), name).toBe(true)
		}

		// A new comment anchor with its id stays; an atom with nothing to be written from goes.
		const nodes = docxSchema.nodes
		const start = nodes.marker.create({ kind: "commentRangeStart", id: "7" })
		const end = nodes.marker.create({ kind: "commentRangeEnd", id: "7" })
		const reference = nodes.comment_ref.create({ id: "7" })
		const stray = nodes.marker.create({ kind: "bookmarkStart", id: "9" })

		expect([start, end, reference].every(writableNew)).toBe(true)
		expect(writableNew(stray)).toBe(false)
		expect(writableNew(nodes.marker.create({ kind: "bookmarkStart", id: "9", name: "Results" }))).toBe(true)
		expect(writableNew(nodes.run_object.create())).toBe(false)

		const tr = session.state.tr.insert(4, end).insert(4, reference).insert(1, start).insert(1, stray)

		expect(session.dispatch(markCommand(tr))).toBe(true)

		const kinds: string[] = []

		session.state.doc.descendants(node => {
			if (node.type === nodes.marker || node.type === nodes.comment_ref) kinds.push(String(node.attrs["kind"] ?? "reference"))
		})

		expect(kinds).toEqual(["commentRangeStart", "reference", "commentRangeEnd"])

		// Bold across the anchors keeps them.
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 1, session.state.doc.content.size - 1)))
		expect(session.execute({ type: "format.bold" })).toBe(true)

		let anchors = 0

		session.state.doc.descendants(node => {
			if (node.type === nodes.marker || node.type === nodes.comment_ref) anchors++
		})

		expect(anchors).toBe(3)
	})

	it("hands out ids per id space and paragraph ids Word accepts", async () => {
		const { context, model } = await openSpec({
			body: p("x"),
			footnotes:
				'<w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p/></w:footnote><w:footnote w:id="4"><w:p/></w:footnote>'
		})

		expect(model.maxIds.footnote).toBe(4)
		expect(context.ids.next("footnote")).toBe(5)
		expect(context.ids.next("footnote")).toBe(6)
		expect(context.ids.next("comment")).toBe(0)
		expect(context.ids.next("docPr")).toBe(1)
		context.ids.reserve("comment", 10)
		expect(context.ids.next("comment")).toBe(11)

		const ids = new DocxIds(model.maxIds)
		let calls = 0
		// Collides first with a taken id, then with one handed out, then is fresh.
		const values = [0.5, 0.5, 0.25]
		const random = (): number => values[Math.min(calls++, values.length - 1)] ?? 0
		const taken = Math.floor(0.5 * 0x7fffffff) + 1
		const first = ids.paraId(id => id === taken, random)
		const second = ids.paraId(
			() => false,
			() => 0.5
		)

		expect(first).toMatch(/^[0-9A-F]{8}$/)
		expect(Number.parseInt(first, 16)).toBe(Math.floor(0.25 * 0x7fffffff) + 1)
		expect(Number.parseInt(second, 16)).toBe(taken)

		for (let k = 0; k < 200; k++) {
			const id = Number.parseInt(
				ids.paraId(() => false),
				16
			)

			expect(id).toBeGreaterThan(0)
			expect(id).toBeLessThan(0x80000000)
		}

		expect(context.identity.author).toBeUndefined()
		expect(authorInitials("jan van Dijk-Smith")).toBe("JVDS")
		expect(authorInitials("  ")).toBeUndefined()
		expect(context.review.tracking).toBe(false)
	})

	it("keeps copies of media, refuses what is over the limits and releases what is unused", () => {
		const store = new DocxMediaStore(10, 12)
		const given = new Uint8Array([1, 2, 3])
		const whole = store.add(given, { name: "a.png", contentType: "image/png" })
		const chunked = store.add([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])])

		given[0] = 9
		expect(whole).toBe(1)
		expect(chunked).toBe(2)
		expect(store.get(1)?.info.contentType).toBe("image/png")
		expect(store.bytes(1)).toEqual(new Uint8Array([1, 2, 3]))
		expect(store.bytes(2)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
		expect(store.bytes(2)).toBe(store.bytes(2))
		expect(store.add(new Uint8Array(11))).toBeUndefined()
		// 8 of 12 used: 5 more are over the total.
		expect(store.add(new Uint8Array(5))).toBeUndefined()
		store.releaseUnused(new Set([2]))
		expect(store.bytes(1)).toBeUndefined()
		expect(store.add(new Uint8Array(7))).toBe(3)
		store.clear()
		expect(store.bytes(2)).toBeUndefined()
	})

	it("copies of paragraphs do not keep their paragraph id or tracked property change", async () => {
		const session = await sessionOf({ body: p("hello world") + p("second") })
		const marks = docxSchema.marks
		const id = marks.para_id.create({ id: "1234ABCD" })
		const change = marks.paragraph_change.create({ value: { align: "left" } })
		const section = marks.section_change.create({ value: { section: 0, orientation: "landscape" } })
		const blockMarks = (): string[][] => {
			const out: string[][] = []

			session.state.doc.forEach(node => out.push(node.marks.map(mark => mark.type.name)))

			return out
		}

		expect(session.dispatch(markCommand(session.state.tr.addNodeMark(0, id).addNodeMark(0, change).addNodeMark(0, section)))).toBe(true)

		// Enter: the new half has neither id nor change; the section change goes with the paragraph mark.
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 6)))
		expect(session.dispatch(session.state.tr.split(6))).toBe(true)
		expect(blockMarks()).toEqual([["para_id", "paragraph_change"], ["section_change"], []])

		// A pasted copy keeps none (with or without the paste sanitiser).
		const slice = session.state.doc.slice(0, session.state.doc.child(0).nodeSize)
		const end = session.state.doc.content.size - 1

		expect(session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, end)).replaceSelection(slice))).toBe(
			true
		)
		expect(blockMarks()).toEqual([["para_id", "paragraph_change"], ["section_change"], [], []])

		// A move (cut and paste in one edit) keeps them.
		const other = await sessionOf({ body: p("hello world") + p("second") })

		expect(other.dispatch(markCommand(other.state.tr.addNodeMark(0, id).addNodeMark(0, change)))).toBe(true)

		const first = other.state.doc.child(0)
		const moved = other.state.tr.delete(0, first.nodeSize)

		moved.insert(moved.doc.content.size, first)
		expect(other.dispatch(moved)).toBe(true)
		expect(other.state.doc.lastChild?.marks.map(mark => mark.type.name)).toEqual(["para_id", "paragraph_change"])
	})

	it("takes back revertible units, blocks first", async () => {
		expect(REVERTIBLE_UNITS[0]?.kind).toBe("block")

		const session = await sessionOf({ body: p("one") + p("two") + p("three") })

		session.dispatch(session.state.tr.insertText("x", 2))

		const second = session.state.doc.child(0).nodeSize + 2

		session.dispatch(session.state.tr.insertText("y", second))

		// The writer refuses any document whose second paragraph changed.
		const found = await findUnsavableBlocks(
			[session],
			async trials => !(trials[0]?.state.doc.child(1).textContent.includes("y") ?? false)
		)

		expect(found).toHaveLength(1)
		expect(found?.[0]?.positions).toEqual([session.state.doc.child(0).nodeSize])
		expect(found?.[0]?.units).toEqual([{ kind: "block", key: session.state.doc.child(0).nodeSize }])
	})

	it("routes undo and redo through the editor and keeps the view switch a document command", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("one two") }))

		expect(editor.view).toBe(RevisionView.Final)
		expect(editor.snapshot().enabled["history.undo"]).toBe(false)
		editor.dispatch(editor.state.tr.insertText("x", 1))
		expect(editor.snapshot().canUndo).toBe(true)
		expect(editor.execute({ type: "history.undo" })).toBe(true)
		expect(editor.state.doc.textContent).toBe("one two")
		expect(editor.snapshot().enabled["history.redo"]).toBe(true)

		// The editor's own state (painter, view...) is part of what document commands see: a new snapshot.
		const before = editor.snapshot()

		expect(editor.snapshot()).toBe(before)
		editor.setPainter({ marks: [], paragraph: null, sticky: false })
		expect(editor.snapshot()).not.toBe(before)
		expect(commandInfo("format.paste")?.scope).toBe("document")
		editor.dispose()
	})
})
