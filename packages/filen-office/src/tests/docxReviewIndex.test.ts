import { TextSelection } from "prosemirror-state"
import { AddNodeMarkStep, AttrStep, DocAttrStep } from "prosemirror-transform"
import { describe, expect, it } from "vitest"
import { docxSchema, type DocxEditorSession } from "@filen/office/core/docx/edit"
import { markCommand, markInternal } from "../core/docx/edit/invariants/index"
import { ReviewIndex, ReviewKind } from "../core/docx/review/index"
import { sessionOf } from "./docxEditFixtures"
import { rng } from "./mulberry32"

// The review index follows edits incrementally and always equals a fresh scan of the document.

const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const BODY =
	`<w:p>${run("Before ")}<w:commentRangeStart w:id="1"/>${run("commented words")}<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>${run(" after.")}</w:p>` +
	`<w:p>${run("Kept ")}<w:ins w:id="10" w:author="Ann" w:date="2026-01-01T00:00:00Z">${run("inserted text")}</w:ins>${run(" and ")}<w:del w:id="11" w:author="Bob" w:date="2026-01-02T00:00:00Z"><w:r><w:delText>deleted text</w:delText></w:r></w:del>${run(" end.")}</w:p>` +
	`<w:p><w:pPr><w:rPr><w:ins w:id="12" w:author="Ann" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr>${run("A paragraph whose mark was inserted")}</w:p>` +
	`<w:p>${run("Plain paragraph with more words to edit in it")}</w:p>` +
	`<w:p><w:commentRangeStart w:id="2"/>${run("Second comment across")}</w:p><w:p>${run("two paragraphs")}<w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r></w:p>`
const COMMENTS =
	'<w:comment w:id="1" w:author="Ann"><w:p><w:r><w:t>One</w:t></w:r></w:p></w:comment><w:comment w:id="2" w:author="Bob"><w:p><w:r><w:t>Two</w:t></w:r></w:p></w:comment>'

function expectFresh(session: DocxEditorSession): void {
	const index = session.reviewIndex
	const fresh = new ReviewIndex(session.state.doc)

	const entries = index.entries()

	expect(entries).toEqual(fresh.entries())
	expect(index.commentCount).toBe(fresh.commentCount)
	expect(index.revisionCount).toBe(fresh.revisionCount)

	// The comment-only view and the binary-searched range lookup agree with the entries.
	expect([...index.commentEntries()].map(k => [index.fromOf(k), index.kindOf(k), index.idOf(k)])).toEqual(
		entries.filter(entry => entry.kind <= ReviewKind.COMMENT_REFERENCE).map(entry => [entry.from, entry.kind, entry.id])
	)

	const size = session.state.doc.content.size

	for (const from of [0, Math.floor(size / 3), Math.floor(size / 2), size - 3]) {
		for (const to of [from, from + 4]) {
			const end = Math.max(to, from + 1)

			expect(index.between(from, to)).toEqual(entries.filter(entry => entry.from < end && Math.max(entry.to, entry.from + 1) > from))
		}
	}
}

// Positions inside paragraphs' text.
function textPositions(session: DocxEditorSession): number[] {
	const out: number[] = []

	session.state.doc.descendants((node, pos) => {
		if (node.isTextblock) {
			for (let k = 1; k < node.nodeSize - 1; k++) out.push(pos + k)

			return false
		}

		return true
	})

	return out
}

describe("docx review index", () => {
	it("finds comment anchors and tracked changes", async () => {
		const session = await sessionOf({ body: BODY, comments: COMMENTS })
		const index = session.reviewIndex
		const kinds = index.entries().map(entry => [entry.kind, entry.id])

		expect(index.commentCount).toBe(2)
		expect(index.revisionCount).toBe(3)
		expect(kinds).toEqual([
			[ReviewKind.COMMENT_START, "1"],
			[ReviewKind.COMMENT_END, "1"],
			[ReviewKind.COMMENT_REFERENCE, "1"],
			[ReviewKind.INSERTION, "10"],
			[ReviewKind.DELETION, "11"],
			[ReviewKind.PARAGRAPH, expect.stringMatching(/^#\d+$/)],
			[ReviewKind.COMMENT_START, "2"],
			[ReviewKind.COMMENT_END, "2"],
			[ReviewKind.COMMENT_REFERENCE, "2"]
		])

		const insertion = index.entries().find(entry => entry.kind === ReviewKind.INSERTION)

		if (insertion === undefined) throw new Error("no insertion")

		expect(session.state.doc.textBetween(insertion.from, insertion.to)).toBe("inserted text")
		expect(index.between(insertion.from + 2, insertion.from + 3).map(entry => entry.kind)).toEqual([ReviewKind.INSERTION])
	})

	it("maps entries through edits and reads only changed paragraphs again", async () => {
		const session = await sessionOf({ body: BODY, comments: COMMENTS })
		const index = session.reviewIndex
		const insertion = index.entries().find(entry => entry.kind === ReviewKind.INSERTION)

		if (insertion === undefined) throw new Error("no insertion")

		const version = index.version

		// Typing in the plain paragraph changes nothing but positions after it.
		const plain = textPositions(session).find(pos => session.state.doc.resolve(pos).parent.textContent.startsWith("Plain")) ?? 0

		session.dispatch(session.state.tr.insertText("xyz", plain))
		expect(index.version).toBe(version)
		expectFresh(session)

		// Typing before the insertion moves it.
		session.dispatch(session.state.tr.insertText("12", insertion.from - 1))
		expect(index.entries().find(entry => entry.kind === ReviewKind.INSERTION)?.from).toBe(insertion.from + 2)
		expectFresh(session)

		// Deleting the commented words takes the comment's anchors out only if they go (they survive deletion).
		session.dispatch(session.state.tr.delete(3, 20))
		expectFresh(session)
		expect(index.commentCount).toBe(2)
	})

	it("tells comment changes apart from changes of tracked changes only", async () => {
		const session = await sessionOf({ body: BODY, comments: COMMENTS })
		const index = session.reviewIndex
		const insertion = index.entries().find(entry => entry.kind === ReviewKind.INSERTION)

		if (insertion === undefined) throw new Error("no insertion")

		const version = index.version
		const comments = index.commentVersion

		// Typing inside the insertion reads its paragraph again: its entry changed, no comment's did.
		session.dispatch(session.state.tr.insertText("x", insertion.from + 2))
		expect(index.version).toBeGreaterThan(version)
		expect(index.commentVersion).toBe(comments)
		expectFresh(session)

		// Typing in the commented paragraph reads its comment's entries again.
		session.dispatch(session.state.tr.insertText("y", 3))
		expect(index.commentVersion).toBeGreaterThan(comments)
		expectFresh(session)
	})

	it("inserts entries found in the middle and moves the ones after it by a keystroke's length", async () => {
		const session = await sessionOf({ body: BODY, comments: COMMENTS })
		const plain = textPositions(session).find(pos => session.state.doc.resolve(pos).parent.textContent.startsWith("Plain")) ?? 0

		// A new comment's anchors in the plain paragraph go between the entries before it and after it.
		session.dispatch(
			session.state.tr.insert(plain + 1, [
				docxSchema.nodes.marker.create({ kind: "commentRangeStart", id: "9" }),
				docxSchema.text("new"),
				docxSchema.nodes.marker.create({ kind: "commentRangeEnd", id: "9" })
			])
		)
		expectFresh(session)

		for (let k = 0; k < 5; k++) {
			session.dispatch(session.state.tr.insertText("k", plain))
			expectFresh(session)
		}
	})

	it("equals a fresh scan after random edits", async () => {
		for (let seed = 1; seed <= 6; seed++) {
			const random = rng(seed)
			const session = await sessionOf({ body: BODY, comments: COMMENTS })

			// Made before the edits: it follows them.
			expect(session.reviewIndex.size).toBeGreaterThan(0)

			for (let step = 0; step < 60; step++) {
				const positions = textPositions(session)
				const at = positions[Math.floor(random() * positions.length)] ?? 1
				const choice = random()
				const state = session.state

				if (choice < 0.4) {
					session.dispatch(state.tr.insertText(random() < 0.5 ? "w" : "word ", at))
				} else if (choice < 0.7) {
					const to = Math.min(state.doc.content.size - 1, at + 1 + Math.floor(random() * 12))

					session.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at, to)).deleteSelection())
				} else if (choice < 0.85) {
					session.dispatch(state.tr.split(at))
				} else if (choice < 0.95) {
					session.execute({ type: "history.undo" })
				} else {
					session.execute({ type: "history.redo" })
				}

				expectFresh(session)
			}
		}
	})

	it("follows the story's end markers, row and cell revisions, the document's attributes and node marks", async () => {
		const comment = '<w:comment w:id="1" w:author="A"><w:p><w:r><w:t>c</w:t></w:r></w:p></w:comment>'
		// Markers after the last paragraph: typing in it reads its region again up to the story's end.
		const ending = await sessionOf({
			body: `<w:p>${run("first")}</w:p><w:p><w:commentRangeStart w:id="1"/>${run("last para")}</w:p><w:commentRangeEnd w:id="1"/>`,
			comments: comment
		})

		expect(ending.state.doc.attrs["end"]).toHaveLength(1)
		expect(ending.reviewIndex.size).toBe(2)

		for (const text of ["x", "y"]) ending.dispatch(ending.state.tr.insertText(text, ending.state.doc.content.size - 2))

		expect(ending.reviewIndex.size).toBe(2)
		expectFresh(ending)

		// A row's revision bits.
		const table = await sessionOf({
			body: `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:p>${run("a")}</w:p></w:tc></w:tr><w:tr><w:tc><w:p>${run("b")}</w:p></w:tc></w:tr></w:tbl><w:p/>`
		})
		let row = -1
		let cell = -1

		table.state.doc.descendants((node, pos) => {
			if (node.type === docxSchema.nodes.table_row && row < 0) row = pos
			if (node.type === docxSchema.nodes.table_cell) cell = pos
		})
		expect(table.reviewIndex.size).toBe(0)
		expect(table.dispatch(markInternal(table.state.tr.step(new AttrStep(row, "revision", 1))))).toBe(true)
		expect(table.dispatch(markInternal(table.state.tr.step(new AttrStep(cell, "revision", 2))))).toBe(true)
		expect(table.reviewIndex.size).toBe(2)
		expectFresh(table)

		// The story's own end markers changed.
		const attrs = await sessionOf({ body: `<w:p>${run("a")}</w:p>`, comments: comment })

		expect(attrs.reviewIndex.commentCount).toBe(0)
		expect(
			attrs.dispatch(
				markInternal(attrs.state.tr.step(new DocAttrStep("end", [{ src: -1, kind: "commentRangeEnd", id: "1", name: null }])))
			)
		).toBe(true)
		expect(attrs.reviewIndex.commentCount).toBe(1)
		expectFresh(attrs)

		// A paragraph's tracked property change, and its undo.
		const marked = await sessionOf({ body: `<w:p>${run("a")}</w:p><w:p>${run("b")}</w:p>` })

		expect(marked.reviewIndex.size).toBe(0)
		expect(
			marked.dispatch(
				markCommand(marked.state.tr.step(new AddNodeMarkStep(0, docxSchema.marks.paragraph_change.create({ value: { x: 1 } }))))
			)
		).toBe(true)
		expect(marked.reviewIndex.revisionCount).toBe(1)
		expectFresh(marked)
		marked.execute({ type: "history.undo" })
		expect(marked.reviewIndex.size).toBe(0)
		expectFresh(marked)
	})
})
