import { readFileSync } from "node:fs"
import { strFromU8, unzipSync } from "fflate"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { RevisionView, layoutDocument } from "@filen/office/core/docx"
import { LINE_FLOATS, LINE_INTS, LineFloat, LineInt } from "@filen/office/core/text"
import { Region, SOURCE_INTS, SourceInt, type PageDisplayList } from "../core/docx/layout/index"
import type { PagedEditor, PagedEditorEvent } from "@filen/office/core/docx/paged"
import { DocxSaveError, PART_CONTRIBUTORS, prepareDocxSave, saveDocx, type PartContributor } from "@filen/office/core/docx/write"
import { commentParts } from "../core/docx/write/parts/comments"
import { buildDocx, modelOf, p } from "./docxSynthetic"
import { HmtxMeasurer, layOut, loadDocx } from "./layoutFixtures"
import { pageDigest, pagedEditor, savedDigest, settleAll } from "./pagedFixtures"

// Stories on the pages by region (headers, footers, notes, text boxes), entered where they are laid out;
// stories the editor adds; the revision view switched in place; paged layout suspended and resumed.

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(FIXTURES + name))

interface StoryLine {
	readonly page: number
	readonly story: number
	readonly x: number
	readonly y: number
}

// The middle of a line of `region` on any page (of an ordinary note, not a separator).
function lineOf(editor: PagedEditor, region: Region, story?: (story: number) => boolean): StoryLine | undefined {
	for (let index = 0; index < editor.pageCount; index++) {
		const page = editor.page(index) as PageDisplayList
		const text = page.text

		for (let line = 0; line < text.lineCount; line++) {
			const source = text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1

			if (source < 0 || page.sourceInts[source * SOURCE_INTS + SourceInt.REGION] !== region) continue

			const noteType = editor.edits.model.stories[page.sourceInts[source * SOURCE_INTS + SourceInt.STORY] ?? -1]?.noteType

			if (noteType !== undefined && noteType !== "normal") continue
			if (story !== undefined && !story(page.sourceInts[source * SOURCE_INTS + SourceInt.STORY] ?? -1)) continue

			const at = line * LINE_FLOATS
			const width = text.lineFloats[at + LineFloat.WIDTH] ?? 0

			if (width <= 1) continue

			return {
				page: index,
				story: page.sourceInts[source * SOURCE_INTS + SourceInt.STORY] ?? -1,
				x: (text.lineFloats[at + LineFloat.X] ?? 0) + width / 2,
				y: (text.lineFloats[at + LineFloat.TOP] ?? 0) + (text.lineFloats[at + LineFloat.HEIGHT] ?? 0) / 2
			}
		}
	}

	return undefined
}

async function expectSaved(
	editor: PagedEditor,
	pkg: Parameters<typeof saveDocx>[0]["pkg"],
	view: RevisionView = RevisionView.Final
): Promise<void> {
	await settleAll(editor)

	const saved = await saveDocx({ pkg, context: editor.body.session.context, sessions: editor.sessions })

	if (saved.bytes === undefined) throw new Error("no bytes")

	expect(pageDigest(editor.layout)).toEqual(
		view === RevisionView.Final ? await savedDigest(saved.bytes) : pageDigest(await layOut(saved.bytes, { view }))
	)
}

describe("docx stories by region", () => {
	it("finds headers, footers and notes where their lines are", async () => {
		const { editor } = await pagedEditor(fixture("03-header-footer-footnotes.docx"))

		for (const region of [Region.HEADER, Region.FOOTER, Region.FOOTNOTE]) {
			const line = lineOf(editor, region)

			if (line === undefined) throw new Error(`no line of region ${String(region)}`)

			expect(editor.storyAt(line.page, line.x, line.y), String(region)).toBe(line.story)
			expect(editor.edits.model.stories[line.story]?.kind).toBe(
				region === Region.HEADER ? "header" : region === Region.FOOTER ? "footer" : "footnote"
			)
		}

		const body = lineOf(editor, Region.BODY)
		const header = lineOf(editor, Region.HEADER)
		const band = body === undefined ? undefined : editor.bodyBand(body.page)

		if (body === undefined || header === undefined || band === undefined) throw new Error("no body")

		expect(editor.storyAt(body.page, body.x, body.y)).toBe(-1)

		// A note separator is never entered.
		const separator = editor.edits.model.stories.find(story => story?.noteType === "separator")

		if (separator !== undefined) expect(editor.enterStory(separator.index, 0)).toBe(false)
		// The margin above the body's lines belongs to the header, as in Word.
		expect(editor.storyAt(header.page, 5, Math.max(1, band.top - 4))).toBe(header.story)
		expect(editor.hitObject(body.page, body.x, body.y)).toBeUndefined()
		editor.dispose()
	})

	it("finds notes only in their own column", async () => {
		const para = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const lorem = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. "
		const section =
			'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/><w:cols w:num="2" w:space="720"/></w:sectPr>'
		const separators = (kind: string): string =>
			`<w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}><w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`
		const reference = (kind: string): string =>
			`<w:p><w:r><w:t>ref</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${kind}Reference w:id="1"/></w:r></w:p>`
		const documents = [
			buildDocx({
				body: para(lorem.repeat(6)) + reference("endnote") + para(lorem.repeat(30)) + section,
				endnotes: `${separators("endnote")}<w:endnote w:id="1">${para("Endnote text one which is long enough to wrap onto a few lines in a column. ".repeat(3))}</w:endnote>`
			}),
			buildDocx({
				body: para(lorem.repeat(4)) + reference("footnote") + para(lorem.repeat(60)) + section,
				footnotes: `${separators("footnote")}<w:footnote w:id="1">${para("Footnote text. ".repeat(8))}</w:footnote>`
			})
		]

		for (const bytes of documents) {
			const { editor } = await pagedEditor(bytes)
			let checked = 0

			for (let index = 0; index < editor.pageCount; index++) {
				const page = editor.page(index) as PageDisplayList
				const text = page.text
				// Note lines by story: their boxes (x, top, right, bottom).
				const lines: { story: number; left: number; right: number; top: number; bottom: number }[] = []

				for (let line = 0; line < text.lineCount; line++) {
					const source = text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1
					const region = page.sourceInts[source * SOURCE_INTS + SourceInt.REGION]
					const story = page.sourceInts[source * SOURCE_INTS + SourceInt.STORY] ?? -1

					if (
						(region !== Region.FOOTNOTE && region !== Region.ENDNOTE) ||
						editor.edits.model.stories[story]?.noteType !== "normal"
					)
						continue

					const at = line * LINE_FLOATS
					const left = text.lineFloats[at + LineFloat.X] ?? 0
					const top = text.lineFloats[at + LineFloat.TOP] ?? 0

					lines.push({
						story,
						left,
						right: left + (text.lineFloats[at + LineFloat.WIDTH] ?? 0),
						top,
						bottom: top + (text.lineFloats[at + LineFloat.HEIGHT] ?? 0)
					})
				}

				for (const line of lines) {
					const y = (line.top + line.bottom) / 2

					expect(editor.storyAt(index, (line.left + line.right) / 2, y)).toBe(line.story)

					// Level with the note line, in the other column: the note only if a line of it is there too.
					const x = line.left < page.width / 2 ? page.width * 0.75 : page.width * 0.25
					const there = lines.some(
						other =>
							other.story === line.story && x >= other.left - 1 && x <= other.right + 1 && Math.abs(other.top - line.top) < 1
					)

					if (!there) {
						expect(editor.storyAt(index, x, y)).not.toBe(line.story)
						checked++
					}
				}
			}

			expect(checked).toBeGreaterThan(0)
			editor.dispose()
		}
	})

	it("enters a footnote where it is laid out and lays out what the save writes", async () => {
		const { editor, pkg } = await pagedEditor(fixture("03-header-footer-footnotes.docx"))
		const line = lineOf(editor, Region.FOOTNOTE)

		if (line === undefined) throw new Error("no footnote")

		const story = editor.storyAt(line.page, line.x, line.y)

		expect(editor.enterStory(story, line.page)).toBe(true)
		expect(editor.activeRegion).toBe(Region.FOOTNOTE)

		const hit = editor.hitTest(line.page, line.x, line.y)

		if (hit === undefined) throw new Error("no hit in the footnote")

		editor.select(hit)
		expect(editor.caret()?.page).toBe(line.page)
		editor.dispatch(editor.state.tr.insertText(" (noted)"))
		expect(editor.session.state.doc.textContent).toContain("(noted)")
		await expectSaved(editor, pkg)
		editor.dispose()
	})

	it("finds text boxes where their lines are and edits them", async () => {
		const { editor, pkg } = await pagedEditor(fixture("06-textbox-shape.docx"))
		const line = lineOf(editor, Region.TEXTBOX)

		if (line === undefined) throw new Error("no text box line")

		expect(editor.storyAt(line.page, line.x, line.y)).toBe(line.story)
		expect(editor.enterStory(line.story, line.page)).toBe(true)
		expect(editor.activeRegion).toBe(Region.TEXTBOX)
		expect(editor.session.readOnly).toBe(false)
		expect(editor.snapshot().context.story.kind).toBe("textbox")
		editor.dispatch(editor.state.tr.insertText("Boxed: ", 1))
		await expectSaved(editor, pkg)
		editor.exitStory()
		expect(editor.session.readOnly).toBe(false)
		editor.dispose()
	})

	it("adds stories the editor made, entered like the document's own", async () => {
		const { editor, context, pkg } = await pagedEditor(fixture("03-header-footer-footnotes.docx"))
		const pages = editor.pageCount
		const shown = Array.from({ length: pages }, (_, index) => editor.page(index))
		const session = editor.addStory("footnote")

		if (session === undefined) throw new Error("no story added")

		const story = session.story.story
		const added = context.newStories.get(story)

		expect(added).toMatchObject({ kind: "footnote", target: "word/footnotes.xml" })
		expect(Number(added?.id)).toBeGreaterThan(context.model.maxIds.footnote)
		expect(editor.edits.model.footnotes.get(added?.id ?? "")).toBe(story)
		expect(editor.edits.addedStory(story.index)).toBe(true)
		expect(editor.sessions).toContain(session)
		expect(session.state.doc.childCount).toBe(1)
		expect(session.readOnly).toBe(false)

		// Nothing refers to it yet: typing there lays out nothing.
		expect(editor.enterStory(story.index, -1)).toBe(true)
		editor.dispatch(editor.state.tr.insertText("New note", 1))
		await settleAll(editor)
		expect(Array.from({ length: pages }, (_, index) => editor.page(index))).toEqual(shown)

		// A comment has no place on the pages: it has a session, and is never entered.
		const comment = editor.addStory("comment")

		expect(comment).toBeDefined()
		expect(editor.enterStory(comment?.story.story.index ?? -1, -1)).toBe(false)
		expect(editor.storySession(comment?.story.story.index ?? -1)).toBe(comment)
		expect(context.newStories.get(comment?.story.story ?? story)?.target).toBe("word/comments.xml")

		const header = editor.addStory("header")

		const target = context.newStories.get(header?.story.story ?? story)?.target ?? ""

		expect(target).toMatch(/^word\/header\d+\.xml$/)
		expect(pkg.has(target)).toBe(false)
		editor.dispose()
	})

	it("adds stories without a source of their own, on the document's part or on a template part", async () => {
		// The fixture has notes but no comments: a footnote goes on its notes part, a comment on a new one.
		const notes = await pagedEditor(fixture("03-header-footer-footnotes.docx"))
		const footnote = notes.editor.addStory("footnote")?.story.story
		const comment = notes.editor.addStory("comment")?.story.story
		const header = notes.editor.addStory("header")?.story.story

		if (footnote === undefined || comment === undefined || header === undefined) throw new Error("not added")

		for (const story of [footnote, comment, header]) expect(story.item).toBe(-1)

		expect(footnote.part).toBe(notes.editor.edits.model.footnotes.get("1")?.part)
		expect(notes.context.model.parts.some(part => part.name === "word/comments.xml")).toBe(false)
		expect(notes.editor.edits.model.parts[comment.part]?.name).toBe("word/comments.xml")
		expect(notes.editor.edits.model.parts[header.part]?.name).toMatch(/^word\/header\d+\.xml$/)
		expect(notes.context.newStories.get(header)?.kind).toBe("header")
		notes.editor.dispose()

		// Without notes: a notes part made from a template; its separators are notes of the derived model (laid out
		// as the saved part has them), no stories of the document.
		const plain = await pagedEditor(buildDocx({ body: "<w:p><w:r><w:t>Plain</w:t></w:r></w:p>" }))
		const endnote = plain.editor.addStory("endnote")?.story.story

		if (endnote === undefined) throw new Error("not added")

		const part = plain.editor.edits.model.parts[endnote.part]

		expect(endnote.item).toBe(-1)
		expect(part?.name).toBe("word/endnotes.xml")
		expect(new TextDecoder().decode(part?.document.bytes)).toContain('w:type="continuationSeparator"')
		expect(
			plain.editor.edits.model.stories.filter(story => story?.part === endnote.part).map(story => [story?.id, story?.noteType])
		).toEqual([
			["-1", "separator"],
			["0", "continuationSeparator"],
			[endnote.id, "normal"]
		])
		expect(plain.context.model.stories.some(story => story.part === endnote.part)).toBe(false)
		expect(plain.context.newStories.get(endnote)).toMatchObject({ kind: "endnote", target: "word/endnotes.xml" })
		plain.editor.dispose()
	})

	it("gives new notes ids the separators do not have, and new parts the main document's ignorable prefixes", async () => {
		const { editor, context } = await pagedEditor(buildDocx({ body: "<w:p><w:r><w:t>Plain</w:t></w:r></w:p>" }))
		const footnote = editor.addStory("footnote")?.story.story
		const second = editor.addStory("footnote")?.story.story

		if (footnote === undefined || second === undefined) throw new Error("not added")

		expect([footnote.id, second.id]).toEqual(["1", "2"])
		// Ids handed out never are the separators' (-1, 0); an id given is never handed out again.
		expect(editor.addStory("endnote")?.story.story.id).toBe("1")
		expect(editor.addStory("footnote", "7")?.story.story.id).toBe("7")
		expect(editor.addStory("footnote")?.story.story.id).toBe("8")
		expect(editor.addStory("comment")?.story.story.id).toBe("0")
		expect(context.ids.next("comment")).toBe(1)

		const part = editor.edits.model.parts[footnote.part]

		if (part === undefined) throw new Error("no part")

		const document = part.document
		const root = document.documentElement()

		expect(document.attribute(root, "mc:Ignorable")?.split(" ")).toEqual(expect.arrayContaining(["w14", "w15"]))
		expect(document.attribute(root, "xmlns:w14")).toBeDefined()

		// The part as the save writes it, the new notes in it, reads back with every id once.
		const xml = new TextDecoder().decode(document.bytes)
		const inner = xml.slice(xml.indexOf(">") + 1, xml.lastIndexOf("</"))
		const model = await modelOf({
			body: '<w:p><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>',
			footnotes: `${inner}<w:footnote w:id="1"><w:p><w:r><w:t>one</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>two</w:t></w:r></w:p></w:footnote>`
		})
		const ids = model.stories.filter(story => story.kind === "footnote").map(story => story.id)

		expect(ids).toEqual(["-1", "0", "1", "2"])
		expect(model.footnotes.get("1")?.noteType).toBe("normal")
		editor.dispose()
	})

	it("never gives a new story an id an orphan anchor or reference uses, nor the name of a part the package has", async () => {
		const bytes = buildDocx({
			body:
				'<w:p><w:commentRangeStart w:id="5"/><w:r><w:t>text</w:t></w:r><w:commentRangeEnd w:id="5"/><w:r><w:commentReference w:id="6"/></w:r>' +
				'<w:r><w:footnoteReference w:id="9"/></w:r></w:p>',
			// A comments part nothing relates to.
			parts: [
				{
					name: "word/comments.xml",
					contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
					data: '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'
				}
			]
		})
		const model = await modelOf({
			body: '<w:p><w:commentRangeStart w:id="5"/><w:r><w:commentReference w:id="6"/></w:r><w:r><w:footnoteReference w:id="9"/></w:r></w:p>'
		})

		expect(model.maxIds.comment).toBe(6)
		expect(model.maxIds.footnote).toBe(9)

		const { editor, context, pkg } = await pagedEditor(bytes)
		const comment = editor.addStory("comment")?.story.story
		const second = editor.addStory("comment")?.story.story
		const footnote = editor.addStory("footnote")?.story.story

		if (comment === undefined || second === undefined || footnote === undefined) throw new Error("not added")

		expect(pkg.has("word/comments.xml")).toBe(true)
		expect([comment.id, second.id, footnote.id]).toEqual(["7", "8", "10"])
		expect(context.newStories.get(comment)?.target).toBe("word/comments1.xml")
		expect(context.newStories.get(second)?.target).toBe("word/comments1.xml")
		editor.dispose()
	})

	it("lays out a note the editor added where its reference is, and enters it there", async () => {
		const para = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		// A reference to note 5, which the notes part does not hold (as a note command's new reference would be).
		const bytes = buildDocx({
			body: `<w:p><w:r><w:t>See</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="5"/></w:r></w:p>${para("More body text.")}`,
			footnotes:
				'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
				`<w:footnote w:id="1">${para("Other note")}</w:footnote>`
		})
		const { editor } = await pagedEditor(bytes)

		// Ids notes have, or that are no numbers, are refused.
		expect(editor.addStory("footnote", "1")).toBeUndefined()
		expect(editor.addStory("footnote", "x1")).toBeUndefined()

		const session = editor.addStory("footnote", "5")

		if (session === undefined) throw new Error("not added")

		expect(editor.enterStory(session.story.story.index, -1)).toBe(true)
		editor.dispatch(editor.state.tr.insertText("Brand new note text", 1))
		editor.exitStory()
		editor.layout.beginEdit(0, undefined)
		await settleAll(editor)

		const line = lineOf(editor, Region.FOOTNOTE, story => story === session.story.story.index)

		if (line === undefined) throw new Error("the new note is not laid out")

		expect(editor.page(line.page)?.sourceTexts.some(text => text.includes("Brand new note text"))).toBe(true)
		expect(editor.storyAt(line.page, line.x, line.y)).toBe(session.story.story.index)

		// Typing there lays out again as a fresh layout of the same edits does.
		expect(editor.enterStory(session.story.story.index, line.page)).toBe(true)
		editor.dispatch(editor.state.tr.insertText(" and more", editor.state.doc.content.size - 1))
		await settleAll(editor)

		const loaded = await loadDocx(bytes)
		const fresh = layoutDocument(editor.edits.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
			store: loaded.store,
			sliceMs: Infinity,
			edits: editor.edits
		})

		await fresh.done
		expect(pageDigest(editor.layout)).toEqual(pageDigest(fresh))
		expect(editor.page(line.page)?.sourceTexts.some(text => text.includes("Brand new note text and more"))).toBe(true)
		editor.dispose()
	})

	it("switches the revision view in place, edits in it and back", async () => {
		const bytes = fixture("04-comments-tracked.docx")
		const { editor, pkg } = await pagedEditor(bytes)

		expect(editor.setView(RevisionView.Final)).toBe(false)
		expect(editor.setView(RevisionView.Markup)).toBe(true)
		await settleAll(editor)
		expect(pageDigest(editor.layout)).toEqual(pageDigest(await layOut(bytes, { view: RevisionView.Markup })))

		const start = TextSelection.atStart(editor.state.doc).from

		editor.dispatch(editor.state.tr.insertText("Edited in markup. ", start))
		await expectSaved(editor, pkg, RevisionView.Markup)

		expect(editor.setView(RevisionView.Original)).toBe(true)
		await expectSaved(editor, pkg, RevisionView.Original)
		expect(editor.setView(RevisionView.Final)).toBe(true)
		await expectSaved(editor, pkg)
		editor.dispose()
	})

	it("keeps the caret out of text the revision view hides", async () => {
		const { editor } = await pagedEditor(fixture("04-comments-tracked.docx"))
		// The middle of the first inserted text.
		let inside = -1
		let start = -1
		let end = -1

		editor.state.doc.descendants((node, pos) => {
			if (inside < 0 && node.isText && node.nodeSize > 2 && node.marks.some(mark => mark.type.name === "insertion")) {
				start = pos
				end = pos + node.nodeSize
				inside = pos + 1
			}

			return inside < 0
		})
		expect(inside).toBeGreaterThan(0)

		// The caret moves on once the change was heard (a microtask later).
		const caret = async (pos: number): Promise<void> => {
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
			await Promise.resolve()
		}
		const isInserted = (pos: number): boolean => {
			const $pos = editor.state.doc.resolve(pos)
			const inserted = (node: typeof $pos.nodeAfter): boolean => node?.marks.some(mark => mark.type.name === "insertion") === true

			return inserted($pos.nodeBefore) && inserted($pos.nodeAfter)
		}

		// In Final view inserted text shows: the caret stays there.
		await caret(inside)
		expect(editor.selection().head).toBe(inside)

		// Original view hides it: the caret leaves it, and moving into it goes past it the way it moves.
		expect(editor.setView(RevisionView.Original)).toBe(true)
		expect(isInserted(editor.selection().head)).toBe(false)
		await caret(start - 1)
		await caret(inside)
		expect(editor.selection().head).toBeGreaterThanOrEqual(end)
		await caret(end + 1)
		await caret(end - 1)
		expect(editor.selection().head).toBeLessThanOrEqual(start)

		// Typing never lands in hidden text.
		editor.dispatch(editor.state.tr.insertText("x"))
		await Promise.resolve()
		expect(isInserted(editor.selection().head)).toBe(false)
		editor.dispose()
	})

	it("suspends paged layout and lays out from the first change on resume", async () => {
		const { editor, pkg } = await pagedEditor(fixture("03-header-footer-footnotes.docx"))
		const events: PagedEditorEvent[] = []

		editor.subscribe(event => events.push(event))
		editor.suspend()
		expect(editor.suspended).toBe(true)
		expect(editor.layout.suspended).toBe(true)

		const shown = editor.page(0)
		const start = TextSelection.atStart(editor.state.doc).from

		editor.dispatch(editor.state.tr.insertText("Typed while suspended. ".repeat(20), start))

		// A header edit is laid out on resume too.
		const header = lineOf(editor, Region.HEADER)

		if (header === undefined) throw new Error("no header")

		editor.enterStory(header.story, header.page)
		editor.dispatch(editor.state.tr.insertText("Draft ", TextSelection.atStart(editor.state.doc).from))
		editor.exitStory()
		await Promise.resolve()
		expect(events.some(event => event.type === "pages")).toBe(false)
		expect(editor.page(0)).toBe(shown)

		// Nothing settles while suspended: what changed is not laid out yet.
		let settled = false

		void editor.whenSettled().then(() => {
			settled = true
		})

		for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))

		expect(settled).toBe(false)
		expect(editor.settled).toBe(false)

		editor.resume()
		expect(editor.suspended).toBe(false)
		await expectSaved(editor, pkg)
		await Promise.resolve()
		expect(settled).toBe(true)
		expect(events.some(event => event.type === "pages")).toBe(true)
		editor.dispose()
	})

	it("keeps a suspended layout run waiting until it is resumed", async () => {
		const bytes = fixture("08-large-300p.docx")
		const loaded = await loadDocx(bytes)
		let clock = 0
		const layout = layoutDocument(loaded.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
			store: loaded.store,
			sliceMs: 2,
			now: () => clock++,
			yield: () => new Promise(resolve => setImmediate(resolve))
		})
		let done = false

		void layout.done.then(() => {
			done = true
		})
		await new Promise(resolve => setImmediate(resolve))
		layout.suspend()

		for (let k = 0; k < 30; k++) await new Promise(resolve => setImmediate(resolve))

		const laid = layout.pages.length

		expect(done).toBe(false)
		expect(layout.final).toBe(false)

		for (let k = 0; k < 30; k++) await new Promise(resolve => setImmediate(resolve))

		expect(layout.pages.length).toBe(laid)
		await layout.resume()
		await layout.done
		expect(done).toBe(true)
		expect(layout.final).toBe(true)
	})

	it("lays a header edited on a page where a continuous section starts out with the page's own margins", async () => {
		const para = (text: string, pPr = ""): string =>
			`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const margins = (left: number): string =>
			`<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="${String(left)}" w:header="720" w:footer="720" w:gutter="0"/>`
		const bytes = buildDocx({
			body:
				para("First section.", `<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/>${margins(2880)}</w:sectPr>`) +
				para("Second section, continuous on the same page.") +
				`<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:type w:val="continuous"/>${margins(720)}</w:sectPr>`,
			headers: { rIdH1: para("Header text") }
		})
		const { editor } = await pagedEditor(bytes)
		const header = lineOf(editor, Region.HEADER)

		if (header === undefined) throw new Error("no header")

		expect(editor.enterStory(header.story, header.page)).toBe(true)
		editor.dispatch(editor.state.tr.insertText("Edited ", TextSelection.atStart(editor.state.doc).from))
		editor.exitStory()
		await settleAll(editor)

		const loaded = await loadDocx(bytes)
		const fresh = layoutDocument(editor.edits.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
			store: loaded.store,
			sliceMs: Infinity,
			edits: editor.edits
		})

		await fresh.done
		expect(pageDigest(editor.layout)).toEqual(pageDigest(fresh))
		editor.dispose()
	})

	it("lays a footer out again once a font its edit needs has loaded", async () => {
		const para = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const bytes = buildDocx({
			body:
				Array.from({ length: 80 }, (_, k) => para(`Body paragraph ${String(k)} with plain words only`)).join("") +
				'<w:sectPr><w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>',
			footers: { rIdF1: para("Footer words") }
		})

		for (const budget of [Infinity, 0]) {
			const { editor } = await pagedEditor(bytes, budget)
			const footer = lineOf(editor, Region.FOOTER)

			if (footer === undefined) throw new Error("no footer")

			// Bold italic: a face nothing else in the document uses, loaded only when the footer needs it.
			expect(editor.enterStory(footer.story, footer.page)).toBe(true)
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, editor.state.doc.content.size - 1)))
			editor.execute({ type: "format.bold" })
			editor.execute({ type: "format.italic" })
			editor.exitStory()
			await settleAll(editor)

			const loaded = await loadDocx(bytes)
			const fresh = layoutDocument(editor.edits.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
				store: loaded.store,
				sliceMs: Infinity,
				edits: editor.edits
			})

			await fresh.done
			expect(pageDigest(editor.layout)).toEqual(pageDigest(fresh))
			editor.dispose()
		}
	})

	it("waits for layout to settle", async () => {
		const { editor } = await pagedEditor(fixture("03-header-footer-footnotes.docx"), 0)

		editor.dispatch(editor.state.tr.insertText("More text. ".repeat(200), TextSelection.atStart(editor.state.doc).from))

		const settled = editor.whenSettled()

		await settleAll(editor)
		await settled
		expect(editor.settled).toBe(true)
		editor.dispose()
	})
})

// A comments part related but holding no comment, written self-closing (as generators other than Word leave it).
describe("docx stories in a self-closing part", () => {
	const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
	const W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
	// Declaring w14 (the new comments' paragraph ids): the root is opened as it is.
	const ROOT = `<w:comments xmlns:w="${W}"  xmlns:w14="${W14}" xmlns:x="urn:x" x:keep="a&amp;b" />`
	const docx = (root: string): Uint8Array =>
		buildDocx({
			body: p("one two three"),
			relationships: [{ id: "rIdC", type: "comments", target: "comments.xml" }],
			parts: [
				{
					name: "word/comments.xml",
					contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
					data: root
				}
			]
		})
	const comments = (saved: Uint8Array): string => strFromU8(unzipSync(saved)["word/comments.xml"] ?? new Uint8Array())
	const open = async (root: string = ROOT): Promise<Awaited<ReturnType<typeof pagedEditor>>> => {
		const opened = await pagedEditor(docx(root))

		opened.context.identity.author = "Ann Lee"
		opened.editor.dispatch(opened.editor.state.tr.setSelection(TextSelection.create(opened.editor.state.doc, 1, 4)))

		return opened
	}

	it("opens the root for new comments, its start tag kept byte for byte", async () => {
		const opened = await open()

		expect(await opened.editor.execute({ type: "comment.add", text: "first" })).toBe(true)
		opened.editor.dispatch(opened.editor.state.tr.setSelection(TextSelection.create(opened.editor.state.doc, 5, 8)))
		expect(await opened.editor.execute({ type: "comment.add", text: "second" })).toBe(true)

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })
		const saved = result.bytes as Uint8Array
		const xml = comments(saved)

		expect(xml.startsWith(`${ROOT.slice(0, -2)}><w:comment `)).toBe(true)
		expect(xml.endsWith("</w:comment></w:comments>")).toBe(true)
		expect(xml.match(/<w:comment /g)).toHaveLength(2)

		const reopened = await pagedEditor(saved)

		expect(reopened.editor.edits.model.stories.filter(story => story?.kind === "comment")).toHaveLength(2)
		opened.editor.dispose()
		reopened.editor.dispose()
	})

	it("opens it with the declarations a comment's paragraph ids need", async () => {
		const opened = await open(`<w:comments xmlns:w="${W}" xmlns:x="urn:x" x:keep="a&amp;b"/>`)

		expect(await opened.editor.execute({ type: "comment.add", text: "first" })).toBe(true)

		const saved = (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })).bytes as Uint8Array
		const xml = comments(saved)

		expect(xml).toMatch(/^<w:comments xmlns:w="[^"]+" xmlns:x="urn:x" x:keep="a&amp;b" xmlns:w14="[^"]+" [^>]*><w:comment /)
		expect(xml).toContain("w14:paraId=")
		expect(xml.endsWith("</w:comment></w:comments>")).toBe(true)
		opened.editor.dispose()
	})

	it("refuses a new story anywhere else in it", async () => {
		const opened = await open()

		expect(await opened.editor.execute({ type: "comment.add", text: "first" })).toBe(true)

		const misplaced: PartContributor = {
			...commentParts,
			container(story, doc) {
				const container = commentParts.container?.(story, doc)
				const document = story.part.document

				return container === undefined ? undefined : { ...container, at: document.start(document.documentElement()) }
			}
		}
		const parts = PART_CONTRIBUTORS.map(contributor => (contributor === commentParts ? misplaced : contributor))
		const error = await prepareDocxSave({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions, parts }).catch(
			(caught: unknown) => caught
		)

		expect(error).toBeInstanceOf(DocxSaveError)
		expect((error as DocxSaveError).message).toContain("goes inside another element")
		opened.editor.dispose()
	})
})
