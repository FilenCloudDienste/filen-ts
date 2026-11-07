import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { OpcPackage, bytesSource } from "@filen/office/core/opc"
import type { DocxPackage } from "@filen/office/core/docx"
import { docxSchema, type DocxEditContext, type DocxEditorCommand } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { DocxSaveError, saveDocx } from "@filen/office/core/docx/write"
import { markInternal } from "../core/docx/edit/invariants/index"
import { storyReviewIndex } from "../core/docx/review/accept"
import { bodySections, deletesBreakAtCaret, docSectionChanges } from "../core/docx/stories/sections"
import { CORPUS_DIR } from "./corpusDir"
import { openBytes } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { pageDigest, pagedEditor, savedDigest, settleAll } from "./pagedFixtures"

const decoder = new TextDecoder()
const marks = docxSchema.marks

const MARGINS = '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
const SECTION = (extra = ""): string =>
	`<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}${extra}</w:sectPr>`
const LONG = Array.from({ length: 30 }, (_value, k) => p(`Paragraph ${String(k)} with some words to fill the line`)).join("")

async function read(bytes: Uint8Array, name: string): Promise<string> {
	return decoder.decode(await (await OpcPackage.open(bytesSource(bytes))).read(name))
}

interface Opened {
	readonly editor: PagedEditor
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
}

function caret(editor: PagedEditor, pos: number): void {
	const session = editor.session

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, pos)))
}

async function run(editor: PagedEditor, command: DocxEditorCommand): Promise<boolean> {
	return await editor.execute(command)
}

async function saved({ editor, pkg, context }: Opened): Promise<Uint8Array> {
	await settleAll(editor)

	const result = await saveDocx({ pkg, context, sessions: editor.sessions })

	if (result.bytes === undefined) throw new Error("No bytes")

	expect(pageDigest(editor.layout)).toEqual(await savedDigest(result.bytes))

	return result.bytes
}

// The w:sectPr elements of the saved main part (not those a change records inside one), in order.
async function sections(bytes: Uint8Array): Promise<string[]> {
	const xml = await read(bytes, "word/document.xml")
	const out: string[] = []
	let depth = 0
	let start = 0

	for (const match of xml.matchAll(/<w:sectPr>|<\/w:sectPr>/g)) {
		if (match[0] === "<w:sectPr>") {
			if (depth === 0) start = match.index

			depth++
		} else if (--depth === 0) {
			out.push(xml.slice(start, match.index + match[0].length))
		}
	}

	return out
}

describe("docx sections and page setup", () => {
	it.each(["nextPage", "continuous", "evenPage", "oddPage"] as const)(
		"inserts a %s break: the new section takes the properties and references, the one after links to it",
		async kind => {
			const opened = await pagedEditor(
				buildDocx({ body: p("Alpha beta") + p("Second") + SECTION('<w:pgNumType w:start="4"/>'), headers: { rIdH: p("Head") } })
			)
			const { editor } = opened

			caret(editor, 6)
			expect(editor.snapshot().enabled["insert.sectionBreak"]).toBe(true)
			expect(await run(editor, { type: "insert.sectionBreak", kind })).toBe(true)
			// The caret starts the new section.
			expect(editor.session.state.selection.from).toBe(8)

			const bytes = await saved(opened)
			const [first, last] = await sections(bytes)

			expect(first).toBe(
				`<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}<w:pgNumType w:start="4"/></w:sectPr>`
			)
			expect(last).toBe(
				`<w:sectPr>${kind === "nextPage" ? "" : `<w:type w:val="${kind}"/>`}<w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>`
			)
			expect((await openBytes(bytes)).model.sections).toHaveLength(2)

			// One undo takes the break back.
			expect(await run(editor, { type: "history.undo" })).toBe(true)
			expect(await sections(await saved(opened))).toHaveLength(1)
			editor.dispose()
		}
	)

	it("never breaks a section inside a table", async () => {
		const opened = await pagedEditor(
			buildDocx({
				body: `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>${p("cell")}</w:tc></w:tr></w:tbl>${p("after")}`
			})
		)
		const { editor } = opened

		caret(editor, 4)
		expect(editor.snapshot().enabled["insert.sectionBreak"]).toBe(false)
		expect(await run(editor, { type: "insert.sectionBreak", kind: "nextPage" })).toBe(false)
		editor.dispose()
	})

	it("never breaks a section inside a content control or a frame, as Word offers no break there", async () => {
		for (const [body, text] of [
			[`<w:sdt><w:sdtPr><w:id w:val="5"/></w:sdtPr><w:sdtContent>${p("block control")}</w:sdtContent></w:sdt>`, "block control"],
			[
				'<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:sdt><w:sdtPr><w:id w:val="6"/></w:sdtPr><w:sdtContent><w:r><w:t>inline control</w:t></w:r></w:sdtContent></w:sdt></w:p>',
				"inline control"
			],
			[
				'<w:p><w:pPr><w:framePr w:w="3000" w:hSpace="180" w:wrap="around" w:vAnchor="text" w:hAnchor="page" w:x="2000" w:y="1"/></w:pPr><w:r><w:t>framed text</w:t></w:r></w:p>',
				"framed text"
			]
		] as const) {
			const opened = await pagedEditor(buildDocx({ body: body + p("after") }))
			const { editor } = opened
			let at = -1

			editor.body.session.state.doc.descendants((node, pos) => {
				if (at < 0 && node.isText && node.text === text) at = pos + 3

				return at < 0
			})
			caret(editor, at)
			expect(editor.snapshot().enabled["insert.sectionBreak"], text).toBe(false)
			expect(await run(editor, { type: "insert.sectionBreak", kind: "nextPage" })).toBe(false)
			caret(editor, editor.body.session.state.doc.content.size - 2)
			expect(editor.snapshot().enabled["insert.sectionBreak"]).toBe(true)
			editor.dispose()
		}
	})

	it("deletes a break: the text before joins the section after, which keeps its properties and what it showed", async () => {
		const opened = await pagedEditor(
			buildDocx({
				body:
					p("One") +
					`<w:p><w:pPr>${SECTION('<w:cols w:num="2" w:space="720"/>')}</w:pPr></w:p>` +
					p("Two") +
					`<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>${MARGINS}</w:sectPr>`,
				headers: { rIdH: p("Head") }
			})
		)
		const { editor } = opened

		caret(editor, 2)
		expect(await run(editor, { type: "section.deleteBreak" })).toBe(true)

		const bytes = await saved(opened)
		const list = await sections(bytes)

		expect(list).toEqual([
			`<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>${MARGINS}</w:sectPr>`
		])
		// The last section has no break to delete.
		expect(editor.snapshot().enabled["section.deleteBreak"]).toBe(false)
		editor.dispose()
	})

	it("sets up pages: size, orientation, margins, columns, page numbers and line numbers, for a section or all", async () => {
		const opened = await pagedEditor(
			buildDocx({ body: LONG + `<w:p><w:pPr>${SECTION()}</w:pPr></w:p>` + LONG + SECTION(), headers: { rIdH: p("Head") } })
		)
		const { editor } = opened

		caret(editor, 2)
		expect(
			await run(editor, {
				type: "page.setup",
				size: { width: 11906, height: 16838 },
				orientation: "landscape",
				margins: { left: 720, gutter: 360 }
			})
		).toBe(true)
		expect(
			await run(editor, {
				type: "page.setup",
				columns: { count: 2, space: 360, separator: true },
				pageNumbers: { start: 7, format: "upperRoman" }
			})
		).toBe(true)
		expect(await run(editor, { type: "page.setup", lineNumbers: { countBy: 5, start: 3, restart: "newSection" } })).toBe(true)

		let list = await sections(await saved(opened))

		expect(list[0]).toBe(
			'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' +
				'<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="720" w:header="720" w:footer="720" w:gutter="360"/>' +
				'<w:lnNumType w:countBy="5" w:start="2" w:restart="newSection"/><w:pgNumType w:fmt="upperRoman" w:start="7"/>' +
				'<w:cols w:num="2" w:space="360" w:sep="1"/></w:sectPr>'
		)
		expect(list[1]).toBe(SECTION())

		// The whole document: every section.
		expect(await run(editor, { type: "page.setup", margins: { top: 720 }, scope: "document" })).toBe(true)
		list = await sections(await saved(opened))
		expect(list.every(section => section.includes('w:top="720"'))).toBe(true)

		// Numbering continues again; no line numbers.
		expect(await run(editor, { type: "page.setup", pageNumbers: { start: null }, lineNumbers: null })).toBe(true)
		list = await sections(await saved(opened))
		expect(list[0]).toContain('<w:pgNumType w:fmt="upperRoman"/>')
		expect(list[0]).not.toContain("lnNumType")
		editor.dispose()
	})

	it("sets up the pages of a body without section properties of its own", async () => {
		const opened = await pagedEditor(buildDocx({ body: p("Plain") }))
		const { editor } = opened

		expect(await run(editor, { type: "page.setup", orientation: "landscape" })).toBe(true)
		expect(await sections(await saved(opened))).toEqual(['<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/></w:sectPr>'])
		editor.dispose()
	})

	it("tracks page setup while changes are tracked, and accepts or rejects it", async () => {
		for (const accept of [true, false]) {
			const opened = await pagedEditor(buildDocx({ body: p("A1") + p("A2") + SECTION(), headers: { rIdH: p("Head") } }))
			const { editor, context } = opened

			context.identity.author = "Tester"
			context.review.tracking = true
			caret(editor, 2)
			expect(await run(editor, { type: "page.setup", orientation: "landscape" })).toBe(true)
			expect(editor.snapshot().review.revisionCount).toBe(1)

			const [recorded] = await sections(await saved(opened))

			expect(recorded).toMatch(
				/<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"\/>.*<w:sectPrChange w:id="\d+" w:author="Tester" w:date="[^"]+"><w:sectPr><w:pgSz w:w="12240" w:h="15840"\/>.*<\/w:sectPr><\/w:sectPrChange>/
			)
			expect(recorded).not.toMatch(/<w:sectPrChange.*headerReference/)

			expect(await run(editor, { type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)
			expect(editor.snapshot().review.revisionCount).toBe(0)

			const [resolved] = await sections(await saved(opened))

			expect(resolved).not.toContain("sectPrChange")
			expect(resolved?.includes("landscape")).toBe(accept)
			editor.dispose()
		}
	})

	it("accepts or rejects a section change the file recorded", async () => {
		const change = `<w:sectPrChange w:id="9" w:author="Word" w:date="2026-01-01T00:00:00Z"><w:sectPr><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr></w:sectPrChange>`
		const bytes = buildDocx({
			body: p("Text") + `<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>${MARGINS}${change}</w:sectPr>`
		})

		for (const accept of [true, false]) {
			const opened = await pagedEditor(bytes)
			const { editor } = opened

			expect(editor.snapshot().review.revisionCount).toBe(1)
			expect(await run(editor, { type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)
			expect(editor.snapshot().review.revisionCount).toBe(0)
			expect(await sections(await saved(opened))).toEqual([
				accept
					? `<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>${MARGINS}</w:sectPr>`
					: `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>`
			])
			editor.dispose()
		}
	})

	it("records a break inserted while tracking as Word does, and accepting or rejecting it keeps or takes it out", async () => {
		const source = SECTION('<w:pgNumType w:start="4"/>')
		const bytes = buildDocx({ body: p("Alpha beta") + p("Second") + source, headers: { rIdH: p("Head") } })
		const untracked = await pagedEditor(bytes)

		caret(untracked.editor, 6)
		expect(await run(untracked.editor, { type: "insert.sectionBreak", kind: "continuous" })).toBe(true)

		const plain = await sections(await saved(untracked))

		untracked.editor.dispose()

		for (const resolve of ["accept", "reject", "acceptOne", "rejectOne"] as const) {
			const opened = await pagedEditor(bytes)
			const { editor, context } = opened

			context.identity.author = "Tester"
			context.review.tracking = true
			caret(editor, 6)
			expect(editor.snapshot().enabled["insert.sectionBreak"]).toBe(true)
			expect(await run(editor, { type: "insert.sectionBreak", kind: "continuous" })).toBe(true)
			// One change (one id): the inserted paragraph mark holding the new break, and what it changed of the
			// section after (a property change of it).
			expect(editor.snapshot().review.revisionCount).toBe(2)
			expect(
				new Set(
					storyReviewIndex(editor.body.session)
						.entries()
						.map(entry => entry.id)
				).size
			).toBe(1)

			const recorded = await saved(opened)
			const xml = await read(recorded, "word/document.xml")
			const [first, last] = await sections(recorded)

			expect(xml).toMatch(/<w:p><w:pPr><w:rPr><w:ins w:id="\d+" w:author="Tester" w:date="[^"]+"\/><\/w:rPr><w:sectPr>/)
			expect(first).toBe(plain[0])
			expect(last).toMatch(
				/^<w:sectPr><w:type w:val="continuous"\/><w:pgSz w:w="12240" w:h="15840"\/>.*<w:sectPrChange w:id="\d+" w:author="Tester" w:date="[^"]+"><w:sectPr><w:type w:val="nextPage"\/><w:pgSz w:w="12240" w:h="15840"\/>.*<w:pgNumType w:start="4"\/><\/w:sectPr><\/w:sectPrChange><\/w:sectPr>$/
			)

			const reopened = await openBytes(recorded)

			expect(reopened.model.sections).toHaveLength(2)

			const body = editor.body.session

			if (resolve === "accept" || resolve === "reject") {
				expect(await run(editor, { type: resolve === "accept" ? "review.acceptAll" : "review.rejectAll" })).toBe(true)
			} else {
				const id = storyReviewIndex(body).entries()[0]?.id as string

				expect(await run(editor, { type: resolve === "acceptOne" ? "review.accept" : "review.reject", id })).toBe(true)
			}

			expect(editor.snapshot().review.revisionCount).toBe(0)

			const resolved = await saved(opened)

			if (resolve.startsWith("accept")) {
				expect(await sections(resolved)).toEqual(plain)
				expect(body.state.doc.childCount).toBe(3)
			} else {
				// Taken out: one paragraph and one section again, as before the break.
				expect(await sections(resolved)).toEqual([source])
				expect(body.state.doc.childCount).toBe(2)
				expect(body.state.doc.child(0).textContent).toBe("Alpha beta")
			}

			expect(await read(resolved, "word/document.xml")).not.toMatch(/<w:ins |sectPrChange/)
			editor.dispose()
		}
	})

	it("records a break deleted while tracking as a deleted paragraph mark; accepted, the sections combine", async () => {
		const bytes = buildDocx({
			body:
				p("One") +
				`<w:p><w:pPr>${SECTION('<w:cols w:num="2" w:space="720"/>')}</w:pPr><w:r><w:t>End</w:t></w:r></w:p>` +
				p("Two") +
				`<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>${MARGINS}</w:sectPr>`,
			headers: { rIdH: p("Head") }
		})
		const final = `<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>${MARGINS}</w:sectPr>`

		for (const accept of [true, false]) {
			const opened = await pagedEditor(bytes)
			const { editor, context } = opened

			context.identity.author = "Tester"
			context.review.tracking = true
			caret(editor, 2)
			expect(editor.snapshot().enabled["section.deleteBreak"]).toBe(true)
			expect(await run(editor, { type: "section.deleteBreak" })).toBe(true)
			expect(editor.snapshot().review.revisionCount).toBe(1)

			const recorded = await saved(opened)

			// The break stands until the deletion is accepted.
			expect(await sections(recorded)).toHaveLength(2)
			expect(await read(recorded, "word/document.xml")).toMatch(
				/<w:p><w:pPr><w:rPr><w:del w:id="\d+" w:author="Tester" w:date="[^"]+"\/><\/w:rPr><w:sectPr>/
			)

			expect(await run(editor, { type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)
			expect(editor.snapshot().review.revisionCount).toBe(0)

			const resolved = await saved(opened)
			const body = editor.body.session.state.doc

			if (accept) {
				// The later section's properties, and the header the later section showed through its link.
				expect(await sections(resolved)).toEqual([final])
				expect(body.child(1).textContent).toBe("EndTwo")
			} else {
				expect(await sections(resolved)).toHaveLength(2)
				expect(body.childCount).toBe(3)
			}

			expect(await read(resolved, "word/document.xml")).not.toContain("<w:del ")
			editor.dispose()
		}
	})

	it("takes a break the author inserted while tracking out again when the author deletes it", async () => {
		const source = SECTION()
		const opened = await pagedEditor(buildDocx({ body: p("Alpha beta") + source, headers: { rIdH: p("Head") } }))
		const { editor, context } = opened

		context.identity.author = "Tester"
		context.review.tracking = true
		caret(editor, 6)
		expect(await run(editor, { type: "insert.sectionBreak", kind: "nextPage" })).toBe(true)
		caret(editor, 2)
		expect(await run(editor, { type: "section.deleteBreak" })).toBe(true)
		expect(editor.snapshot().review.revisionCount).toBe(0)
		expect(await sections(await saved(opened))).toEqual([source])
		expect(editor.body.session.state.doc.childCount).toBe(1)
		editor.dispose()
	})

	it("records a selection deleted across a break while tracking: the break's mark is deleted, the text marked", async () => {
		const opened = await pagedEditor(
			buildDocx({
				body: `<w:p><w:pPr>${SECTION()}</w:pPr><w:r><w:t>One</w:t></w:r></w:p>` + p("Two") + SECTION(),
				headers: { rIdH: p("Head") }
			})
		)
		const { editor, context } = opened
		const session = editor.body.session

		context.identity.author = "Tester"
		context.review.tracking = true
		session.dispatch(session.state.tr.delete(3, 8))

		const doc = session.state.doc

		expect(doc.childCount).toBe(2)
		expect((doc.child(0).attrs["revision"] as number) & 2).not.toBe(0)

		const xml = await read(await saved(opened), "word/document.xml")

		expect(xml).toMatch(/<w:rPr><w:del [^>]*\/><\/w:rPr><w:sectPr>/)
		expect(await run(editor, { type: "review.acceptAll" })).toBe(true)
		expect(await sections(await saved(opened))).toEqual([SECTION()])
		expect(session.state.doc.childCount).toBe(1)
		expect(session.state.doc.textContent).toBe("Ono")
		editor.dispose()
	})

	it("leaves a section ending with a locked block as it is: no edit of its properties, no break in it", async () => {
		const opened = await pagedEditor(
			buildDocx({
				body:
					p("One") +
					`<w:customXml w:element="x"><w:p><w:pPr>${SECTION()}</w:pPr><w:r><w:t>Locked</w:t></w:r></w:p></w:customXml>` +
					p("Two") +
					SECTION(),
				headers: { rIdH: p("Head") }
			})
		)
		const { editor } = opened

		expect(editor.body.session.state.doc.child(1).type).toBe(docxSchema.nodes.locked_block)
		caret(editor, 2)
		expect(await run(editor, { type: "page.setup", orientation: "landscape" })).toBe(false)
		expect(await run(editor, { type: "insert.sectionBreak", kind: "nextPage" })).toBe(false)
		// The whole document: the section after it only.
		expect(await run(editor, { type: "page.setup", orientation: "landscape", scope: "document" })).toBe(true)
		// The header both show goes from the section that can lose it.
		expect(await run(editor, { type: "header.remove" })).toBe(true)

		const list = await sections(await saved(opened))

		expect(list[0]).toBe(SECTION())
		expect(list[1]).toContain('w:orient="landscape"')
		expect(list[1]).not.toContain("headerReference")
		editor.dispose()
	})

	it("refuses section properties that leave no room for text or name a part that is no header", async () => {
		const opened = await pagedEditor(buildDocx({ body: p("Text") + SECTION(), headers: { rIdH: p("Head") } }))
		const { editor, pkg, context } = opened
		const body = editor.body.session
		const edits = [
			{ pageMargins: { top: 1440, right: 6000, bottom: 1440, left: 6240, header: 720, footer: 720, gutter: 0 } },
			{ columns: { count: 40, space: 1440, separator: false } },
			{ headers: { default: body.story.story.index } }
		]

		for (const edit of edits) {
			const key = body.state.doc.attrs["sectPr"] as number

			body.dispatch(
				markInternal(
					body.state.tr.setDocAttribute("sectionChanges", {
						...docSectionChanges(body.state.doc),
						final: { section: key, base: key, ...edit }
					})
				)
			)

			const error = await saveDocx({ pkg, context, sessions: editor.sessions }).catch((caught: unknown) => caught)

			expect(error, JSON.stringify(edit)).toBeInstanceOf(DocxSaveError)
		}

		// A new break whose edit is lost cannot be written: refused, not dropped.
		const doc = body.state.doc

		body.dispatch(markInternal(body.state.tr.setNodeAttribute(0, "sectPr", -7).setDocAttribute("sectionChanges", null)))
		expect(bodySections(body.state.doc, body.story.part)[0]?.key).toBe(-7)
		expect(
			await saveDocx({ pkg, context, sessions: editor.sessions }).catch((caught: unknown) => (caught as DocxSaveError).reason)
		).toBe("write")
		expect(marks.section_change.isInSet(doc.child(0).marks)).toBeUndefined()
		editor.dispose()
	})
})

describe("docx sections: page setup Word's way", () => {
	it("refuses page setup a save would refuse, before changing anything", async () => {
		for (const setup of [
			{ margins: { left: 6000, right: 6500 } },
			{ margins: { top: 8000, bottom: 8000 } },
			{ columns: { count: 40 } },
			{ size: { width: 31681, height: 15840 } },
			{ size: { width: 2000, height: 2000 } }
		]) {
			const opened = await pagedEditor(
				buildDocx({ body: p("Text here") + `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>` })
			)
			const { editor } = opened

			caret(editor, 2)
			expect(await run(editor, { type: "page.setup", ...setup }), JSON.stringify(setup)).toBe(false)
			expect(editor.body.session.state.doc.attrs["sectionChanges"] ?? null).toBeNull()
			await saved(opened)
			editor.dispose()
		}
	})

	it("saves an edit of a paragraph holding a source break whose properties gate 2 would refuse were they new", async () => {
		for (const sect of [
			`<w:sectPr><w:pgSz w:w="40000" w:h="15840"/>${MARGINS}</w:sectPr>`,
			`<w:sectPr><w:headerReference w:type="default" r:id="rIdMissing"/><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>`
		]) {
			const opened = await pagedEditor(
				buildDocx({ body: p("Alpha") + `<w:p><w:pPr>${sect}</w:pPr><w:r><w:t>Gamma</w:t></w:r></w:p>` + p("Delta") })
			)
			const { editor } = opened

			caret(editor, 9)
			editor.session.dispatch(editor.session.state.tr.insertText("X"))

			const xml = await read(await saved(opened), "word/document.xml")

			expect(xml).toContain(`${sect}</w:pPr><w:r><w:t>GXamma`)
			editor.dispose()
		}
	})

	it("turns the margins with the page and keeps the paper code, as Word does", async () => {
		const opened = await pagedEditor(
			buildDocx({
				body:
					p("Alpha") +
					'<w:sectPr><w:pgSz w:w="11906" w:h="16838" w:code="9"/><w:pgMar w:top="1000" w:right="2000" w:bottom="1500" w:left="2500" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
			})
		)
		const { editor } = opened

		caret(editor, 2)
		expect(await run(editor, { type: "page.setup", orientation: "landscape" })).toBe(true)
		expect(await sections(await saved(opened))).toEqual([
			'<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape" w:code="9"/><w:pgMar w:top="2500" w:right="1000" w:bottom="2000" w:left="1500" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		])
		expect(await run(editor, { type: "page.setup", orientation: "portrait" })).toBe(true)
		expect(await sections(await saved(opened))).toEqual([
			'<w:sectPr><w:pgSz w:w="11906" w:h="16838" w:code="9"/><w:pgMar w:top="1000" w:right="2000" w:bottom="1500" w:left="2500" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		])
		editor.dispose()
	})

	it("shares a changed text width among unequal columns, spacing kept; gate 2 sums their widths", async () => {
		const cols = '<w:cols w:num="2" w:space="720" w:equalWidth="0"><w:col w:w="6000" w:space="720"/><w:col w:w="2640"/></w:cols>'
		const opened = await pagedEditor(
			buildDocx({ body: p("Alpha") + `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}${cols}</w:sectPr>` })
		)
		const { editor, pkg, context } = opened
		const body = editor.body.session

		caret(editor, 2)
		expect(await run(editor, { type: "page.setup", margins: { left: 3000, right: 3000 } })).toBe(true)
		expect((await sections(await saved(opened)))[0]).toContain(
			'<w:cols w:num="2" w:space="720" w:equalWidth="0"><w:col w:w="3833" w:space="720"/><w:col w:w="1687"/></w:cols>'
		)

		const key = body.state.doc.attrs["sectPr"] as number

		body.dispatch(
			markInternal(
				body.state.tr.setDocAttribute("sectionChanges", {
					final: {
						section: key,
						base: key,
						columns: {
							count: 2,
							space: 720,
							separator: false,
							widths: [
								{ width: 6000, space: 720 },
								{ width: 6000, space: 0 }
							]
						}
					}
				})
			)
		)
		expect(await saveDocx({ pkg, context, sessions: editor.sessions }).catch((caught: unknown) => caught)).toBeInstanceOf(DocxSaveError)
		editor.dispose()
	})

	it("deletes a break with its paragraph mark: the paragraph joins the next one; inserting and deleting it round-trips", async () => {
		const bytes = buildDocx({
			body: p("Alpha beta") + p("Second") + `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>`
		})
		const opened = await pagedEditor(bytes)
		const { editor } = opened
		const before = JSON.stringify(editor.body.session.state.doc.content.toJSON())

		caret(editor, 6)
		expect(await run(editor, { type: "insert.sectionBreak", kind: "nextPage" })).toBe(true)
		caret(editor, 2)
		expect(await run(editor, { type: "section.deleteBreak" })).toBe(true)

		const doc = editor.body.session.state.doc

		expect(doc.childCount).toBe(2)
		expect(doc.child(0).textContent).toBe("Alpha beta")
		expect(JSON.stringify(doc.content.toJSON())).toBe(before)
		await saved(opened)
		editor.dispose()

		// An empty paragraph holding a break goes with it.
		const empty = await pagedEditor(
			buildDocx({
				body:
					p("One") +
					`<w:p><w:pPr>${SECTION()}</w:pPr></w:p>` +
					p("Two") +
					`<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>`,
				headers: { rIdH: p("Head") }
			})
		)

		caret(empty.editor, 7)
		expect(await run(empty.editor, { type: "section.deleteBreak" })).toBe(true)
		expect(empty.editor.body.session.state.doc.childCount).toBe(2)
		expect(await sections(await saved(empty))).toHaveLength(1)
		empty.editor.dispose()
	})

	it("keeps a new break's section change on the paragraph a deletion from the paragraph before joins to it", async () => {
		const opened = await pagedEditor(
			buildDocx({ body: p("Alpha") + p("I want more charts") + `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>` })
		)
		const { editor } = opened
		const session = editor.session

		// "I want more c|harts": the first half ends the new section.
		caret(editor, 8 + "I want more c".length)
		expect(await run(editor, { type: "insert.sectionBreak", kind: "continuous" })).toBe(true)
		// From the start of "Alpha" to before the "c" of the paragraph ending the new section.
		session.dispatch(
			session.state.tr.setSelection(TextSelection.create(session.state.doc, 1, 8 + "I want more ".length)).deleteSelection()
		)

		const first = session.state.doc.child(0)

		expect(first.textContent).toBe("c")
		expect(first.attrs["sectPr"]).toBeLessThan(-1)
		expect(marks.section_change.isInSet(first.marks)?.attrs["value"]).toMatchObject({ section: first.attrs["sectPr"] })
		expect(await sections(await saved(opened))).toHaveLength(2)
		editor.dispose()
	})

	it("rejecting a section change the file recorded brings back what it recorded, whatever came after", async () => {
		const bytes = buildDocx({
			body:
				p("Alpha beta") +
				`<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}<w:sectPrChange w:id="9" w:author="Ann" w:date="2020-01-01T00:00:00Z"><w:sectPr><w:pgSz w:w="11906" w:h="16838"/>${MARGINS}</w:sectPr></w:sectPrChange></w:sectPr>`,
			headers: { rIdH: p("Head") }
		})

		for (const tracked of [false, true]) {
			const opened = await pagedEditor(bytes)
			const { editor, context } = opened

			context.identity.author = "T"
			context.review.tracking = tracked
			caret(editor, 3)
			expect(await run(editor, { type: "page.setup", margins: { left: 3000 } })).toBe(true)
			expect(await run(editor, { type: "page.setup", orientation: "landscape" })).toBe(true)
			expect(await run(editor, { type: "review.rejectAll" })).toBe(true)
			expect(await sections(await saved(opened))).toEqual([
				`<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="11906" w:h="16838"/>${MARGINS}</w:sectPr>`
			])
			editor.dispose()
		}
	})
})

describe("docx sections: a tracked break read back", () => {
	it("counts a break inserted while tracking as one change after a save, as in the session, and resolves it by its id", async () => {
		const bytes = buildDocx({
			body: p("Alpha beta") + p("Second") + `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>`
		})

		for (const accept of [true, false]) {
			const opened = await pagedEditor(bytes)
			const { editor, context } = opened

			context.identity.author = "Tester"
			context.review.tracking = true
			caret(editor, 6)
			expect(await run(editor, { type: "insert.sectionBreak", kind: "nextPage" })).toBe(true)

			const ids = (session: PagedEditor["body"]["session"]): string[] => [
				...new Set(
					storyReviewIndex(session)
						.entries()
						.map(entry => entry.id)
				)
			]

			expect(ids(editor.body.session)).toHaveLength(1)

			const again = await pagedEditor(await saved(opened))
			const session = again.editor.body.session
			const [id] = ids(session)

			expect(ids(session)).toHaveLength(1)
			expect(await run(again.editor, { type: accept ? "review.accept" : "review.reject", id: id as string })).toBe(true)
			expect(storyReviewIndex(session).revisionCount).toBe(0)

			const list = await sections(await saved(again))

			expect(list).toHaveLength(accept ? 2 : 1)
			expect(list.join("")).not.toContain("sectPrChange")
			editor.dispose()
			again.editor.dispose()
		}
	})
})

describe("docx sections: a recorded change takes back what it records", () => {
	// ECMA-376 Part 1 §17.13.5.32: w:sectPrChange holds "the complete set of section properties which were applied
	// to the parent section before this revision"; what it lacks had its default.
	it("rejects a change recorded with margins alone to that section whole: page size, columns and grid as defaults", async () => {
		const file = join(CORPUS_DIR, "docx", "oxpt__RP027-Change-Section.docx")

		if (!existsSync(file)) return

		const opened = await pagedEditor(new Uint8Array(readFileSync(file)))
		const { editor } = opened

		expect(await run(editor, { type: "review.rejectAll" })).toBe(true)

		const xml = await read(await saved(opened), "word/document.xml")
		const first = /<w:sectPr\b[^>]*>(?:(?!<\/w:sectPr>).)*<\/w:sectPr>/.exec(xml)?.[0] ?? ""

		expect(first).toBe(
			'<w:sectPr w:rsidR="000F585A" w:rsidSect="005B7327"><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		)
		editor.dispose()
	})

	// ECMA-376 Part 1 §17.13.5.32: the recorded w:sectPr is the section's previous properties whole, so the
	// line numbering it lacks (w:countBy has no "none" Word takes, MS-OI29500 Part 1 §17.6.8 c) was none.
	it("records what a section lacked before, so a reject after reopening gives the section back, no line numbers included", async () => {
		const bytes = buildDocx({ body: p("Alpha") + `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>${MARGINS}</w:sectPr>` })
		const opened = await pagedEditor(bytes)
		const { editor, context } = opened

		context.identity.author = "Tester"
		context.review.tracking = true
		caret(editor, 2)
		expect(await run(editor, { type: "page.setup", columns: { count: 2 } })).toBe(true)
		expect(await run(editor, { type: "page.setup", lineNumbers: { countBy: 1 } })).toBe(true)
		expect(await run(editor, { type: "insert.sectionBreak", kind: "continuous" })).toBe(true)

		const written = await saved(opened)
		// The last section's record: the type and columns it lacked, as their defaults. Line numbering has no form
		// for "none" Word takes (w:countBy is 1 to 100, MS-OI29500 Part 1 §17.6.8 c): the record holds none.
		const last = (await sections(written)).at(-1) ?? ""

		expect(last).toMatch(
			/<w:sectPrChange [^>]*><w:sectPr><w:type w:val="nextPage"\/><w:pgSz w:w="11906" w:h="16838"\/><w:pgMar [^>]*\/><w:cols w:space="720"\/><\/w:sectPr><\/w:sectPrChange>/
		)
		expect(last.slice(last.indexOf("<w:sectPrChange"))).not.toContain("w:lnNumType")

		const again = await pagedEditor(written)

		// The section the record holds comes back whole: the line numbering it lacks goes, as in the session.
		expect(await run(again.editor, { type: "review.rejectAll" })).toBe(true)
		expect(await sections(await saved(again))).toEqual([`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>${MARGINS}</w:sectPr>`])

		expect(await run(editor, { type: "review.rejectAll" })).toBe(true)
		expect(await sections(await saved(opened))).toEqual([`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>${MARGINS}</w:sectPr>`])
		editor.dispose()
		again.editor.dispose()
	})
})

describe("docx sections: Delete before a section break", () => {
	it("deletes the break, as Word's Delete at the end of the paragraph before it does, untracked and tracked", async () => {
		const bytes = buildDocx({
			body:
				p("One") +
				`<w:p><w:pPr>${SECTION('<w:cols w:num="2" w:space="720"/>')}</w:pPr><w:r><w:t>Breaker</w:t></w:r></w:p>` +
				p("Two") +
				`<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>${MARGINS}</w:sectPr>`,
			headers: { rIdH: p("Head") }
		})

		for (const tracked of [false, true]) {
			const opened = await pagedEditor(bytes)
			const { editor, context } = opened

			context.identity.author = "Tester"
			context.review.tracking = tracked
			// Mid-paragraph and in the last section, Delete is a plain deletion.
			caret(editor, 8)
			expect(deletesBreakAtCaret(editor)).toBe(false)
			caret(editor, editor.body.session.state.doc.content.size - 1)
			expect(deletesBreakAtCaret(editor)).toBe(false)
			caret(editor, 13)
			expect(deletesBreakAtCaret(editor)).toBe(true)
			expect(await run(editor, { type: "section.deleteBreak" })).toBe(true)
			// The caret stays at the join, where Delete (or Backspace from the paragraph after) found the break.
			expect(editor.body.session.state.selection.head).toBe(13)
			expect(editor.body.session.state.doc.textBetween(6, editor.body.session.state.selection.head)).toBe("Breaker")

			const list = await sections(await saved(opened))

			if (tracked) {
				expect(list).toHaveLength(2)
				expect(await read(await saved(opened), "word/document.xml")).toMatch(
					/<w:del w:id="\d+" w:author="Tester"[^>]*\/><\/w:rPr><w:sectPr>/
				)
			} else {
				// One section: the text before takes the following section's properties.
				expect(list).toEqual([
					`<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>${MARGINS}</w:sectPr>`
				])
				expect(editor.body.session.state.doc.child(1).textContent).toBe("BreakerTwo")
			}

			editor.dispose()
		}
	})
})

describe("docx sections: tracked edits on a section change the file recorded", () => {
	// ECMA-376 Part 1 §17.13.5.32: the record is the section's properties before the earliest change, whole.
	it("leave that record as it is, and a reject in the session and after a save give its section back", async () => {
		const live = '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="2000" w:header="720" w:footer="720" w:gutter="0"/>'
		const bytes = buildDocx({
			body:
				p("Alpha") +
				`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>${live}<w:sectPrChange w:id="9" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:sectPr>${MARGINS}</w:sectPr></w:sectPrChange></w:sectPr>`
		})
		const rejected: string[][] = []

		for (const reopen of [false, true]) {
			const opened = await pagedEditor(bytes)
			const { editor, context } = opened

			context.identity.author = "Tester"
			context.review.tracking = true
			caret(editor, 2)
			expect(await run(editor, { type: "page.setup", orientation: "landscape" })).toBe(true)
			expect(await run(editor, { type: "page.setup", columns: { count: 2 } })).toBe(true)

			const target = reopen ? await pagedEditor(await saved(opened)) : opened

			if (reopen) {
				const [recorded] = await sections(await saved(opened))

				// One change, Bob's, recording what it did.
				expect(recorded).toContain(
					`<w:sectPrChange w:id="9" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:sectPr>${MARGINS}</w:sectPr></w:sectPrChange>`
				)
			}

			expect(await run(target.editor, { type: "review.rejectAll" })).toBe(true)
			rejected.push(await sections(await saved(target)))
			editor.dispose()
			if (reopen) target.editor.dispose()
		}

		expect(rejected[0]).toEqual([`<w:sectPr>${MARGINS}</w:sectPr>`])
		expect(rejected[1]).toEqual(rejected[0])
	})

	it("adds its default for a property the section lacked, through two saves by two authors", async () => {
		const bytes = buildDocx({ body: p("Alpha") + "<w:sectPr/>" })
		const first = await pagedEditor(bytes)

		first.context.identity.author = "Tester"
		first.context.review.tracking = true
		caret(first.editor, 2)
		expect(await run(first.editor, { type: "page.setup", margins: { left: 720 } })).toBe(true)

		const second = await pagedEditor(await saved(first))

		second.context.identity.author = "Other"
		second.context.review.tracking = true
		caret(second.editor, 2)
		expect(await run(second.editor, { type: "page.setup", size: { width: 11906, height: 16838 }, columns: { count: 2 } })).toBe(true)

		const third = await pagedEditor(await saved(second))

		expect(await run(third.editor, { type: "review.rejectAll" })).toBe(true)

		const back = await saved(third)

		expect(await savedDigest(back)).toEqual(await savedDigest(bytes))
		expect(await sections(back)).toEqual([`<w:sectPr>${MARGINS}</w:sectPr>`])
		for (const opened of [first, second, third]) opened.editor.dispose()
	})
	it("writes a source's line numbering of w:countBy 0 (none, as other writers write it) as none, in a record and a new section", async () => {
		const bytes = buildDocx({
			body: p("Alpha") + `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>${MARGINS}<w:lnNumType w:countBy="0"/></w:sectPr>`
		})
		const opened = await pagedEditor(bytes)
		const { editor, context } = opened

		context.identity.author = "Tester"
		context.review.tracking = true
		caret(editor, 2)
		expect(await run(editor, { type: "page.setup", columns: { count: 2 } })).toBe(true)

		const last = (await sections(await saved(opened))).at(-1) ?? ""

		expect(last).toContain("<w:sectPrChange ")
		expect(last.slice(last.indexOf("<w:sectPrChange"))).not.toContain("w:lnNumType")

		// A section break made from it: no copy of the count either.
		context.review.tracking = false
		expect(await run(editor, { type: "insert.sectionBreak", kind: "continuous" })).toBe(true)
		expect((await sections(await saved(opened))).join("")).not.toContain('w:countBy="0"')
		editor.dispose()
	})
})
