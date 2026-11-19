import { unzipSync } from "fflate"
import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import type { DocxPackage } from "@filen/office/core/docx"
import { describe, expect, it } from "vitest"
import { docxSchema, freshSlice, type DocxEditContext } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { saveDocx, serializeDocx, verifyDocxParts } from "@filen/office/core/docx/write"
import { sourceCopies } from "../core/docx/edit/session"
import { storyReviewIndex } from "../core/docx/review/accept"
import { docxNotes } from "../core/docx/stories/notes"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { pngHeader } from "./fuzz/ops/drawings"
import { pageDigest, pagedEditor, savedDigest, settleAll } from "./pagedFixtures"

// A pasted note reference: Word's paste makes a new note with a copy of the note's content; a cut pasted moves
// the note.

const SEPARATORS =
	'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
	'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
const PICTURE =
	'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="457200" cy="228600"/><wp:docPr id="7" name="Picture 7"/>' +
	'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="a.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
	'<pic:blipFill><a:blip r:embed="rIdPic"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="228600"/></a:xfrm>' +
	'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
// An embedded object (its own part, which a copy owns a copy of) with its VML shape.
const OBJECT =
	'<w:r><w:object w:dxaOrig="1440" w:dyaOrig="720"><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:72pt;height:36pt" o:ole="">' +
	'<v:imagedata r:id="rIdPic" o:title=""/></v:shape><o:OLEObject Type="Embed" ProgID="Package" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1" r:id="rIdOle"/></w:object></w:r>'
const NOTE = `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note text</w:t></w:r>${PICTURE}${OBJECT}</w:p></w:footnote>`

const SPEC: SyntheticDocx = {
	body:
		'<w:p><w:r><w:t>One</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>' +
		p("Two") +
		'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
	footnotes: SEPARATORS + NOTE,
	headers: { rIdH: p("Head") },
	parts: [
		{ name: "word/media/a.png", data: pngHeader(48, 24) },
		{
			name: "word/embeddings/oleObject1.bin",
			contentType: "application/vnd.openxmlformats-officedocument.oleObject",
			data: new Uint8Array([7, 8, 9])
		},
		{
			name: "word/_rels/footnotes.xml.rels",
			data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdPic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/><Relationship Id="rIdOle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject1.bin"/></Relationships>'
		}
	]
}

function noteRefs(doc: Node): number {
	let count = 0

	doc.descendants(node => {
		if (node.type === docxSchema.nodes.note_ref) count++

		return !node.isInline
	})

	return count
}

describe("pasted note references", () => {
	for (const edit of ["copy", "cut", "header", "tracked"] as const) {
		it(`${edit}: ${edit === "cut" ? "keeps its note" : edit === "header" ? "leaves the reference out" : "refers to a copy of its note whole, in one undo step"}`, async () => {
			const opened = await pagedEditor(buildDocx(SPEC))
			const { editor, context } = opened
			const body = editor.body.session
			const doc = body.state.doc
			const copied = doc.slice(1, doc.child(0).nodeSize - 1)
			const story = context.model.stories.find(entry => entry.kind === "header")

			if (edit === "tracked") {
				context.identity.author = "Ann"
				context.review.tracking = true
			}

			if (edit === "cut") expect(body.dispatch(body.state.tr.delete(1, doc.child(0).nodeSize - 1))).toBe(true)

			const session = edit === "header" && story !== undefined ? editor.storySession(story.index) : body

			if (session === undefined) throw new Error("no story")
			if (session !== body) expect(editor.enterStory(session.story.story.index, -1)).toBe(true)

			const at = session.state.doc.content.size - 1
			const slice = freshSlice(copied, sourceCopies(context), body.story.part.index, session.story.part.index, session === body)
			const tr = session.state.tr.replaceRange(at, at, slice).setMeta("uiEvent", "paste")

			docxNotes(editor).pasted(tr)
			expect(session.dispatch(tr)).toBe(true)
			await settleAll(editor)

			const result = await saveDocx({ pkg: opened.pkg, context, sessions: editor.sessions })
			const bytes = result.bytes as Uint8Array
			const files = unzipSync(bytes)
			const text = (name: string): string => new TextDecoder().decode(files[name])
			const ids = [...text("word/document.xml").matchAll(/<w:footnoteReference w:id="(\d+)"\/>/g)].map(match => match[1])
			const copies = edit === "copy" || edit === "tracked" ? 2 : 1

			expect(pageDigest(editor.layout)).toEqual(await savedDigest(bytes))
			expect(ids).toHaveLength(copies)
			expect(new Set(ids).size).toBe(ids.length)
			expect(text("word/footnotes.xml").match(/Note text/g)).toHaveLength(copies)
			// Each whole: its mark and its picture, the copy's with a drawing id of its own.
			expect(text("word/footnotes.xml").match(/<w:footnoteRef\/>/g)).toHaveLength(copies)
			expect(text("word/footnotes.xml").match(/r:embed="rIdPic"/g)).toHaveLength(copies)
			expect(new Set(text("word/footnotes.xml").match(/<wp:docPr id="\d+"/g)).size).toBe(copies)
			// The embedded object: a part of the copy's own, a VML shape and object id of its own.
			const objects = [
				...text("word/footnotes.xml").matchAll(/ShapeID="([^"]+)" DrawAspect="Content" ObjectID="([^"]+)" r:id="([^"]+)"/g)
			]
			const relationships = text("word/_rels/footnotes.xml.rels")

			expect(objects).toHaveLength(copies)
			expect(new Set(objects.map(match => match[1])).size).toBe(copies)
			expect(new Set(objects.map(match => match[2])).size).toBe(copies)

			for (const [, shape, , id] of objects) {
				expect(text("word/footnotes.xml")).toContain(`<v:shape id="${shape ?? ""}"`)
				expect(relationships).toMatch(new RegExp(`Id="${id ?? ""}" Type="[^"]*oleObject" Target="embeddings/oleObject\\d\\.bin"`))
			}

			if (copies === 2) {
				expect(files["word/embeddings/oleObject2.bin"]).toEqual(new Uint8Array([7, 8, 9]))
				expect(new Set(objects.map(match => match[3])).size).toBe(2)
			}
			expect(text("word/header1.xml")).not.toContain("footnoteReference")

			if (edit === "tracked") {
				expect(text("word/footnotes.xml")).toMatch(/<w:ins w:id="\d+" w:author="Ann"[^>]*>.*Note text/)
				expect(storyReviewIndex(body).revisionCount).toBeGreaterThan(0)
			}

			if (copies === 2) {
				// One undo step takes the paste back, its reference included; the copy is left out of the save.
				expect(await editor.execute({ type: "history.undo" })).toBe(true)
				expect(noteRefs(body.state.doc)).toBe(1)
				await settleAll(editor)

				const undone = unzipSync((await saveDocx({ pkg: opened.pkg, context, sessions: editor.sessions })).bytes as Uint8Array)

				expect(new TextDecoder().decode(undone["word/footnotes.xml"]).match(/Note text/g)).toHaveLength(1)
			}

			editor.dispose()
		})
	}
})

// A paste of the first paragraph (its note reference) at the end of the body, as the clipboard makes it.
function pasteFirst(editor: PagedEditor, context: DocxEditContext): boolean {
	const body = editor.body.session
	const doc = body.state.doc
	const copied = doc.slice(1, doc.child(0).nodeSize - 1)
	const at = doc.content.size - 1
	const slice = freshSlice(copied, sourceCopies(context), body.story.part.index, body.story.part.index, true)
	const tr = body.state.tr.replaceRange(at, at, slice).setMeta("uiEvent", "paste")

	return docxNotes(editor).pasted(tr) && body.dispatch(tr)
}

async function savedParts(opened: { editor: PagedEditor; pkg: DocxPackage; context: DocxEditContext }): Promise<(name: string) => string> {
	await settleAll(opened.editor)

	const bytes = (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })).bytes as Uint8Array
	const files = unzipSync(bytes)

	expect(pageDigest(opened.editor.layout)).toEqual(await savedDigest(bytes))

	return name => (files[name] === undefined ? "" : new TextDecoder().decode(files[name]))
}

function noteStory(editor: PagedEditor, kind: string): number {
	return editor.edits.model.stories.find(story => story.kind === kind && story.noteType === "normal")?.index ?? -1
}

describe("pasted and converted notes keep what they hold", () => {
	it("copies a note holding a picture the editor inserted, made in the editor or in a source note", async () => {
		for (const made of [true, false]) {
			const opened = await pagedEditor(buildDocx(made ? { body: p("Alpha beta") } : SPEC))
			const { editor, context } = opened
			const body = editor.body.session

			if (made) {
				body.dispatch(body.state.tr.setSelection(TextSelection.create(body.state.doc, 3)))
				expect(await editor.execute({ type: "note.insertFootnote" })).toBe(true)
				editor.session.dispatch(editor.session.state.tr.insertText("the note"))
			} else {
				expect(editor.enterStory(noteStory(editor, "footnote"), -1)).toBe(true)
				editor.session.dispatch(editor.session.state.tr.setSelection(TextSelection.atEnd(editor.session.state.doc)))
			}

			expect(await editor.execute({ type: "image.insert", media: editor.addMedia(pngHeader(96, 48)) as number })).toBe(true)
			editor.exitStory()
			expect(pasteFirst(editor, context)).toBe(true)

			const fn = (await savedParts(opened))("word/footnotes.xml")
			const docPr = [...fn.matchAll(/<wp:docPr id="(\d+)"/g)].map(match => match[1])

			expect(fn.match(made ? /the note/g : /Note text/g)).toHaveLength(2)
			// The inserted picture in both, the source's picture in both: every drawing id its own.
			expect(fn.match(/a:blip /g)).toHaveLength(made ? 2 : 4)
			expect(new Set(docPr).size).toBe(docPr.length)
			editor.dispose()
		}
	})

	it("keeps text that reads like a relationship placeholder, and copies an owned part only while the original keeps it", async () => {
		const opened = await pagedEditor(
			buildDocx({ ...SPEC, footnotes: SEPARATORS + NOTE.replace("Note text", 'Note text say "filenCopiedPart1"') })
		)
		const { editor, context } = opened
		const body = editor.body.session

		expect(pasteFirst(editor, context)).toBe(true)

		// The original reference goes: the copy takes the original's embedded object, no copy of it is made.
		const first = body.state.doc.child(0)
		let at = -1

		first.descendants((node, pos) => {
			if (node.type === docxSchema.nodes.note_ref) at = pos + 1
		})
		expect(body.dispatch(body.state.tr.delete(at, at + 1))).toBe(true)

		const read = await savedParts(opened)
		const fn = read("word/footnotes.xml")

		expect(fn).toContain('say "filenCopiedPart1"')
		expect(fn.match(/<w:footnote w:id="\d+">/g)).toHaveLength(1)
		expect(fn).toMatch(/ObjectID="[^"]+" r:id="rIdOle"/)
		expect(read("word/embeddings/oleObject2.bin")).toBe("")
		editor.dispose()
	})

	it("converts a footnote holding a picture and an embedded object to an endnote whole, and back", async () => {
		for (const endnotes of [false, true]) {
			const opened = await pagedEditor(
				buildDocx({
					...SPEC,
					...(endnotes ? { endnotes: SEPARATORS.replace(/footnote/g, "endnote") } : {})
				})
			)
			const { editor } = opened
			const body = editor.body.session

			body.dispatch(body.state.tr.setSelection(TextSelection.create(body.state.doc, 4)))
			expect(await editor.execute({ type: "note.convert" })).toBe(true)

			const read = await savedParts(opened)
			const en = read("word/endnotes.xml")
			const rels = read("word/_rels/endnotes.xml.rels")
			const embed = /r:embed="([^"]+)"/.exec(en)?.[1] ?? ""
			const ole = /ObjectID="[^"]+" r:id="([^"]+)"/.exec(en)?.[1] ?? ""

			expect(read("word/document.xml")).toMatch(/<w:endnoteReference w:id="\d+"\/>/)
			expect(en).toContain("Note text")
			expect(en).toContain("<w:endnoteRef/>")
			expect(en).not.toContain("footnoteRef")
			expect(rels).toMatch(new RegExp(`Id="${embed}" Type="[^"]*image" Target="media/a.png"`))
			// The footnote went: its embedded object goes with the note, no copy made.
			expect(rels).toMatch(new RegExp(`Id="${ole}" Type="[^"]*oleObject" Target="embeddings/oleObject1.bin"`))
			expect(read("word/footnotes.xml")).not.toContain("Note text")
			// What the footnote's going left unused is no relationship of the footnotes part any more.
			expect(read("word/_rels/footnotes.xml.rels")).not.toMatch(/rIdPic|rIdOle/)
			expect(await editor.execute({ type: "note.convertAll", to: "footnote" })).toBe(true)
			expect((await savedParts(opened))("word/footnotes.xml")).toMatch(/Note text.*a:blip.*OLEObject/s)
			editor.dispose()
		}
	})

	it("gives a converted copy of a pasted note an embedded object of its own while the original keeps its", async () => {
		const opened = await pagedEditor(buildDocx(SPEC))
		const { editor, context } = opened
		const body = editor.body.session

		expect(pasteFirst(editor, context)).toBe(true)

		let at = -1

		body.state.doc.lastChild?.descendants((node, pos) => {
			if (node.type === docxSchema.nodes.note_ref)
				at = body.state.doc.content.size - (body.state.doc.lastChild?.nodeSize ?? 0) + pos + 1
		})
		body.dispatch(body.state.tr.setSelection(TextSelection.create(body.state.doc, at)))
		expect(await editor.execute({ type: "note.convert" })).toBe(true)

		const read = await savedParts(opened)
		const fn = read("word/footnotes.xml")
		const en = read("word/endnotes.xml")
		const footnoteOle = /OLEObject[^>]* r:id="([^"]+)"/.exec(fn)?.[1] ?? ""
		const endnoteOle = /OLEObject[^>]* r:id="([^"]+)"/.exec(en)?.[1] ?? ""

		expect(read("word/_rels/footnotes.xml.rels")).toMatch(new RegExp(`Id="${footnoteOle}"[^>]*Target="embeddings/oleObject1.bin"`))
		expect(read("word/_rels/endnotes.xml.rels")).toMatch(new RegExp(`Id="${endnoteOle}"[^>]*Target="embeddings/oleObject2.bin"`))
		editor.dispose()
	})

	it("converts a note edited first: its embedded object moves with it, no copy, nothing left behind", async () => {
		const opened = await pagedEditor(buildDocx({ ...SPEC, endnotes: SEPARATORS.replace(/footnote/g, "endnote") }))
		const { editor } = opened

		expect(editor.enterStory(noteStory(editor, "footnote"), -1)).toBe(true)
		editor.session.dispatch(editor.session.state.tr.insertText(" typed", 3))
		editor.exitStory()

		const body = editor.body.session

		body.dispatch(body.state.tr.setSelection(TextSelection.create(body.state.doc, 4)))
		expect(await editor.execute({ type: "note.convert" })).toBe(true)

		const read = await savedParts(opened)
		const ole = /OLEObject[^>]* r:id="([^"]+)"/.exec(read("word/endnotes.xml"))?.[1] ?? ""

		expect(read("word/endnotes.xml")).toContain("typed")
		expect(read("word/_rels/endnotes.xml.rels")).toMatch(new RegExp(`Id="${ole}"[^>]*Target="embeddings/oleObject1.bin"`))
		expect(read("word/embeddings/oleObject2.bin")).toBe("")
		expect(read("[Content_Types].xml")).not.toContain("oleObject2")
		expect(read("word/_rels/footnotes.xml.rels")).not.toMatch(/rIdPic|rIdOle/)
		editor.dispose()
	})

	it("takes a copied embedded object out of the package with the last relationship to it", async () => {
		const opened = await pagedEditor(buildDocx(SPEC))

		opened.context.identity.author = "Ann"
		opened.context.review.tracking = true
		expect(pasteFirst(opened.editor, opened.context)).toBe(true)
		await settleAll(opened.editor)

		const tracked = (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })).bytes as Uint8Array

		expect(unzipSync(tracked)["word/embeddings/oleObject2.bin"]).toEqual(new Uint8Array([7, 8, 9]))
		opened.editor.dispose()

		const reopened = await pagedEditor(tracked)

		expect(await reopened.editor.execute({ type: "review.rejectAll" })).toBe(true)

		const read = await savedParts(reopened)

		expect(read("word/footnotes.xml").match(/Note text/g)).toHaveLength(1)
		expect(read("word/_rels/footnotes.xml.rels")).not.toContain("oleObject2")
		expect(read("word/embeddings/oleObject2.bin")).toBe("")
		expect(read("[Content_Types].xml")).not.toContain("oleObject2")
		// The original keeps its object and its picture.
		expect(read("word/embeddings/oleObject1.bin")).not.toBe("")
		expect(read("word/_rels/footnotes.xml.rels")).toContain('Target="embeddings/oleObject1.bin"')
		expect(read("word/_rels/footnotes.xml.rels")).toContain('Target="media/a.png"')

		// Gate 2 refuses a part taken out while a relationship still points at it.
		const changes = await serializeDocx({ pkg: reopened.pkg, context: reopened.context, sessions: reopened.editor.sessions })

		const removing = (name: string): Promise<void> =>
			verifyDocxParts({
				original: reopened.pkg,
				context: reopened.context,
				changes: { ...changes, remove: [...(changes.remove ?? []), name] }
			})

		await expect(removing("word/media/a.png")).rejects.toThrow(/rIdPic points at a missing part/)
		await expect(removing("word/header1.xml")).rejects.toThrow(/rIdH points at a removed part/)
		reopened.editor.dispose()
	})

	it("refuses a copy or a conversion of a note holding what cannot be copied, rather than leave it out", async () => {
		const locked =
			'<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note text</w:t></w:r></w:p>' +
			'<w:sdt><w:sdtPr><w:id w:val="5"/><w:lock w:val="contentLocked"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Locked</w:t></w:r></w:p></w:sdtContent></w:sdt></w:footnote>'
		const opened = await pagedEditor(buildDocx({ ...SPEC, footnotes: SEPARATORS + locked }))
		const { editor, context } = opened
		const body = editor.body.session
		const before = body.state.doc

		expect(pasteFirst(editor, context)).toBe(false)
		expect(body.state.doc).toBe(before)
		body.dispatch(body.state.tr.setSelection(TextSelection.create(body.state.doc, 4)))
		expect(await editor.execute({ type: "note.convert" })).toBe(false)
		expect(body.state.doc).toBe(before)
		editor.dispose()
	})
})
