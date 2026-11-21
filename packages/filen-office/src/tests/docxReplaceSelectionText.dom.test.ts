import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { plainTextRange, replaceSelectionText } from "@filen/office/react/docx/editor"
import { sessionOf } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedFixtures"

// The assistant's rewrite of a selection lands as one undo step through the story's own dispatch.

function select(editor: PagedEditor, from: number, to: number): void {
	editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
}

function paragraphs(editor: PagedEditor): string[] {
	const out: string[] = []

	editor.state.doc.forEach(node => {
		if (node.type.name === "paragraph") out.push(node.textContent)
	})

	return out
}

async function open(body: string): Promise<PagedEditor> {
	const opened = await pagedEditor(buildDocx({ body }))

	opened.context.identity.author = "Ann Lee"
	opened.context.identity.initials = "AL"

	return opened.editor
}

// Positions of `text` in the first paragraph holding it.
function rangeOf(editor: PagedEditor, text: string): { from: number; to: number } {
	let found: { from: number; to: number } | undefined

	editor.state.doc.descendants((node, pos) => {
		const at = node.isText ? (node.text ?? "").indexOf(text) : -1

		if (found === undefined && at !== -1) found = { from: pos + at, to: pos + at + text.length }

		return found === undefined
	})

	if (found === undefined) throw new Error(`no "${text}"`)

	return found
}

describe("replaceSelectionText", () => {
	it("replaces the selection as one undo step and keeps one line in its paragraph", async () => {
		const editor = await open(p("Hello wrold, how are you?") + p("Second"))
		const range = rangeOf(editor, "Hello wrold")

		select(editor, range.from, range.to)
		expect(replaceSelectionText(editor, "Hello world")).toBe(true)
		expect(paragraphs(editor)).toEqual(["Hello world, how are you?", "Second"])

		const selection = editor.selection()

		expect(editor.state.doc.textBetween(selection.from, selection.to)).toBe("Hello world")
		expect(editor.execute({ type: "history.undo" })).toBe(true)
		expect(paragraphs(editor)).toEqual(["Hello wrold, how are you?", "Second"])
		expect(editor.execute({ type: "history.undo" })).toBe(false)
	})

	it("splits paragraphs for several lines, as a paste of plain text does, and replaces a given range", async () => {
		const editor = await open(p("One two three"))
		const range = rangeOf(editor, "two")

		expect(replaceSelectionText(editor, "2\n2b", range)).toBe(true)
		expect(paragraphs(editor)).toEqual(["One 2", "2b three"])
		expect(editor.execute({ type: "history.undo" })).toBe(true)
		expect(paragraphs(editor)).toEqual(["One two three"])
	})

	it("keeps the formatting the replaced text starts with", async () => {
		const editor = await open(
			'<w:p><w:r><w:t xml:space="preserve">plain </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r></w:p>'
		)
		const range = rangeOf(editor, "bold")

		expect(replaceSelectionText(editor, "BOLD", range)).toBe(true)

		const replaced = rangeOf(editor, "BOLD")
		const node = editor.state.doc.nodeAt(replaced.from)

		expect(node?.marks.some(mark => mark.type.name === "bold")).toBe(true)
	})

	it("refuses ranges that are not plain text: across a table's cells, a tracked change, an empty range", async () => {
		const table =
			"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>left</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>right</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
		const tracked = '<w:p><w:ins w:id="1" w:author="Bob" w:date="2024-01-02T03:04:05Z"><w:r><w:t>new</w:t></w:r></w:ins></w:p>'
		const editor = await open(p("Before") + table + tracked)
		const left = rangeOf(editor, "left")
		const right = rangeOf(editor, "right")

		expect(plainTextRange(editor.state.doc, left)).toBe(true)
		expect(plainTextRange(editor.state.doc, { from: left.from, to: right.to })).toBe(false)
		expect(plainTextRange(editor.state.doc, rangeOf(editor, "new"))).toBe(false)
		expect(plainTextRange(editor.state.doc, { from: left.from, to: left.from })).toBe(false)
		expect(replaceSelectionText(editor, "x", { from: left.from, to: right.to })).toBe(false)
	})

	it("is refused by a read-only session", async () => {
		const session = await sessionOf({ body: p("Read only") }, { readOnly: true })
		const before = session.state.doc

		expect(replaceSelectionText(session, "Changed", { from: 1, to: 5 })).toBe(false)
		expect(session.state.doc).toBe(before)
	})

	it("is tracked as a deletion and an insertion with track changes on", async () => {
		const editor = await open(p("Fix this text"))
		const range = rangeOf(editor, "this")

		expect(await editor.execute({ type: "review.track", on: true })).toBe(true)
		expect(replaceSelectionText(editor, "that", range)).toBe(true)

		const marked: string[] = []

		editor.state.doc.descendants(node => {
			if (node.isText) marked.push(`${node.text ?? ""}:${node.marks.map(mark => mark.type.name).join("+")}`)
		})

		expect(marked.some(entry => entry.startsWith("this:") && entry.includes("deletion"))).toBe(true)
		expect(marked.some(entry => entry.startsWith("that:") && entry.includes("insertion"))).toBe(true)
		expect(editor.execute({ type: "history.undo" })).toBe(true)
		expect(paragraphs(editor)).toEqual(["Fix this text"])
	})
})
