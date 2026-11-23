import { TextSelection } from "prosemirror-state"
import { describe, expect, it, vi } from "vitest"
import { saveDocx } from "@filen/office/core/docx/write"
import { paragraphPos } from "../core/docx/paged/editor"
import { buildDocx, p } from "./docxSynthetic"
import { readBytes } from "./layoutFixtures"
import { pageDigest, pagedEditor, savedDigest, settleAll } from "./pagedFixtures"

// Edits made while the pages rest (another surface shows the document): layout's view of the stories takes them
// on resume, in one go, and the pages are then those of a fresh layout of the saved file.

const FIXTURES = `${import.meta.dirname}/fixtures/`

describe("edits while the pages rest", () => {
	it("are taken by layout's view on resume, not keystroke by keystroke, and lay out as a fresh layout does", async () => {
		const { editor, pkg, context } = await pagedEditor(readBytes(`${FIXTURES}03-header-footer-footnotes.docx`))
		const session = editor.body.session
		const applied = vi.spyOn(editor.body.edits, "applyPending")

		editor.suspend()

		for (const word of ["one ", "two ", "three "]) session.dispatch(session.state.tr.insertText(word, 3))

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 5)))
		session.dispatch(session.state.tr.split(5))
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		session.dispatch(session.state.tr.insertText("lorem ipsum dolor sit amet ".repeat(80), 3))
		expect(applied).not.toHaveBeenCalled()

		editor.resume()
		// Taken on resume as one change: the story's applies are folded as they come.
		expect(applied).toHaveBeenCalledTimes(1)
		expect(editor.body.edits.document).toBe(session.state.doc)
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes as Uint8Array))
		applied.mockRestore()
		editor.dispose()
	})

	it("is not settled while layout's view is behind: what waits for layout waits for the resume", async () => {
		const { editor } = await pagedEditor(readBytes(`${FIXTURES}01-plain.docx`))
		const session = editor.body.session

		await settleAll(editor)
		editor.suspend()
		session.dispatch(session.state.tr.insertText("x", 3))
		expect(editor.settled).toBe(false)

		let settled = false

		void editor.whenSettled().then(() => {
			settled = true
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(settled).toBe(false)

		editor.resume()
		await settleAll(editor)
		expect(settled).toBe(true)
		editor.dispose()
	})

	it("keeps a story's applies as one change however many there are, so little is held meanwhile", async () => {
		const { editor } = await pagedEditor(readBytes(`${FIXTURES}01-plain.docx`))
		const session = editor.body.session
		const applied = vi.spyOn(editor.body.edits, "applyPending")

		editor.suspend()

		for (let k = 0; k < 450; k++) session.dispatch(session.state.tr.insertText("x", 3))

		// No catching up on a keystroke: one change, its first document and its last.
		expect(applied).not.toHaveBeenCalled()
		editor.resume()
		expect(applied).toHaveBeenCalledTimes(1)
		expect(editor.body.edits.document).toBe(session.state.doc)
		applied.mockRestore()
		editor.dispose()
	})
})

describe("a paragraph's place as laid out", () => {
	it("is checked against the document, and found in its top-level block when a record's place went stale", async () => {
		const cell = (text: string): string => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
		const { editor } = await pagedEditor(
			buildDocx({
				body: `<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr>${cell("A1")}</w:tr><w:tr>${cell("A2")}</w:tr></w:tbl>${p("After")}`
			})
		)
		const edits = editor.body.edits
		const doc = edits.document
		let a2 = -1

		doc.descendants((node, pos) => {
			if (a2 < 0 && node.type.name === "paragraph" && node.textContent === "A2") a2 = pos

			return a2 < 0
		})

		const paragraph = doc.nodeAt(a2)

		if (paragraph === null) throw new Error("no paragraph")

		expect(paragraphPos(edits, paragraph, a2)).toBe(a2)
		// A place past the paragraph (the size of one before it, since removed): where it is.
		expect(paragraphPos(edits, paragraph, a2 + paragraph.nodeSize)).toBe(a2)
		// A paragraph the block no longer holds: nowhere.
		expect(paragraphPos(edits, paragraph.type.create(), a2)).toBeUndefined()
		editor.dispose()
	})
})

describe("copies of a block on both sides of it in one change", () => {
	// Two pastes ending inside the block, one before it (moving it down) and one after it: each leaves a paragraph
	// with the block's source. Taken as one change (suspended, the applies fold), the block is kept and the copy
	// after it never takes its source, so no two entries lay that source out (layout showed a line twice).
	it("lay its source out once", async () => {
		const { editor, pkg, context } = await pagedEditor(buildDocx({ body: `${p("Alpha")}${p("Source block")}${p("Omega")}` }))
		const session = editor.body.session
		const doc = session.state.doc
		const alpha = doc.child(0).nodeSize
		const omega = alpha + doc.child(1).nodeSize
		// From inside Alpha to inside the block: its open end carries the block's attributes.
		const slice = doc.slice(3, alpha + 4)

		editor.suspend()
		session.dispatch(session.state.tr.replace(omega + 3, omega + 3, slice))
		session.dispatch(session.state.tr.replace(3, 3, slice))
		editor.resume()
		await settleAll(editor)

		const bases = editor.body.edits.entries.flatMap(entry => entry.base)

		expect(new Set(bases).size).toBe(bases.length)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes as Uint8Array))
		editor.dispose()
	})
})
