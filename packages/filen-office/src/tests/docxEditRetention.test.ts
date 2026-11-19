import { AllSelection, TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import type { Node } from "prosemirror-model"
import { DocxEditorSession, replaceAll } from "@filen/office/core/docx/edit"
import { originOf } from "../core/docx/edit/origin"
import { tableMap } from "../core/docx/edit/tables/map"
import { PropsStore } from "../core/docx/props/index"
import { key, memory, openEditor, placeCaret, selectAll, spreadPosition } from "../bench/editHarness"
import { find, findAll, wordPart } from "./docxFixtures"
import { openSpec } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

// What a long editing session keeps: property containers that differ only in tracked-change stamps are drawn
// from one object, and formatting undone back to the document as built shares the built nodes again.

const STAMP = (id: number, date: string): string => `w:id="${String(id)}" w:author="Ann" w:date="${date}"`
const BODY = Array.from({ length: 12 }, (_, k) =>
	k % 4 === 3
		? `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>${p(`cell ${String(k)}`)}</w:tc></w:tr></w:tbl>`
		: p(`Paragraph ${String(k)} with some words`, k % 2 === 0 ? '<w:jc w:val="left"/>' : "")
).join("")

describe("properties as drawn", () => {
	it("gives runs that differ only in their tracked change one object, without the change", () => {
		const document = wordPart(
			"document",
			`<w:r><w:rPr><w:b/><w:rPrChange ${STAMP(1, "2026-01-01T00:00:00Z")}><w:rPr/></w:rPrChange></w:rPr></w:r>` +
				`<w:r><w:rPr><w:b/><w:rPrChange ${STAMP(2, "2026-02-02T00:00:00Z")}><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr></w:r>` +
				"<w:r><w:rPr><w:b/></w:rPr></w:r><w:r><w:rPr><w:i/></w:rPr></w:r>"
		)
		const store = new PropsStore()
		const [a, b, plain, other] = findAll(document, "w:rPr").filter(node => document.name(document.parent(node)) === "w:r")

		if (a === undefined || b === undefined || plain === undefined || other === undefined) throw new Error("fixture")

		expect(store.run(document, a)).not.toBe(store.run(document, b))
		expect(store.run(document, a).change?.id).toBe(1)

		const untracked = store.run(document, plain)
		const look = store.runLook(document, a)

		expect(store.runLook(document, b)).toBe(look)
		expect(look).toEqual({ bold: true })
		// The same formatting known untracked is that very object, and a container without stamps is itself.
		expect(look).toBe(untracked)
		expect(store.runLook(document, plain)).toBe(untracked)
		expect(store.runLook(document, other)).toBe(store.run(document, other))
		expect(store.stats().looks).toBe(1)
	})

	it("keeps the kind and author of a paragraph mark's revision, not its id and date", () => {
		const mark = (id: number, author = "Ann"): string =>
			`<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:ins w:id="${String(id)}" w:author="${author}" w:date="2026-0${String(id)}-01T00:00:00Z"/><w:b/></w:rPr>` +
			`<w:pPrChange ${STAMP(id + 10, "2026-03-03T00:00:00Z")}><w:pPr/></w:pPrChange></w:pPr></w:p>`
		const document = wordPart("document", `<w:body>${mark(1)}${mark(2)}${mark(3, "Bob")}</w:body>`)
		const store = new PropsStore()
		const [one, two, three] = findAll(document, "w:pPr").filter(node => document.name(document.parent(node)) === "w:p")

		if (one === undefined || two === undefined || three === undefined) throw new Error("fixture")

		const look = store.paragraphLook(document, one)

		expect(store.paragraphLook(document, two)).toBe(look)
		expect(store.paragraphLook(document, three)).not.toBe(look)
		expect(look).toEqual({ alignment: "center", markRun: { bold: true, revisions: [{ kind: "ins", author: "Ann" }] } })
		expect(store.paragraph(document, one).change?.id).toBe(11)
	})

	it("does the same for table, row and cell properties", () => {
		const row = (id: number): string =>
			`<w:tr><w:trPr><w:cantSplit/><w:ins ${STAMP(id, `2026-01-0${String(id)}T00:00:00Z`)}/></w:trPr>` +
			`<w:tc><w:tcPr><w:tcW w:w="100" w:type="dxa"/><w:cellIns ${STAMP(id + 10, "2026-01-01T00:00:00Z")}/>` +
			`<w:tcPrChange ${STAMP(id + 20, "2026-01-01T00:00:00Z")}><w:tcPr/></w:tcPrChange></w:tcPr>${p("x")}</w:tc></w:tr>`
		const table = (id: number): string =>
			`<w:tbl><w:tblPr><w:jc w:val="center"/><w:tblPrChange ${STAMP(id, "2026-01-01T00:00:00Z")}><w:tblPr/></w:tblPrChange></w:tblPr>${row(id)}${row(id + 1)}</w:tbl>`
		const document = wordPart("document", `<w:body>${table(1)}${table(5)}</w:body>`)
		const store = new PropsStore()
		// The containers themselves (not the previous properties inside their change elements).
		const looks = (name: string, read: (node: number) => object): Set<object> =>
			new Set(
				findAll(document, name)
					.filter(node => !document.name(document.parent(node)).endsWith("Change"))
					.map(read)
			)

		expect(looks("w:tblPr", node => store.tableLook(document, node)).size).toBe(1)
		expect(looks("w:trPr", node => store.rowLook(document, node)).size).toBe(1)
		expect(looks("w:tcPr", node => store.cellLook(document, node)).size).toBe(1)
		expect(looks("w:trPr", node => store.row(document, node)).size).toBe(4)
		expect(store.rowLook(document, find(document, "w:trPr")).revisions).toEqual([{ kind: "ins", author: "Ann" }])
		expect(store.cellLook(document, find(document, "w:tcPr")).revisions).toEqual([{ kind: "ins", author: "Ann" }])
	})

	it("reads a container with malformed markup as a whole", () => {
		const document = wordPart(
			"document",
			`<w:r><w:rPr><w:b/><w:rPrChange ${STAMP(1, "x")}><w:rPr><w:i w:val="1" w:val="0"/></w:rPr></w:rPrChange></w:rPr></w:r>`
		)
		const store = new PropsStore()
		const rPr = find(document, "w:rPr")

		expect(store.runLook(document, rPr)).toBe(store.run(document, rPr))
	})

	it("keeps the store flat over tracked formatting of a whole document undone", async () => {
		const opened = await openEditor(buildDocx({ body: BODY }))
		const editor = opened.editor
		const store = editor.session.context.store
		const counts: number[] = []

		editor.execute({ type: "review.track", on: true })

		for (let round = 0; round < 3; round++) {
			selectAll(editor)
			editor.execute({ type: "format.bold" })
			await editor.whenSettled()
			editor.execute({ type: "history.undo" })
			await editor.whenSettled()

			const stats = store.stats()

			counts.push(stats.runs + stats.paragraphs + stats.looks)
		}

		opened.close()
		expect(counts[2]).toBe(counts[0])
	})
})

function selectEverything(session: DocxEditorSession): void {
	session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
}

// Every block of `doc` that is not the very node of `built` at its place.
function copies(doc: Node, built: Node): number {
	let count = doc.childCount === built.childCount ? 0 : 1

	doc.forEach((child, _offset, index) => {
		if (child !== built.maybeChild(index)) count++
	})

	return count
}

describe("formatting state of a long selection", () => {
	it("keeps run toggles and paragraph formats per distinct formatting, not per run or paragraph", async () => {
		const opened = await openSpec({ body: Array.from({ length: 40 }, (_, k) => p(`Run ${String(k)}`)).join("") })
		const session = new DocxEditorSession(opened.context)
		const formats = session.formats
		const doc = session.state.doc
		let first: number | undefined

		doc.descendants((node, pos) => {
			if (!node.isText) return

			const bits = formats.toggles(formats.paragraph(doc.resolve(pos).parent), node.marks)

			first ??= bits
			expect(bits).toBe(first)
		})

		const internals = formats as unknown as {
			readonly formattings: ReadonlyMap<string, { readonly toggles: ReadonlyMap<unknown, number> }>
			readonly sourceList: readonly unknown[]
		}

		expect([...internals.formattings.values()].reduce((sum, formatting) => sum + formatting.toggles.size, 0)).toBe(1)
		expect(internals.sourceList.length).toBe(1)
		session.dispose()
	})
})

describe("origins of typing", () => {
	it("records none for text carrying the formatting of a run of its own paragraph", async () => {
		// Text typed after a comment reference takes the formatting of the run before it, which is not next to it.
		const opened = await openSpec({
			body:
				'<w:p><w:commentRangeStart w:id="0"/><w:r><w:rPr><w:color w:val="000000"/></w:rPr><w:t>Alpha</w:t></w:r>' +
				'<w:commentRangeEnd w:id="0"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r></w:p>' +
				p("Second paragraph"),
			comments: '<w:comment w:id="0" w:author="Bo" w:date="2020-01-01T00:00:00Z"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:comment>'
		})
		const session = new DocxEditorSession(opened.context)
		const doc = session.state.doc
		let formatted: Node | undefined

		doc.child(0).forEach(node => {
			if (node.isText) formatted ??= node
		})

		const end = doc.child(0).nodeSize - 1

		expect(formatted).toBeDefined()
		expect(doc.resolve(end).nodeBefore?.isText).toBe(false)
		session.dispatch(session.state.tr.insert(end, doc.type.schema.text("x", formatted?.marks)))

		expect(session.state.doc.child(0).textContent).toContain("x")
		expect(originOf(session.state.doc.child(1))).toBeUndefined()
		session.dispose()
	})
})

describe("snapshots", () => {
	it("keep no document a format over everything made once the caret moves on", async () => {
		const opened = await openEditor(buildDocx({ body: BODY }))
		const editor = opened.editor

		selectAll(editor)
		editor.execute({ type: "format.bold" })
		editor.snapshot()

		const formatted = new WeakRef(editor.session.state.doc)

		editor.execute({ type: "history.undo" })
		placeCaret(editor, spreadPosition(editor.session.state, 3))
		// A key drops the redo (which holds the format's steps, not its document).
		key(editor, "type")
		editor.snapshot()
		await editor.whenSettled()
		await new Promise(resolve => setTimeout(resolve, 0))
		memory()

		expect(formatted.deref()).toBeUndefined()
		opened.close()
	})
})

describe("origins", () => {
	it("records none for formatting over everything (marks give no node new attributes)", async () => {
		const opened = await openSpec({ body: BODY })
		const session = new DocxEditorSession(opened.context)

		session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
		expect(session.execute({ type: "format.bold" })).toBe(true)

		session.state.doc.forEach(child => {
			expect(originOf(child)).toBeUndefined()
		})
		session.dispose()
	})

	it("records none for a Replace All putting back text between matches", async () => {
		// The text between a paragraph's matches is in runs of its own.
		const runs = (k: number): string =>
			`<w:p><w:r><w:t xml:space="preserve">alpha </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">beta ${String(k)} </w:t></w:r><w:r><w:t>alpha</w:t></w:r></w:p>`
		const opened = await openSpec({ body: p("untouched") + Array.from({ length: 6 }, (_, k) => runs(k)).join("") })
		const session = new DocxEditorSession(opened.context)
		const found = replaceAll(session.state, "alpha", "omega", { caseSensitive: true })

		if (found === null || !("tr" in found)) throw new Error("nothing replaced")

		expect(found.count).toBe(12)
		session.dispatch(found.tr)
		expect(session.state.doc.textContent).not.toContain("alpha")
		// Only the edited paragraphs record where they came from: nothing else was asked for.
		expect(originOf(session.state.doc.child(0))).toBeUndefined()
		session.dispose()
	})
})

describe("formatting lookups", () => {
	it("keep no mark that no content carries any more", async () => {
		const opened = await openSpec({ body: p("Run") })
		const session = new DocxEditorSession(opened.context)
		const formats = session.formats
		const paragraph = formats.paragraph(session.state.doc.child(0))
		const ref = ((): WeakRef<object> => {
			// A mark of its own (a color nothing else has): what a tracked change or a new edit makes.
			const color = session.state.schema.marks["color"]?.create({ value: "123456" })

			if (color === undefined) throw new Error("schema")

			formats.toggles(paragraph, [color])
			formats.values(paragraph, [color])

			return new WeakRef(color)
		})()

		await new Promise(resolve => setTimeout(resolve, 0))
		memory()
		expect(ref.deref()).toBeUndefined()
		session.dispose()
	})
})

describe("table maps", () => {
	it("keep a long table's rows packed, a few as objects, with what a row object says", async () => {
		const cell = (text: string, span = 1): string =>
			`<w:tc><w:tcPr><w:tcW w:w="1000" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${String(span)}"/>` : ""}</w:tcPr>${p(text)}</w:tc>`
		const rows = Array.from({ length: 120 }, (_, k) =>
			k % 3 === 0
				? `<w:tr>${cell(`a${String(k)}`, 2)}${cell("b")}</w:tr>`
				: `<w:tr>${cell(`a${String(k)}`)}${cell("b")}${cell("c")}</w:tr>`
		)
		const grid = '<w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/></w:tblGrid>'
		const opened = await openSpec({
			body: `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${grid}${rows.join("")}</w:tbl>${p("after")}`
		})
		const session = new DocxEditorSession(opened.context)
		const table = session.state.doc.child(0)
		const map = tableMap(table, session.story.part, opened.context.store)

		expect(map.width).toBe(3)

		for (let r = 0; r < map.height; r++) {
			const row = map.row(r)
			const spans = r % 3 === 0 ? [2, 1] : [1, 1, 1]

			expect(row.node).toBe(table.child(r))
			expect(row.spans).toEqual(spans)
			expect(row.starts).toEqual(r % 3 === 0 ? [0, 2] : [0, 1, 2])
			expect(row.end).toBe(3)
			expect(map.cellAt(r, 2)).toBe(spans.length - 1)
		}

		const internals = map as unknown as { readonly views: ReadonlyMap<number, unknown> }

		expect(internals.views.size).toBeLessThanOrEqual(32)
		session.dispose()
	})
})

describe("formatting undone", () => {
	for (const [label, command] of [
		["bold", { type: "format.bold" }],
		["italic", { type: "format.italic" }],
		["alignment", { type: "align.center" }]
	] as const) {
		it(`gives back the built blocks after ${label} over everything is undone`, async () => {
			const opened = await openSpec({ body: BODY })
			const session = new DocxEditorSession(opened.context)
			const built = session.state.doc

			selectEverything(session)
			expect(session.execute(command)).toBe(true)
			expect(copies(session.state.doc, built)).toBe(built.childCount)
			session.execute({ type: "history.undo" })

			expect(session.state.doc.eq(built)).toBe(true)
			expect(copies(session.state.doc, built)).toBe(0)
			session.execute({ type: "history.redo" })
			expect(copies(session.state.doc, built)).toBe(built.childCount)
			session.dispose()
		})
	}

	for (const commands of [
		[{ type: "format.bold" }, { type: "align.center" }],
		[{ type: "format.bold" }, { type: "paragraph.spacing", before: 240 }]
	] as const) {
		it(`gives back the built blocks after ${commands.map(command => command.type).join(" then ")} over everything are undone`, async () => {
			const opened = await openSpec({ body: BODY })
			const session = new DocxEditorSession(opened.context)
			const built = session.state.doc

			selectEverything(session)

			for (const command of commands) expect(session.execute(command)).toBe(true)
			for (const _ of commands) expect(session.execute({ type: "history.undo" })).toBe(true)

			expect(session.state.doc.eq(built)).toBe(true)
			expect(copies(session.state.doc, built)).toBe(0)
			session.dispose()
		})
	}

	it("does so under tracking too, and leaves a block edited since as it is", async () => {
		const opened = await openSpec({ body: BODY })

		opened.context.identity.author = "Ann"
		opened.context.review.tracking = true

		const session = new DocxEditorSession(opened.context)
		const built = session.state.doc

		session.dispatch(session.state.tr.setSelection(TextSelection.create(built, 3)).insertText("x"))
		selectEverything(session)
		session.execute({ type: "format.bold" })
		session.execute({ type: "history.undo" })

		const doc = session.state.doc

		expect(doc.child(0)).not.toBe(built.child(0))
		expect(doc.child(0).textContent).toContain("x")
		expect(copies(doc, built)).toBe(1)
		session.dispose()
	})
})

const NOTE_SEPARATORS =
	'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
	'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
const NOTED = buildDocx({
	body: '<w:p><w:r><w:t>Body text</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>' + p("After"),
	footnotes: NOTE_SEPARATORS + '<w:footnote w:id="1"><w:p><w:r><w:t>Note text</w:t></w:r></w:p></w:footnote>'
})

describe("origins of documents built to be read", () => {
	it("records those of Find's documents at once, and keeps them once one is a session's and after a paste", async () => {
		const { editor } = await pagedEditor(NOTED)

		await settleAll(editor)

		const note = editor.edits.model.stories.find(story => story?.kind === "footnote" && story.id === "1")

		if (note === undefined) throw new Error("no note")

		const searched = (): Node => {
			const doc = editor.searchStories().find(entry => entry.story === note.index)?.doc

			if (doc === undefined) throw new Error("note not searched")

			return doc
		}

		// Nothing pasted yet: each build is tagged as made, none waits for a paste.
		for (let round = 0; round < 3; round++) {
			expect(originOf(searched().child(0))).toBe(note.part)
			editor.releaseSearch()
		}

		const doc = searched()
		const block = doc.child(0)

		expect(editor.enterStory(note.index, -1)).toBe(true)
		expect(editor.session.state.doc).toBe(doc)
		expect(originOf(block)).toBe(note.part)

		// The note's paragraph pasted into the body: content of another part.
		const body = editor.body.session

		expect(body.dispatch(body.state.tr.insert(body.state.doc.content.size, block).setMeta("uiEvent", "paste"))).toBe(true)
		expect(originOf(block)).toBe(note.part)
		expect(body.state.doc.lastChild?.textContent).toBe("Note text")
		editor.dispose()
	})
})
