import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync } from "fflate"
import type { Node } from "prosemirror-model"
import { AllSelection, TextSelection } from "prosemirror-state"
import { ReplaceStep, type Step } from "prosemirror-transform"
import { describe, expect, it } from "vitest"
import { Revision, RevisionFlag, type StoryPart } from "@filen/office/core/docx"
import { DocxEditorSession, docxSchema, type DocxEditContext } from "@filen/office/core/docx/edit"
import { DocxSaveError, prepareDocxSave, saveDocx } from "@filen/office/core/docx/write"
import { parseXml } from "@filen/office/core/xml"
import { isRemarking, markCommand, markInternal } from "../core/docx/edit/invariants/core"
import { DocxVerifyError } from "../core/docx/write/failure"
import type { CheckInput } from "../core/docx/write/checks/index"
import { revisionChecks } from "../core/docx/write/checks/revisions"
import { resolveChanges, storyReviewIndex } from "../core/docx/review/accept"
import { ReviewKind } from "../core/docx/review/index"
import { parseReviewCommand } from "../core/docx/edit/commands/review"
import { flushComposition, minuteDate, paragraphChange, setParagraphChange } from "../core/docx/review/track"
import { CORPUS_DIR } from "./corpusDir"
import { openBytes, openSpec, type Opened } from "./docxEditFixtures"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"
import { bytesSource } from "@filen/office/core/opc"
import type { TextMeasurer } from "@filen/office/core/text"
import { inThreadEditingHost } from "@filen/office/dom/docx/editing"

// Recording tracked changes, accepting and rejecting them, and what a save writes of them.

const marks = docxSchema.marks
const NOW = Date.UTC(2026, 9, 12, 13, 25, 41)
const DATE = minuteDate(NOW)
const pr = (content: string, pPr = ""): string => `<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}${content}</w:p>`
const run = (text: string, rPr = ""): string =>
	`<w:r>${rPr === "" ? "" : `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`

interface Tracked extends Opened {
	readonly session: DocxEditorSession
}

async function tracked(spec: SyntheticDocx, author = "Ann"): Promise<Tracked> {
	const opened = await openSpec(spec)

	setIdentity(opened.context, author)
	opened.context.review.tracking = true

	return { ...opened, session: new DocxEditorSession(opened.context) }
}

function setIdentity(context: DocxEditContext, author: string | undefined): void {
	context.identity.author = author
	context.identity.now = () => NOW
}

function select(session: DocxEditorSession, from: number, to = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

function paragraphs(doc: Node): Node[] {
	const out: Node[] = []

	doc.descendants(node => {
		if (node.type === docxSchema.nodes.paragraph) out.push(node)

		return node.type !== docxSchema.nodes.paragraph
	})

	return out
}

// Text of a paragraph with its revision marks: [+inserted+], [-deleted-], [~formatted~].
function shown(paragraph: Node): string {
	let out = ""

	paragraph.forEach(child => {
		const text = child.isText ? (child.text ?? "") : `<${child.type.name}>`
		const ins = marks.insertion.isInSet(child.marks) !== undefined
		const del = marks.deletion.isInSet(child.marks) !== undefined
		const fmt = marks.format_change.isInSet(child.marks) !== undefined

		out += ins ? `[+${text}+]` : del ? `[-${text}-]` : fmt ? `[~${text}~]` : text
	})

	return out
		.replace(/\+\]\[\+/g, "")
		.replace(/-\]\[-/g, "")
		.replace(/~\]\[~/g, "")
}

function texts(session: DocxEditorSession): string[] {
	return paragraphs(session.state.doc).map(shown)
}

async function save(
	opened: Opened,
	sessions: readonly DocxEditorSession[]
): Promise<{ bytes: Uint8Array; xml: string; part: (name: string) => string }> {
	const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions })

	if (result.bytes === undefined) throw new Error("no bytes")

	const files = unzipSync(result.bytes)
	const part = (name: string): string => new TextDecoder().decode(files[name] ?? new Uint8Array())

	return { bytes: result.bytes, xml: part("word/document.xml"), part }
}

async function reopened(bytes: Uint8Array): Promise<DocxEditorSession> {
	const opened = await openBytes(bytes)

	return new DocxEditorSession(opened.context)
}

describe("docx tracked changes: recording", () => {
	it("records typing as one insertion of its author and minute, and writes it", async () => {
		const doc = await tracked({ body: p("one two") })
		const session = doc.session

		select(session, 4)
		session.dispatch(session.state.tr.insertText(" a"))
		session.dispatch(session.state.tr.insertText("b"))
		expect(texts(session)).toEqual(["one[+ ab+] two"])

		const mark = marks.insertion.isInSet(session.state.doc.nodeAt(5)?.marks ?? [])

		expect(mark?.attrs).toMatchObject({ src: -1, id: expect.any(Number), author: "Ann", date: DATE })
		expect(session.snapshot().review).toMatchObject({ tracking: true, authorNeeded: false, revisionCount: 1 })

		const { xml, bytes } = await save(doc, [session])

		expect(xml).toMatch(
			new RegExp(`<w:ins w:id="\\d+" w:author="Ann" w:date="${DATE}"><w:r><w:t xml:space="preserve"> ab</w:t></w:r></w:ins>`)
		)
		expect(texts(await reopened(bytes))).toEqual(["one[+ ab+] two"])
	})

	it("keeps deleted text marked, deletes the author's own insertions, and puts the caret where Word does", async () => {
		const doc = await tracked({ body: p("one two three") })
		const session = doc.session

		// Backspace over "o" of "two": the caret goes before it.
		select(session, 7)
		session.dispatch(session.state.tr.delete(6, 7))
		expect(texts(session)).toEqual(["one t[-w-]o three"])
		expect(session.state.selection.head).toBe(6)

		// Backspace again skips nothing: "t" is deleted next.
		session.dispatch(session.state.tr.delete(5, 6))
		expect(texts(session)).toEqual(["one [-tw-]o three"])
		expect(session.state.selection.head).toBe(5)

		// Delete (forward) at "o" after the deleted text: the caret goes after it.
		select(session, 7)
		session.dispatch(session.state.tr.delete(7, 8))
		expect(texts(session)).toEqual(["one [-two-] three"])
		expect(session.state.selection.head).toBe(8)

		// Delete over deleted text deletes the character beyond it.
		select(session, 5)
		session.dispatch(session.state.tr.delete(5, 6))
		expect(texts(session)).toEqual(["one [-two-][- -]three"].map(text => text.replace("-][-", "")))

		// Typing, then deleting part of it: gone for real.
		select(session, 1)
		session.dispatch(session.state.tr.insertText("xyz"))
		expect(texts(session)[0]).toMatch(/^\[\+xyz\+\]one/)
		select(session, 3)
		session.dispatch(session.state.tr.delete(2, 3))
		expect(texts(session)[0]).toMatch(/^\[\+xz\+\]one/)
	})

	it("puts what replaces a selection after the deleted text", async () => {
		const doc = await tracked({ body: p("one two three") })
		const session = doc.session

		select(session, 5, 8)
		session.dispatch(session.state.tr.insertText("2"))
		expect(texts(session)).toEqual(["one [-two-][+2+] three"])
		expect(session.state.selection.head).toBe(9)

		const { xml } = await save(doc, [session])

		expect(xml).toContain("<w:delText>two</w:delText>")
	})

	it("flags paragraph marks: a split's mark is inserted, a join deletes the mark, the author's own split joins for real", async () => {
		const doc = await tracked({ body: p("one two") + p("three") })
		const session = doc.session

		// Enter after "one".
		session.dispatch(session.state.tr.split(4))

		const [first, second] = paragraphs(session.state.doc)

		expect(((first?.attrs["revision"] as number) & RevisionFlag.Inserted) !== 0).toBe(true)
		expect(paragraphChange(first as Node)?.inserted).toMatchObject({ author: "Ann", date: DATE })
		expect(second?.attrs["revision"]).toBe(0)

		// Backspace at the start of " two": the author's own mark goes.
		select(session, 6)
		session.dispatch(session.state.tr.join(5))
		expect(texts(session)).toEqual(["one two", "three"])
		expect(paragraphs(session.state.doc)[0]?.attrs["revision"]).toBe(0)

		// Backspace at the start of "three": that mark is the source's, so it is flagged deleted.
		const start = (paragraphs(session.state.doc)[0]?.nodeSize ?? 0) + 1

		select(session, start)
		session.dispatch(session.state.tr.join(start - 1))
		expect(paragraphs(session.state.doc)).toHaveLength(2)
		expect(((paragraphs(session.state.doc)[0]?.attrs["revision"] as number) & RevisionFlag.Deleted) !== 0).toBe(true)
		expect(session.state.selection.head).toBe(start - 2)

		const { xml, bytes } = await save(doc, [session])

		expect(xml).toMatch(/<w:pPr><w:rPr><w:del w:id="\d+" w:author="Ann" w:date="[^"]+"\/><\/w:rPr><\/w:pPr>/)

		const again = await reopened(bytes)

		expect(((paragraphs(again.state.doc)[0]?.attrs["revision"] as number) & RevisionFlag.Deleted) !== 0).toBe(true)
	})

	it("records formatting with the properties before, and drops the change when they come back", async () => {
		const doc = await tracked({ body: pr(run("plain words", "<w:i/>")) })
		const session = doc.session

		select(session, 1, 6)
		session.execute({ type: "format.bold" })
		expect(texts(session)).toEqual(["[~plain~] words"])

		const { xml, bytes } = await save(doc, [session])

		expect(xml).toMatch(
			/<w:rPr><w:b\/><w:bCs\/><w:i\/><w:rPrChange w:id="\d+" w:author="Ann" w:date="[^"]+"><w:rPr><w:i\/><\/w:rPr><\/w:rPrChange><\/w:rPr>/
		)
		expect(texts(await reopened(bytes))).toEqual(["[~plain~] words"])

		session.execute({ type: "format.bold" })
		expect(texts(session)).toEqual(["plain words"])
	})

	it("records w:rPrChange after the run's w14 properties, as the last of its properties", async () => {
		const doc = await tracked({ body: pr(run("Ligatures here", '<w:sz w:val="24"/><w14:ligatures w14:val="standardContextual"/>')) })
		const session = doc.session

		select(session, 1, 10)
		session.execute({ type: "format.bold" })

		const { xml } = await save(doc, [session])

		expect(xml).toContain("w:rPrChange")
		expect(xml).not.toMatch(/<\/w:rPrChange><w14:/)
		expect(xml).toMatch(/<w14:ligatures w14:val="standardContextual"\/><w:rPrChange /)
	})

	it("records a paragraph property change as w:pPrChange with the properties before", async () => {
		const doc = await tracked({ body: p("centred", '<w:jc w:val="center"/>') })
		const session = doc.session

		select(session, 2)
		session.execute({ type: "align.end" })

		const change = paragraphChange(session.state.doc.child(0))

		expect(change?.props?.before.align).toBe("center")

		const { xml } = await save(doc, [session])

		expect(xml).toMatch(
			/<w:pPr><w:jc w:val="right"\/><w:pPrChange w:id="\d+" w:author="Ann" w:date="[^"]+"><w:pPr><w:jc w:val="center"\/><\/w:pPr><\/w:pPrChange><\/w:pPr>/
		)
	})

	it("waits for the author's name, and records nothing while tracking is off", async () => {
		const doc = await tracked({ body: p("one") }, "")
		const session = doc.session

		expect(session.snapshot().review).toMatchObject({ tracking: true, authorNeeded: true })
		expect(session.dispatch(session.state.tr.insertText("x", 2))).toBe(false)
		expect(texts(session)).toEqual(["one"])

		setIdentity(doc.context, "Ann")
		expect(session.dispatch(session.state.tr.insertText("x", 2))).toBe(true)
		expect(texts(session)).toEqual(["o[+x+]ne"])

		doc.context.review.tracking = false
		session.dispatch(session.state.tr.insertText("y", 2))
		expect(texts(session)).toEqual(["oy[+x+]ne"])
	})

	it("turns tracking on for documents whose settings track revisions", async () => {
		const opened = await openSpec({ body: p("one"), settings: "<w:trackRevisions/>" })

		expect(opened.context.review.tracking).toBe(true)
		setIdentity(opened.context, "Ann")

		const session = new DocxEditorSession(opened.context)

		session.dispatch(session.state.tr.insertText("x", 2))
		expect(texts(session)).toEqual(["o[+x+]ne"])
	})

	it("undoes a tracked edit with its marks in one step", async () => {
		const doc = await tracked({ body: p("one two") })
		const session = doc.session

		session.dispatch(session.state.tr.delete(2, 4))
		expect(texts(session)).toEqual(["o[-ne-] two"])
		session.execute({ type: "history.undo" })
		expect(texts(session)).toEqual(["one two"])
		session.execute({ type: "history.redo" })
		expect(texts(session)).toEqual(["o[-ne-] two"])
	})

	it("marks what an IME composed once the composition ends", async () => {
		const doc = await tracked({ body: p("one") })
		const session = doc.session

		session.dispatch(session.state.tr.insertText("か", 2).setMeta("composition", 1))
		session.dispatch(session.state.tr.insertText("な", 3).setMeta("composition", 1))
		expect(texts(session)).toEqual(["oかなne"])
		expect(flushComposition(session)).toBe(true)
		expect(texts(session)).toEqual(["o[+かな+]ne"])

		// Or with the next edit.
		session.dispatch(session.state.tr.insertText("き", 5).setMeta("composition", 2))
		session.dispatch(session.state.tr.insertText("!", 6))
		expect(texts(session)).toEqual(["o[+かな+]n[+き!+]e"])
	})
})

describe("docx tracked changes: one id per change", () => {
	it("gives each change an id of its own, keeps it while the change grows, and resolves exactly that change", async () => {
		const doc = await tracked({ body: p("one two three four") })
		const session = doc.session

		// Two insertions of the same author in the same minute, apart: two changes.
		session.dispatch(session.state.tr.insertText("A", 4))
		session.dispatch(session.state.tr.insertText("B", 5))
		session.dispatch(session.state.tr.insertText("Z", 15))
		// A deletion and the Backspace before it: one change.
		select(session, 10)
		session.dispatch(session.state.tr.delete(9, 10))
		session.dispatch(session.state.tr.delete(8, 9))
		expect(texts(session)).toEqual(["one[+AB+] t[-wo-] thre[+Z+]e four"])

		const index = storyReviewIndex(session)
		const ids = index.entries().map(entry => entry.id)

		expect(index.revisionCount).toBe(3)
		expect(new Set(ids).size).toBe(3)

		// The snapshot names the change at the caret; next and previous move between them.
		select(session, 5)
		expect(session.snapshot().review.current).toBe(ids[0])
		select(session, 16)
		expect(session.snapshot().review.current).toBe(ids[2])
		select(session, 1)
		expect(session.snapshot().review.current).toBeNull()

		// Rejecting the one at the caret leaves the other insertion of the same minute.
		select(session, 5)
		session.dispatch(resolveChanges(session, storyReviewIndex(session), { from: 5, to: 5 }, false).tr as never)
		expect(texts(session)).toEqual(["one t[-wo-] thre[+Z+]e four"])

		// By id: only that one.
		session.dispatch(resolveChanges(session, storyReviewIndex(session), { id: ids[1] as string }, false).tr as never)
		expect(texts(session)).toEqual(["one two thre[+Z+]e four"])
		expect(
			storyReviewIndex(session)
				.entries()
				.map(entry => entry.id)
		).toEqual([ids[2]])
	})

	it("moves the paged editor between changes by their ids", async () => {
		const bytes = buildDocx({ body: p("one two three four") })
		const { editor, context } = await pagedEditor(bytes)

		setIdentity(context, "Ann")
		expect(editor.execute({ type: "review.track", on: true })).toBe(true)
		editor.dispatch(editor.state.tr.insertText("A", 4))
		editor.dispatch(editor.state.tr.insertText("Z", 15))
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)))
		await settleAll(editor)

		const seen: (string | null)[] = []

		for (let k = 0; k < 3; k++) {
			expect(editor.execute({ type: "review.next" })).toBe(true)
			seen.push(editor.snapshot().review.current)
		}

		expect(seen[0]).not.toBeNull()
		expect(seen[1]).not.toBe(seen[0])
		expect(seen[2]).toBe(seen[0])
		expect(editor.execute({ type: "review.accept", id: seen[1] as string })).toBe(true)
		expect(editor.snapshot().review.revisionCount).toBe(1)
		editor.dispose()
	})
})

describe("docx tracked changes: accepting and rejecting", () => {
	const SOURCE: SyntheticDocx = {
		body:
			pr(
				`${run("Kept ")}<w:ins w:id="10" w:author="Bob" w:date="2026-01-01T00:00:00Z">${run("inserted")}</w:ins>${run(" and ")}<w:del w:id="11" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>deleted</w:delText></w:r></w:del>${run(" end.")}`
			) +
			`<w:p><w:pPr><w:rPr><w:ins w:id="12" w:author="Bob" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr>${run("Inserted mark")}</w:p>` +
			pr(run("Next")) +
			pr(run("bold", '<w:b/><w:rPrChange w:id="13" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:rPr/></w:rPrChange>')) +
			`<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="14" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:pPr><w:jc w:val="right"/></w:pPr></w:pPrChange></w:pPr>${run("Centred")}</w:p>`
	}

	it("keeps a bookmark that ends in a deleted table in order once the deletion is accepted", async () => {
		const del = (text: string): string =>
			`<w:del w:id="2${String(text.length)}" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>${text}</w:delText></w:r></w:del>`
		// Enough changes besides for one rebuild of the story.
		const many = Array.from({ length: 70 }, (_, k) => pr(`${run(`Line ${String(k)} `)}${del("x")}`)).join("")
		const doc = await tracked({
			body:
				many +
				pr(`${run("Kept ")}${del("gone ")}<w:bookmarkStart w:id="3" w:name="Spans"/>${del("and more")}`) +
				'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>' +
				'<w:tr><w:trPr><w:del w:id="40" w:author="Bob" w:date="2026-01-01T00:00:00Z"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>' +
				`${pr(`${del("cell")}<w:bookmarkEnd w:id="3"/>${del("text")}`)}</w:tc></w:tr></w:tbl>` +
				pr(run("After"))
		})
		const session = doc.session

		const outcome = resolveChanges(session, storyReviewIndex(session), { all: true }, true)

		expect(outcome.tr).not.toBeNull()
		session.dispatch(outcome.tr as never)

		const { xml } = await save(doc, [session])
		const start = xml.indexOf('<w:bookmarkStart w:id="3"')
		const end = xml.indexOf('<w:bookmarkEnd w:id="3"/>')

		expect(xml).not.toContain("<w:tbl>")
		expect(start).toBeGreaterThan(0)
		expect(end).toBeGreaterThan(start)
	})

	it("accepts every change of a source", async () => {
		const doc = await tracked(SOURCE)
		const session = doc.session
		const index = storyReviewIndex(session)

		expect(index.revisionCount).toBe(5)

		const outcome = resolveChanges(session, index, { all: true }, true)

		expect(outcome.skipped).toBe(0)
		expect(outcome.tr).not.toBeNull()
		session.dispatch(outcome.tr as never)
		expect(texts(session)).toEqual(["Kept inserted and  end.", "Inserted mark", "Next", "bold", "Centred"])
		expect(storyReviewIndex(session).revisionCount).toBe(0)

		const { xml, bytes } = await save(doc, [session])

		expect(xml).not.toMatch(/<w:(ins|del|rPrChange|pPrChange)\b/)
		expect(xml).toContain('<w:jc w:val="center"/>')
		expect(xml).toContain("<w:b/>")
		expect(storyReviewIndex(await reopened(bytes)).revisionCount).toBe(0)
	})

	it("accepts and rejects tracked cell deletions and insertions", async () => {
		const cell = (text: string, tcPr = ""): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${tcPr}</w:tcPr>${p(text)}</w:tc>`
		const row = (cells: readonly string[]): string => `<w:tr>${cells.join("")}</w:tr>`
		const del = '<w:cellDel w:id="7" w:author="Bo" w:date="2020-01-01T00:00:00Z"/>'
		const ins = '<w:cellIns w:id="8" w:author="Bo" w:date="2020-01-01T00:00:00Z"/>'
		const table =
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
			row([cell("a1"), cell("b1", del), cell("c1", ins)]) +
			row([cell("a2"), cell("b2"), cell("c2")]) +
			"</w:tbl>"
		const shape = (session: DocxEditorSession): string[] => {
			const out: string[] = []

			session.state.doc.descendants(node => {
				if (node.type !== docxSchema.nodes.table_row) return true

				out.push(
					Array.from({ length: node.childCount }, (_, k) => {
						const child = node.child(k)

						return `${child.textContent}:${String(child.attrs["revision"])}`
					}).join(" ")
				)

				return false
			})

			return out
		}

		for (const accept of [true, false]) {
			const doc = await tracked({ body: table + p("after") })
			const session = doc.session
			const outcome = resolveChanges(session, storyReviewIndex(session), { all: true }, accept)

			expect(outcome.skipped).toBe(0)
			expect(outcome.resolved).toBe(2)
			session.dispatch(outcome.tr as never)
			// Accept: the deleted cell goes, the inserted one stays; reject: the other way round.
			expect(shape(session)).toEqual([accept ? "a1:0 c1:0" : "a1:0 b1:0", "a2:0 b2:0 c2:0"])

			const { xml } = await save(doc, [session])

			expect(xml).not.toMatch(/<w:cell(Ins|Del)\b/)
		}
	})

	it("rejects every change of a source", async () => {
		const doc = await tracked(SOURCE)
		const session = doc.session
		const outcome = resolveChanges(session, storyReviewIndex(session), { all: true }, false)

		session.dispatch(outcome.tr as never)
		expect(texts(session)).toEqual(["Kept  and deleted end.", "Inserted markNext", "bold", "Centred"])

		const { xml } = await save(doc, [session])

		expect(xml).not.toMatch(/<w:(ins|del|rPrChange|pPrChange)\b/)
		expect(xml).toContain('<w:jc w:val="right"/>')
		expect(xml).not.toContain("<w:b/>")
	})

	it("resolves the change at the caret and by id", async () => {
		const doc = await tracked(SOURCE)
		const session = doc.session

		session.dispatch(resolveChanges(session, storyReviewIndex(session), { from: 8, to: 8 }, true).tr as never)
		expect(texts(session)[0]).toBe("Kept inserted and [-deleted-] end.")
		session.dispatch(resolveChanges(session, storyReviewIndex(session), { id: "11" }, false).tr as never)
		expect(texts(session)[0]).toBe("Kept inserted and deleted end.")
	})

	it("takes tracked edits back with reject all, and accept all gives the untracked edit", async () => {
		const spec: SyntheticDocx = { body: pr(run("alpha beta gamma")) + pr(run("delta")) + pr(run("epsilon", "<w:i/>")) }
		// From the end back, so the positions hold whether deleted text stays or not.
		const edit = (session: DocxEditorSession): void => {
			select(session, session.state.doc.content.size - 4, session.state.doc.content.size - 2)
			session.execute({ type: "format.bold" })
			select(session, 20)
			session.execute({ type: "align.center" })
			session.dispatch(session.state.tr.split(14))
			session.dispatch(session.state.tr.insertText("NEW ", 7))
			session.dispatch(session.state.tr.delete(2, 4))
		}
		const plain = await openSpec(spec)

		setIdentity(plain.context, "Ann")

		const untracked = new DocxEditorSession(plain.context)

		edit(untracked)

		const rejected = await tracked(spec)
		const original = rejected.session.state.doc

		edit(rejected.session)
		rejected.session.dispatch(resolveChanges(rejected.session, storyReviewIndex(rejected.session), { all: true }, false).tr as never)
		expect(rejected.session.state.doc.eq(original)).toBe(true)

		const accepted = await tracked(spec)

		edit(accepted.session)
		accepted.session.dispatch(resolveChanges(accepted.session, storyReviewIndex(accepted.session), { all: true }, true).tr as never)
		expect(texts(accepted.session)).toEqual(texts(untracked))

		const { xml } = await save(rejected, [rejected.session])

		expect(xml).not.toMatch(/<w:(ins|del|rPrChange|pPrChange)\b/)
	})
})

describe("docx tracked changes: paragraph marks, large edits and moves", () => {
	it("keeps a paragraph mark's revision with the content that ends with it when it is split and joined", async () => {
		const doc = await tracked({
			body:
				`<w:p><w:pPr><w:rPr><w:ins w:id="5" w:author="Bob" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr>${run("Inserted mark")}</w:p>` +
				p("After")
		})
		const session = doc.session

		// Enter inside: the first half ends with a new (Ann's) mark, the second keeps Bob's.
		session.dispatch(session.state.tr.split(5))

		const [first, second] = paragraphs(session.state.doc)

		expect(paragraphChange(first as Node)?.inserted?.author).toBe("Ann")
		// The source's own element goes with it (written with a new w:id: a copy may hold it where it was).
		expect(paragraphChange(second as Node)?.inserted).toMatchObject({ author: "Bob", date: "2026-01-01T00:00:00Z", id: 5 })

		const { xml } = await save(doc, [session])

		expect([...xml.matchAll(/<w:rPr><w:ins w:id="\d+" w:author="(\w+)"/g)].map(match => match[1])).toEqual(["Ann", "Bob"])

		// Backspace takes Ann's mark back: Bob's stays on the joined paragraph.
		select(session, 7)
		session.dispatch(session.state.tr.join(6))
		expect(paragraphs(session.state.doc)).toHaveLength(2)
		expect(paragraphChange(paragraphs(session.state.doc)[0] as Node)?.inserted?.author).toBe("Bob")
	})

	it("writes a source paragraph mark revision that moved to a copy with an id of its own", async () => {
		const deleted = `<w:p><w:pPr><w:rPr><w:del w:id="134" w:author="Bob"/></w:rPr></w:pPr>${run("Tracked")}</w:p>`
		const opened = await openSpec({ body: deleted + pr(run("Last")) })
		const session = new DocxEditorSession(opened.context)
		const original = session.state.doc.child(0)
		const revisions = session.story.part.revisions
		let element = -1

		for (let k = 0; k < revisions.count; k++) {
			if (revisions.item[k] === original.attrs["src"] && revisions.kind[k] === Revision.ParagraphMarkDeletion)
				element = revisions.node[k] ?? -1
		}

		// What a split of a pasted copy of the paragraph leaves (the copy's half ending with the copied mark takes
		// the source's revision as a stamp) while the original still holds it.
		const end = session.state.doc.content.size
		const copy = original.type.create(original.attrs, original.content)
		const tr = session.state.tr.insert(end, copy)

		setParagraphChange(tr, end, copy, { deleted: { author: "Bob", date: "", id: 134, element } })
		expect(session.dispatch(markInternal(tr))).toBe(true)

		const { xml } = await save(opened, [session])
		const ids = [...xml.matchAll(/<w:del [^>]*>/g)].map(match => /w:id="(\d+)"/.exec(match[0])?.[1])

		expect(element).toBeGreaterThanOrEqual(0)
		expect(ids.length).toBe(2)
		expect(new Set(ids).size).toBe(2)
	})

	it("keeps a source paragraph's tracked mark and property change where it is when a copy is pasted before it", async () => {
		const tracked = `<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="3" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:pPr/></w:pPrChange><w:rPr><w:del w:id="4" w:author="Bob" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr>${run("Tracked")}</w:p>`
		const opened = await openSpec({ body: pr(run("First paragraph")) + tracked + pr(run("Last")) })
		const session = new DocxEditorSession(opened.context)
		const doc = session.state.doc
		const start = doc.child(0).nodeSize
		// A raw copy (the same node, no paste sanitising) of the whole tracked paragraph, into the first one: the
		// copy comes before the original.
		session.dispatch(session.state.tr.replaceRange(4, 4, doc.slice(start, start + doc.child(1).nodeSize)))

		const { xml } = await save(opened, [session])
		const body = xml.slice(xml.indexOf("<w:body>"))
		const copy = body.indexOf("Tracked")
		const original = body.lastIndexOf("Tracked")

		// The original keeps both (with ids of their own now); the copy pasted in ends with a new mark.
		expect(copy).toBeLessThan(original)
		expect([...body.matchAll(/<w:pPrChange /g)]).toHaveLength(1)
		expect([...body.matchAll(/<w:rPr><w:del /g)]).toHaveLength(1)
		expect(body.indexOf("<w:pPrChange ")).toBeGreaterThan(copy)
		expect(body.indexOf("<w:rPr><w:del ")).toBeGreaterThan(copy)
	})

	it("records a large paste and a large deletion in one step each, and saves them", async () => {
		const body = Array.from({ length: 120 }, (_, k) => p(`Paragraph ${String(k)} with some words in it`)).join("")
		const doc = await tracked({ body })
		const session = doc.session
		const size = session.state.doc.content.size
		const slice = session.state.doc.slice(0, Math.floor(size / 2))

		session.dispatch(session.state.tr.replaceRange(size - 1, size - 1, slice))

		const pasted = paragraphs(session.state.doc).filter(node => shown(node).startsWith("[+")).length

		expect(pasted).toBeGreaterThan(50)

		// Select most of the original and delete it: marked, not removed.
		select(session, 3, Math.floor(size / 2) + 40)

		const before = session.state.doc.content.size

		session.dispatch(session.state.tr.deleteSelection())
		expect(session.state.doc.content.size).toBe(before)
		expect(paragraphs(session.state.doc).filter(node => shown(node).includes("[-")).length).toBeGreaterThan(50)

		const { bytes } = await save(doc, [session])
		const again = await reopened(bytes)

		expect(texts(again)).toEqual(texts(session))

		session.execute({ type: "history.undo" })
		session.execute({ type: "history.undo" })
		expect(texts(session)).toEqual(paragraphs((await tracked({ body })).session.state.doc).map(shown))
	})

	it.skipIf(!existsSync(join(CORPUS_DIR, "docx", "oxpt__RP027-Change-Section.docx")))(
		"accepts and rejects section property changes as section edits",
		async () => {
			for (const accept of [true, false]) {
				const opened = await openBytes(new Uint8Array(readFileSync(join(CORPUS_DIR, "docx", "oxpt__RP027-Change-Section.docx"))))
				const session = new DocxEditorSession(opened.context)
				const outcome = resolveChanges(session, storyReviewIndex(session), { all: true }, accept)

				expect(outcome.skipped).toBe(0)
				expect(outcome.resolved).toBeGreaterThan(0)

				if (outcome.tr !== null) session.dispatch(outcome.tr)

				expect((await save(opened, [session])).xml).not.toContain("sectPrChange")
			}
		}
	)

	it.skipIf(!existsSync(join(CORPUS_DIR, "docx", "oxpt__RP015-MoveFrom-MoveTo.docx")))(
		"accepts and rejects a move as a pair, with its range markers",
		async () => {
			for (const accept of [true, false]) {
				const opened = await openBytes(new Uint8Array(readFileSync(join(CORPUS_DIR, "docx", "oxpt__RP015-MoveFrom-MoveTo.docx"))))
				const session = new DocxEditorSession(opened.context)
				let at = -1

				session.state.doc.descendants((node, pos) => {
					if (at < 0 && node.isText && marks.move_from.isInSet(node.marks) !== undefined) at = pos + 1

					return at < 0
				})

				expect(at).toBeGreaterThan(0)

				const outcome = resolveChanges(session, storyReviewIndex(session), { from: at, to: at }, accept)

				session.dispatch(outcome.tr as never)

				let moves = 0
				let rangeMarkers = 0

				session.state.doc.descendants(node => {
					if (marks.move_from.isInSet(node.marks) !== undefined || marks.move_to.isInSet(node.marks) !== undefined) moves++
					if (node.type === docxSchema.nodes.marker && String(node.attrs["kind"]).startsWith("move")) rangeMarkers++

					return true
				})

				expect(moves).toBe(0)
				expect(rangeMarkers).toBe(0)
				await expect(save(opened, [session])).resolves.toBeDefined()
			}
		}
	)
})

describe("docx tracked changes: commands and settings", () => {
	it("switches tracking, persists it in settings.xml and keeps the snapshot current", async () => {
		const bytes = buildDocx({ body: p("one two"), settings: '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>' })
		const { editor, pkg, context } = await pagedEditor(bytes)

		expect(editor.snapshot().enabled["review.track"]).toBe(true)
		// No author yet: the app asks first.
		expect(editor.execute({ type: "review.track", on: true })).toBe(false)
		setIdentity(context, "Ann")
		expect(editor.execute({ type: "review.track" })).toBe(true)
		expect(editor.snapshot().review.tracking).toBe(true)

		editor.dispatch(editor.state.tr.insertText("x", 2))
		await settleAll(editor)
		expect(editor.snapshot().review.revisionCount).toBe(1)
		expect(editor.snapshot().enabled["review.acceptAll"]).toBe(true)

		const result = await saveDocx({ pkg, context, sessions: editor.sessions })
		const settings = new TextDecoder().decode(unzipSync(result.bytes as Uint8Array)["word/settings.xml"])

		expect(settings).toContain('<w:zoom w:percent="100"/><w:trackRevisions/><w:defaultTabStop w:val="720"/>')
		expect(editor.execute({ type: "review.next" })).toBe(true)
		expect(editor.state.selection.from).toBe(2)
		expect(editor.execute({ type: "review.reject" })).toBe(true)
		expect(editor.state.doc.textContent).toBe("one two")
		expect(editor.execute({ type: "review.track", on: false })).toBe(true)

		const off = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(off.changedParts).not.toContain("word/settings.xml")
		editor.dispose()
	})

	it("keeps the review snapshot while typing goes on in one change, and reports what accepting left", async () => {
		const doc = await tracked({
			body:
				pr(run("one two")) +
				p("end") +
				`<w:p><w:pPr><w:rPr><w:del w:id="4" w:author="Bob" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr>${run("last")}</w:p>`
		})
		const session = doc.session

		session.dispatch(session.state.tr.insertText("x", 2))

		const first = session.snapshot().review

		session.dispatch(session.state.tr.insertText("y", 3))
		expect(session.snapshot().review).toBe(first)
		expect(first).toMatchObject({ tracking: true, revisionCount: 2, skipped: 0 })

		// A deleted mark with no paragraph after it cannot join: accepting leaves it.
		session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, true).tr as never)
		expect(session.snapshot().review).toMatchObject({ revisionCount: 1, skipped: 1 })
		expect(texts(session)).toEqual(["oxyne two", "end", "last"])
	})

	it("accepts and rejects what tracking recorded with no snapshot made, after tracking went off", async () => {
		const bytes = buildDocx({ body: p("Alpha beta") + p("Second") })

		for (const what of ["typing", "pageSetup", "break"] as const) {
			for (const accept of [true, false]) {
				const { editor, context } = await pagedEditor(bytes)
				const session = editor.body.session

				context.identity.author = "Ann"
				context.review.tracking = true
				session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 6)))

				if (what === "typing") session.dispatch(session.state.tr.insertText("XYZ"))
				else if (what === "pageSetup") expect(await editor.execute({ type: "page.setup", margins: { left: 3000 } })).toBe(true)
				else expect(await editor.execute({ type: "insert.sectionBreak", kind: "nextPage" })).toBe(true)

				context.review.tracking = false
				expect(await editor.execute({ type: accept ? "review.acceptAll" : "review.rejectAll" }), what).toBe(true)
				expect(storyReviewIndex(session).revisionCount).toBe(0)
				editor.dispose()
			}
		}
	})

	it("switches the markup view in place", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("one") }))

		expect(editor.execute({ type: "view.markup", mode: "all" })).toBe(true)
		expect(editor.view).toBe(0)
		expect(editor.execute({ type: "view.markup", mode: "original" })).toBe(true)
		expect(editor.view).toBe(2)
		editor.dispose()
	})
})

describe("docx tracked changes: gate 2", () => {
	const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
	const check = (body: string, sourceIds: readonly string[] = []): unknown => {
		const input = { source: (key: string) => (sourceIds.includes(key) ? 1 : 0) } as unknown as CheckInput
		const part = {
			name: "word/document.xml",
			part: {} as StoryPart,
			document: parseXml(new TextEncoder().encode(`<w:document ${W}><w:body>${body}</w:body></w:document>`)),
			skeleton: true
		}

		try {
			for (const entry of revisionChecks) void entry.part?.(input, part)
		} catch (error) {
			return error instanceof DocxVerifyError ? error.message : error
		}

		return undefined
	}
	const ins = (attributes: string, content = run("x")): string => `<w:p><w:ins ${attributes}>${content}</w:ins></w:p>`

	it("refuses deleted text outside a deletion and new changes without an author, a valid date or content", () => {
		expect(check(ins('w:id="9" w:author="A"'))).toBeUndefined()
		expect(check("<w:p><w:r><w:delText>x</w:delText></w:r></w:p>")).toMatch(/w:delText outside a deletion/)
		expect(check('<w:p><w:del w:id="3" w:author="A"><w:r><w:delText>x</w:delText></w:r></w:del></w:p>')).toBeUndefined()
		expect(check(ins('w:id="9"'))).toMatch(/new w:ins has no author/)
		expect(check(ins('w:id="9" w:author=""'))).toMatch(/new w:ins has no author/)
		expect(check(ins('w:id="9" w:author="A" w:date="yesterday"'))).toMatch(/has the date yesterday/)
		expect(check(ins('w:id="9" w:author="A" w:date="2026-10-12T13:25:00Z"', ""))).toMatch(/new w:ins holds nothing/)
		// The source's own changes are as the source has them; a paragraph mark's change holds nothing by design.
		expect(check(ins('w:id="9"'), ["revision:9"])).toBeUndefined()
		expect(check('<w:p><w:pPr><w:rPr><w:ins w:id="9" w:author="A"/></w:rPr></w:pPr></w:p>')).toBeUndefined()
	})

	it("refuses to write a recorded change without its author", async () => {
		const doc = await tracked({ body: p("one") })
		const session = doc.session
		const empty = marks.insertion.create({ src: -1, id: null, author: "", date: DATE })

		expect(session.dispatch(markCommand(session.state.tr.addMark(2, 3, empty)))).toBe(true)
		await expect(save(doc, [session])).rejects.toBeInstanceOf(DocxSaveError)
	})

	it("gives a source formatting change copied elsewhere an id of its own", async () => {
		const opened = await openSpec({
			body:
				pr(run("Lead text ")) +
				pr(
					run("changed", '<w:b/><w:rPrChange w:id="7" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:rPr/></w:rPrChange>') +
						run(" tail")
				)
		})
		const session = new DocxEditorSession(opened.context, { transformer: null })
		const second = session.state.doc.child(1)
		// A raw copy (no paste sanitising) of the run, before its paragraph.
		const slice = session.state.doc.slice(
			session.state.doc.child(0).nodeSize + 1,
			session.state.doc.child(0).nodeSize + 1 + second.child(0).nodeSize
		)

		session.dispatch(session.state.tr.replaceRange(2, 2, slice))

		const { xml } = await save(opened, [session])
		const ids = [...xml.matchAll(/<w:rPrChange w:id="(\d+)"/g)].map(match => match[1])

		expect(ids).toHaveLength(2)
		expect(new Set(ids).size).toBe(2)
		expect(ids).toContain("7")
	})
})

const TRACKED_FILES = [
	"oxpt__RA001-Tracked-Revisions-01.docx",
	"oxpt__RA001-Tracked-Revisions-02.docx",
	"oxpt__RP015-MoveFrom-MoveTo.docx",
	"oxpt__RP027-Change-Section.docx",
	"oxsdk__trackChange.docx",
	"oxsdk__Comment025.docx",
	"lo__tdf123054.docx",
	"lo__tdf104797.docx",
	"lo__tdf151954.docx",
	"lo__fdo79668.docx",
	"lo__TC-table-DnD-move.docx",
	"lo__redline-range-comment.docx",
	"govuk__Church_of_England_model_articles_of_association.docx",
	"govuk__Ofsted_Audit_Committee_minutes_15_March_2017.docx"
]

// Paragraphs (not in table cells) whose first eight characters are plain text, from the last back.
function targets(doc: Node, count: number): number[] {
	const out: number[] = []

	doc.descendants((node, pos, parent) => {
		if (node.type !== docxSchema.nodes.paragraph) return !node.isInline

		const first = node.firstChild

		if (
			parent?.type !== docxSchema.nodes.table_cell &&
			first?.isText === true &&
			(first.text?.length ?? 0) >= 8 &&
			first.marks.every(mark => !["insertion", "deletion", "move_from", "move_to"].includes(mark.type.name))
		)
			out.push(pos)

		return false
	})

	return out.slice(0, count).reverse()
}

// Tracked edits from the end of the document back (positions hold whether deleted text stays or not).
function corpusEdits(session: DocxEditorSession): void {
	const [a, b, c, d] = targets(session.state.doc, 4)

	if (a === undefined || b === undefined || c === undefined || d === undefined) return

	select(session, a + 1, a + 5)
	session.execute({ type: "format.bold" })
	select(session, b + 2)
	session.execute({ type: "align.center" })
	session.dispatch(session.state.tr.split(b + 4))
	session.dispatch(session.state.tr.insertText("NEW ", c + 1))
	session.dispatch(session.state.tr.delete(d + 2, d + 5))
}

const CORPUS = CORPUS_DIR

describe.skipIf(!existsSync(join(CORPUS, "docx", TRACKED_FILES[0] as string)))("docx tracked changes over the corpus", () => {
	it("rejecting everything after tracked edits gives what rejecting everything gives, and both save", { timeout: 300_000 }, async () => {
		for (const name of TRACKED_FILES) {
			const bytes = new Uint8Array(readFileSync(join(CORPUS, "docx", name)))
			const plain = await openBytes(bytes)

			if (plain.context.gate.length > 0) continue

			const reference = new DocxEditorSession(plain.context)

			reference.dispatch(resolveChanges(reference, storyReviewIndex(reference), { all: true }, false).tr ?? reference.state.tr)

			const edited = await openBytes(bytes)

			setIdentity(edited.context, "Ann")
			edited.context.review.tracking = true

			const session = new DocxEditorSession(edited.context)

			corpusEdits(session)
			expect(storyReviewIndex(session).revisionCount, name).toBeGreaterThan(0)
			await expect(save(edited, [session]), name).resolves.toBeDefined()
			session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, false).tr ?? session.state.tr)
			if (process.env["DBG"] !== undefined) {
				const a = texts(session)
				const b = texts(reference)

				for (let k = 0; k < Math.max(a.length, b.length); k++)
					if (a[k] !== b[k]) console.log(name, k, JSON.stringify(a[k]), JSON.stringify(b[k]))
			}

			expect(texts(session), name).toEqual(texts(reference))
			// What stays (cell insertions, marks that cannot join) stays alike.
			expect(storyReviewIndex(session).revisionCount, name).toBe(storyReviewIndex(reference).revisionCount)
			await expect(save(edited, [session]), name).resolves.toBeDefined()
		}
	})

	it("accepting everything after tracked edits gives the untracked edits with everything accepted", { timeout: 300_000 }, async () => {
		for (const name of TRACKED_FILES) {
			const bytes = new Uint8Array(readFileSync(join(CORPUS, "docx", name)))
			const plain = await openBytes(bytes)

			if (plain.context.gate.length > 0) continue

			setIdentity(plain.context, "Ann")
			plain.context.review.tracking = false

			const untracked = new DocxEditorSession(plain.context)

			untracked.dispatch(resolveChanges(untracked, storyReviewIndex(untracked), { all: true }, true).tr ?? untracked.state.tr)
			corpusEdits(untracked)
			// What the first pass left (marks that could not join then) is resolved alike.
			untracked.dispatch(resolveChanges(untracked, storyReviewIndex(untracked), { all: true }, true).tr ?? untracked.state.tr)

			const edited = await openBytes(bytes)

			setIdentity(edited.context, "Ann")
			edited.context.review.tracking = true

			const session = new DocxEditorSession(edited.context)

			session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, true).tr ?? session.state.tr)
			corpusEdits(session)
			session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, true).tr ?? session.state.tr)

			if (process.env["DBG"] !== undefined) {
				const a = texts(session)
				const b = texts(untracked)

				for (let k = 0; k < Math.max(a.length, b.length); k++)
					if (a[k] !== b[k]) console.log(name, k, JSON.stringify(a[k]), JSON.stringify(b[k]))
			}

			expect(texts(session), name).toEqual(texts(untracked))
			await expect(save(edited, [session]), name).resolves.toBeDefined()
		}
	})
})

describe("docx tracked changes: recording details", () => {
	it("writes dates as the author's local wall-clock time with Z, as Word does", () => {
		const at = new Date(2026, 9, 12, 9, 5, 59).getTime()

		expect(minuteDate(at)).toBe("2026-10-12T09:05:00Z")
	})

	it("inserts a slice cut inside table rows pasted into a paragraph, its rows inserted, and reject takes it all back", async () => {
		const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
		const table =
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
			[1, 2, 3].map(row => `<w:tr>${["a", "b", "c"].map(column => cell(`${column}${String(row)}`)).join("")}</w:tr>`).join("") +
			"</w:tbl>"
		const doc = await tracked({ body: p("Before") + table + p("After the table") + p("Last") })
		const session = doc.session
		const original = session.state.doc
		const at = (text: string): number => {
			let found = -1

			session.state.doc.descendants((node, pos) => {
				if (found < 0 && node.isText && node.text?.includes(text) === true) found = pos + (node.text.indexOf(text) ?? 0)

				return found < 0
			})

			return found
		}
		// From inside c1 to inside b3, pasted after "After".
		const slice = original.slice(at("c1") + 1, at("b3") + 1)

		select(session, at("After") + 5)
		expect(session.dispatch(session.state.tr.replaceSelection(slice))).toBe(true)

		const result = session.state.doc
		const rows: number[] = []

		result.child(result.childCount - 3).forEach(row => rows.push(row.attrs["revision"] as number))
		expect([shown(result.child(result.childCount - 4)), shown(result.child(result.childCount - 2))]).toEqual([
			"After[+1+]",
			" the table"
		])
		// Its mark is a new one (the paste split the paragraph), none deleted.
		expect(result.child(result.childCount - 4).attrs["revision"]).toBe(RevisionFlag.Inserted)
		expect(rows).toEqual([RevisionFlag.Inserted, RevisionFlag.Inserted, RevisionFlag.Inserted])

		const { xml } = await save(doc, [session])

		expect(xml.match(/<w:trPr><w:ins /g)).toHaveLength(3)

		// Every pasted cell keeps its properties, the one the slice was cut in too.
		expect(xml.slice(xml.indexOf("After")).match(/<w:tcW /g)).toHaveLength(6)

		session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, false).tr as never)
		expect(session.state.doc.eq(original)).toBe(true)

		// Accepted, it is what the same paste makes untracked: the text after the caret after the rows.
		const plain = await openSpec({ body: p("Before") + table + p("After the table") + p("Last") })
		const untracked = new DocxEditorSession(plain.context)

		select(untracked, at("After") + 5)
		expect(untracked.dispatch(untracked.state.tr.replaceSelection(slice))).toBe(true)
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, at("After") + 5)).replaceSelection(slice))
		session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, true).tr as never)

		const shape = (node: Node): string =>
			node.isText
				? (node.text ?? "")
				: `${node.type.name}(${Array.from({ length: node.childCount }, (_, k) => shape(node.child(k))).join(",")})`

		expect(shape(session.state.doc)).toBe(shape(untracked.state.doc))
		expect(shape(untracked.state.doc.child(untracked.state.doc.childCount - 2))).toBe("paragraph( the table)")

		const plainXml = (await save(plain, [untracked])).xml

		expect(plainXml.slice(plainXml.indexOf("After")).match(/<w:tcW /g)).toHaveLength(6)
	})

	it("writes a source paragraph mark revision moved to a split's second half self-closing, with a new id", async () => {
		const doc = await openSpec({
			body: pr(run("one two"), '<w:rPr><w:ins w:id="3" w:author="Bob" w:date="2024-01-01T00:00:00Z"/></w:rPr>') + pr(run("next"))
		})
		const session = new DocxEditorSession(doc.context)

		session.dispatch(session.state.tr.split(4))

		const { xml } = await save(doc, [session])

		expect(xml).not.toContain("></w:ins>")
		expect(xml).toMatch(/<w:ins w:id="(?!3")\d+" w:author="Bob" w:date="2024-01-01T00:00:00Z"\/>/)
	})

	it("records the paragraph properties before a command, not what its first steps made, and reject restores them", async () => {
		const doc = await tracked({ body: p("one") + p("two") })
		const session = doc.session

		select(session, 2, 8)
		session.execute({ type: "list.bullet" })
		session.execute({ type: "style.set", style: "heading2" })

		for (const node of paragraphs(session.state.doc))
			expect(paragraphChange(node)?.props?.before).toEqual({
				styleId: null,
				numId: null,
				ilvl: null,
				align: null,
				indent: null,
				spacing: null,
				borders: null
			})

		const { xml } = await save(doc, [session])

		expect(xml.match(/<w:pPrChange [^>]*><w:pPr\/><\/w:pPrChange>/g)).toHaveLength(2)

		session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, false).tr as never)
		expect(paragraphs(session.state.doc).map(node => [node.attrs["styleId"], node.attrs["numId"], node.attrs["ilvl"]])).toEqual([
			[null, null, null],
			[null, null, null]
		])
	})

	it("records a deletion across paragraphs as one change, resolved whole at the caret or by its id", async () => {
		for (const how of ["accept", "reject", "id"] as const) {
			const doc = await tracked({ body: p("alpha") + p("beta") + p("gamma") })
			const session = doc.session
			const before = session.state.doc

			select(session, 4, 17)
			session.dispatch(session.state.tr.deleteSelection())
			expect(texts(session)).toEqual(["alp[-ha-]", "[-beta-]", "[-gam-]ma"])

			const ids = new Set(
				storyReviewIndex(session)
					.entries()
					.map(entry => entry.id)
			)

			expect(ids.size).toBe(1)

			const scope = how === "id" ? { id: [...ids][0] as string } : { from: 13, to: 13 }

			session.dispatch(resolveChanges(session, storyReviewIndex(session), scope, how !== "reject").tr as never)
			expect(storyReviewIndex(session).revisionCount).toBe(0)

			if (how === "reject") expect(session.state.doc.eq(before)).toBe(true)
			else expect(texts(session)).toEqual(["alpma"])
		}
	})

	it("records no formatting change on content a toggle leaves as it is, and none once toggled back", async () => {
		const doc = await tracked({ body: p("aaa bbb ccc") })
		const session = doc.session

		// Direct formatting made untracked first: "bbb" italic.
		doc.context.review.tracking = false
		select(session, 5, 8)
		session.execute({ type: "format.italic" })
		doc.context.review.tracking = true
		select(session, 1, 12)
		session.execute({ type: "format.italic" })
		expect(texts(session)).toEqual(["[~aaa ~]bbb[~ ccc~]"])
		// Off again: "aaa " and " ccc" are as they were, "bbb" loses its italic.
		session.execute({ type: "format.italic" })
		expect(texts(session)).toEqual(["aaa [~bbb~] ccc"])

		// Bold on and off over formatting the session made (no run of the file has it).
		const other = await tracked({ body: p("aaa bbb") })

		other.context.review.tracking = false
		select(other.session, 1, 4)
		other.session.execute({ type: "format.italic" })
		other.context.review.tracking = true
		select(other.session, 1, 8)
		other.session.execute({ type: "format.bold" })
		expect(texts(other.session)).toEqual(["[~aaa bbb~]"])
		other.session.execute({ type: "format.bold" })
		expect(texts(other.session)).toEqual(["aaa bbb"])
		expect(storyReviewIndex(other.session).revisionCount).toBe(0)
	})

	it("deletes a whole field while tracking: its code stays with it, saved and read back", async () => {
		const field =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DOCPROPERTY  Company  \\* MERGEFORMAT </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Acme</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
		const doc = await tracked({ body: pr(run("At ") + field + run(" today")) })
		const session = doc.session
		const fieldOf = (target: DocxEditorSession): Node | undefined => {
			let found: Node | undefined

			target.state.doc.descendants(node => {
				if (node.type === docxSchema.nodes.field) found = node

				return found === undefined
			})

			return found
		}

		select(session, 3, 5)
		session.dispatch(session.state.tr.deleteSelection())
		expect(fieldOf(session)?.marks.some(mark => mark.type === docxSchema.marks.deletion)).toBe(true)

		const { bytes, xml } = await save(doc, [session])

		expect(xml).toContain("<w:delInstrText")

		const back = await reopened(bytes)

		// Read back, the deleted field has the code it had (not the empty code of what the final view shows).
		expect(fieldOf(back)?.attrs).toMatchObject({ type: "DOCPROPERTY", instruction: " DOCPROPERTY  Company  \\* MERGEFORMAT " })
		session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, false).tr as never)
		expect((await save(doc, [session])).xml).toContain(
			'<w:instrText xml:space="preserve"> DOCPROPERTY  Company  \\* MERGEFORMAT </w:instrText>'
		)
	})

	it("deletes over a section break while tracking: everything stays, marked, the break's mark too", async () => {
		const sect =
			'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
		const doc = await tracked({ body: p("one") + pr(run("two"), sect) + p("three") })
		const session = doc.session
		const before = session.state.doc

		session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
		expect(session.dispatch(session.state.tr.deleteSelection())).toBe(true)
		expect(texts(session)).toEqual(["[-one-]", "[-two-]", "[-three-]"])
		// The mark holding the section break is deleted as Word records it (accepted, the sections combine).
		expect(paragraphs(session.state.doc).map(node => ((node.attrs["revision"] as number) & RevisionFlag.Deleted) !== 0)).toEqual([
			true,
			true,
			false
		])
		await expect(save(doc, [session])).resolves.toBeDefined()
		session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, false).tr as never)
		expect(session.state.doc.eq(before)).toBe(true)

		// Untracked, a section break still may not be deleted.
		doc.context.review.tracking = false
		session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
		expect(session.dispatch(session.state.tr.deleteSelection())).toBe(false)
	})

	it("marks a large deletion in one rebuilt step that brings nothing new, a large format change in one that may", async () => {
		const doc = await tracked({ body: Array.from({ length: 60 }, (_, k) => p(`para ${k}`)).join("") })
		const session = doc.session
		const steps: Step[] = []
		const stop = session.onApplied(transactions => {
			for (const tr of transactions) steps.push(...tr.steps)
		})

		session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
		session.dispatch(session.state.tr.addMark(0, session.state.doc.content.size, marks.bold.create()))

		const formatted = steps.filter(step => step instanceof ReplaceStep)

		steps.length = 0
		session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
		session.dispatch(session.state.tr.deleteSelection())
		stop()

		const deleted = steps.filter(step => step instanceof ReplaceStep)

		expect(texts(session)[59]).toBe("[-para 59-]")
		expect(formatted).toHaveLength(1)
		expect(deleted).toHaveLength(1)
		// Tracking marks and records only: the fields and forms invariants need not read the blocks again.
		expect(formatted.map(isRemarking)).toEqual([false])
		expect(deleted.map(isRemarking)).toEqual([true])
	})

	it("marks the rows of a table deleted whole, adds no paragraph, and accept all leaves one empty paragraph", async () => {
		const table =
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
			"<w:tr><w:tc><w:p><w:r><w:t>c1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>c2</w:t></w:r></w:p></w:tc></w:tr>" +
			"<w:tr><w:tc><w:p><w:r><w:t>c3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>c4</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"

		for (const accept of [true, false]) {
			const doc = await tracked({ body: p("first para") + table + p("last para") })
			const session = doc.session
			const before = session.state.doc

			session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
			session.dispatch(session.state.tr.deleteSelection())
			expect(texts(session)).toEqual(["[-first para-]", "[-c1-]", "[-c2-]", "[-c3-]", "[-c4-]", "[-last para-]"])

			const rows: number[] = []

			session.state.doc.descendants(node => {
				if (node.type === docxSchema.nodes.table_row) rows.push((node.attrs["revision"] as number) & RevisionFlag.Deleted)

				return node.type !== docxSchema.nodes.paragraph
			})
			expect(rows).toEqual([RevisionFlag.Deleted, RevisionFlag.Deleted])
			// One change: text, paragraph marks and rows share its id.
			expect(
				new Set(
					storyReviewIndex(session)
						.entries()
						.map(entry => entry.id)
				).size
			).toBe(1)

			const { xml } = await save(doc, [session])

			expect(xml.match(/<w:trPr><w:del /g)).toHaveLength(2)

			session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, accept).tr as never)

			if (accept) {
				expect(texts(session)).toEqual([""])
				expect(session.state.doc.childCount).toBe(1)
			} else {
				expect(session.state.doc.eq(before)).toBe(true)
			}
		}
	})

	it("deletes a table the author inserted while tracking for real", async () => {
		const bytes = buildDocx({ body: p("before") + p("after") })
		const { editor, context } = await pagedEditor(bytes)

		setIdentity(context, "Ann")
		editor.execute({ type: "review.track", on: true })
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7)))
		await editor.execute({ type: "table.insert", rows: 2, cols: 2 })

		const withTable = editor.state.doc

		expect(withTable.childCount).toBeGreaterThan(2)

		let start = -1
		let end = -1

		withTable.forEach((node, offset) => {
			if (node.type === docxSchema.nodes.table) {
				start = offset
				end = offset + node.nodeSize
			}
		})
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(withTable, start - 3, end + 1)).deleteSelection())

		let tables = 0

		editor.state.doc.forEach(node => {
			if (node.type === docxSchema.nodes.table) tables++
		})
		expect(tables).toBe(0)
		editor.dispose()
	})

	it("selects whole changes with next and previous, never a piece of the change at the selection", async () => {
		const bytes = buildDocx({ body: p("alpha") + p("beta") + p("gamma delta") })
		const { editor, context } = await pagedEditor(bytes)

		setIdentity(context, "Ann")
		editor.execute({ type: "review.track", on: true })
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 4, 17)).deleteSelection())
		editor.dispatch(editor.state.tr.insertText("Z", 23))
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)))
		await settleAll(editor)

		const ranges: [number, number][] = []

		for (let k = 0; k < 3; k++) {
			expect(editor.execute({ type: "review.next" })).toBe(true)
			ranges.push([editor.state.selection.from, editor.state.selection.to])
		}

		expect(ranges).toEqual([
			[4, 17],
			[23, 24],
			[4, 17]
		])
		expect(editor.execute({ type: "review.prev" })).toBe(true)
		expect([editor.state.selection.from, editor.state.selection.to]).toEqual([23, 24])
		expect(editor.execute({ type: "review.prev" })).toBe(true)
		expect([editor.state.selection.from, editor.state.selection.to]).toEqual([4, 17])
		editor.dispose()
	})

	it("selects a whole change with next even when another change's entry sits between its pieces", async () => {
		const bytes = buildDocx({ body: p("alpha") + p("beta") + p("gamma delta") })
		const { editor, context } = await pagedEditor(bytes)

		setIdentity(context, "Ann")
		editor.execute({ type: "review.track", on: true })
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 9)))
		expect(await editor.execute({ type: "align.center" })).toBe(true)
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 4, 17)).deleteSelection())
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)))
		await settleAll(editor)
		expect(editor.execute({ type: "review.next" })).toBe(true)
		expect([editor.state.selection.from, editor.state.selection.to]).toEqual([4, 17])
		editor.dispose()
	})

	it("steps through every change with next and previous, one inside another's span included", async () => {
		const { editor, context } = await pagedEditor(buildDocx({ body: p("alpha") + p("beta") + p("gamma delta") + p("omega") }))

		setIdentity(context, "Ann")
		editor.execute({ type: "review.track", on: true })
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 9)))
		expect(await editor.execute({ type: "align.center" })).toBe(true)
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 4, 17)).deleteSelection())
		editor.dispatch(editor.state.tr.insertText("Z", 28))
		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)))
		await settleAll(editor)

		const ids = storyReviewIndex(editor.session).entries()
		const all = new Set(ids.filter(entry => entry.kind > ReviewKind.COMMENT_REFERENCE).map(entry => entry.id))
		const steps = (command: "review.next" | "review.prev", count: number): (string | null)[] => {
			const out: (string | null)[] = []

			for (let k = 0; k < count; k++) {
				expect(editor.execute({ type: command })).toBe(true)
				out.push(editor.snapshot().review.current)
			}

			return out
		}
		const forward = steps("review.next", 4)

		expect(all.size).toBe(3)
		expect(new Set(forward.slice(0, 3))).toEqual(all)
		expect(forward[3]).toBe(forward[0])
		expect(steps("review.prev", 3)).toEqual([forward[2], forward[1], forward[0]])
		editor.dispose()
	})

	it("steps through the changes of every story on the pages, entering each, and wraps", async () => {
		const ins = (id: number, text: string): string =>
			`<w:ins w:id="${String(id)}" w:author="Bob" w:date="2026-01-01T00:00:00Z">${run(text)}</w:ins>`
		const section =
			'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const { editor } = await pagedEditor(
			buildDocx({ body: pr(run("Body ") + ins(10, "inbody")) + section, headers: { rIdH: pr(run("Head ") + ins(20, "inhead")) } })
		)
		const body = editor.body.session.story.story.index
		const header = editor.edits.model.stories.find(story => story.kind === "header")?.index
		const at = (): [number, string] => [
			editor.activeStory,
			editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
		]

		await settleAll(editor)
		expect(header).toBeDefined()
		expect(editor.execute({ type: "review.next" })).toBe(true)
		expect(at()).toEqual([body, "inbody"])
		expect(editor.execute({ type: "review.next" })).toBe(true)
		expect(at()).toEqual([header, "inhead"])
		expect(editor.execute({ type: "review.next" })).toBe(true)
		expect(at()).toEqual([body, "inbody"])
		expect(editor.execute({ type: "review.prev" })).toBe(true)
		expect(at()).toEqual([header, "inhead"])
		editor.dispose()
	})

	it("enables next and previous for changes only in a story not being edited", async () => {
		const section =
			'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const { editor } = await pagedEditor(
			buildDocx({
				body: pr(run("Body")) + section,
				headers: {
					rIdH: pr(`${run("Head ")}<w:ins w:id="20" w:author="Bob" w:date="2026-01-01T00:00:00Z">${run("inhead")}</w:ins>`)
				}
			})
		)
		const header = editor.edits.model.stories.find(story => story.kind === "header")?.index

		await settleAll(editor)
		expect(editor.snapshot().enabled["review.next"]).toBe(true)
		expect(editor.snapshot().enabled["review.prev"]).toBe(true)
		expect(editor.execute({ type: "review.prev" })).toBe(true)
		expect(editor.activeStory).toBe(header)
		expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe("inhead")
		editor.dispose()
	})

	it("accepts or rejects and moves to the next change with next; without it the selection stays", async () => {
		const ins = (id: number, text: string): string =>
			`<w:ins w:id="${String(id)}" w:author="Bob" w:date="2026-01-01T00:00:00Z">${run(text)}</w:ins>`

		for (const type of ["review.accept", "review.reject"] as const) {
			const bytes = buildDocx({ body: pr(run("Kept ") + ins(10, "one") + run(" mid ")) + pr(run("x ") + ins(11, "two")) })
			const plain = await pagedEditor(bytes)

			setIdentity(plain.context, "Ann")
			plain.editor.dispatch(plain.editor.state.tr.setSelection(TextSelection.create(plain.editor.state.doc, 7)))
			expect(plain.editor.execute({ type })).toBe(true)
			expect(plain.editor.state.selection.empty).toBe(true)
			plain.editor.dispose()

			const { editor, context } = await pagedEditor(bytes)

			setIdentity(context, "Ann")
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7)))
			expect(editor.execute({ type, next: true })).toBe(true)
			expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), type).toBe("two")
			expect(storyReviewIndex(editor.session).revisionCount).toBe(1)
			// The last one resolved: done, nothing left to move to.
			expect(editor.execute({ type, next: true })).toBe(true)
			expect(storyReviewIndex(editor.session).revisionCount).toBe(0)
			editor.dispose()
		}
	})

	it("reads next on accept and reject", () => {
		expect(parseReviewCommand("review.accept", { next: true })).toEqual({ type: "review.accept", next: true })
		expect(parseReviewCommand("review.reject", { id: "12", next: false })).toEqual({ type: "review.reject", id: "12", next: false })
		expect(parseReviewCommand("review.accept", { id: "12" })).toEqual({ type: "review.accept", id: "12" })
		expect(parseReviewCommand("review.accept", { next: "yes" })).toBeUndefined()
	})

	it("disables accept all and reject all once every change is resolved in the session", async () => {
		const { editor, context } = await pagedEditor(
			buildDocx({
				body: pr(`${run("Kept ")}<w:ins w:id="10" w:author="Bob" w:date="2026-01-01T00:00:00Z">${run("inserted")}</w:ins>`)
			})
		)

		setIdentity(context, "Ann")
		expect(editor.snapshot().enabled["review.acceptAll"]).toBe(true)
		expect(await editor.execute({ type: "review.acceptAll" })).toBe(true)
		await settleAll(editor)
		expect(editor.snapshot().enabled["review.acceptAll"]).toBe(false)
		expect(editor.snapshot().enabled["review.rejectAll"]).toBe(false)
		editor.dispose()
	})

	it("marks what a composition typed after it ended (ProseMirror applies the last of it later)", async () => {
		const { editor, context } = await pagedEditor(buildDocx({ body: p("one") }))

		setIdentity(context, "Ann")
		editor.execute({ type: "review.track", on: true })
		editor.setComposition({ from: 2, to: 2 })
		editor.dispatch(editor.state.tr.insertText("か", 2).setMeta("composition", 1))
		editor.setComposition({ from: 2, to: 3 })
		await Promise.resolve()
		// Not while composing.
		expect(texts(editor.session)).toEqual(["oかne"])
		editor.setComposition(undefined)
		expect(texts(editor.session)).toEqual(["o[+か+]ne"])
		editor.dispatch(editor.state.tr.insertText("な", 3).setMeta("composition", 1))
		await Promise.resolve()
		expect(texts(editor.session)).toEqual(["o[+かな+]ne"])
		editor.dispose()
	})

	it("writes what a composition typed marked, the session left as it is until the composition ends", async () => {
		const measurer: TextMeasurer = {
			kerningControl: true,
			measure(_font, _kerning, words, count, widths) {
				for (let k = 0; k < count; k++) widths[k] = (words[k] ?? "").length * 8
			},
			fontExtents: () => ({ ascent: 12, descent: 4 })
		}
		const editing = inThreadEditingHost(
			() => ({
				fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
				replayFonts: false,
				fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
				measurer,
				yield: () => Promise.resolve()
			}),
			{ writer: { prepare: prepareDocxSave } }
		)
		const opened = editing.host(bytesSource(buildDocx({ body: p("one") })), () => undefined)
		const editor = await editing.editor

		editing.setAuthor("Ann")
		editor.execute({ type: "review.track", on: true })
		editor.setComposition({ from: 2, to: 3 })
		editor.dispatch(editor.state.tr.insertText("か", 2).setMeta("composition", 1))
		expect(texts(editor.session)).toEqual(["oかne"])

		const composing = editor.state
		const written = await editing.save()
		const xml = new TextDecoder().decode(unzipSync(written.bytes)["word/document.xml"])

		// Nothing dispatched into the composition; the file has it as an insertion.
		expect(editor.state).toBe(composing)
		expect(xml).toMatch(/<w:ins w:id="\d+" w:author="Ann" [^>]*><w:r><w:t>か<\/w:t><\/w:r><\/w:ins>/)
		editor.setComposition(undefined)
		expect(texts(editor.session)).toEqual(["o[+か+]ne"])
		opened.close()
	})

	it.skipIf(!existsSync(join(CORPUS_DIR, "docx", "oxpt__RP015-MoveFrom-MoveTo.docx")))(
		"accepts and rejects moves over a range taking nothing but the move",
		async () => {
			for (const file of ["oxpt__RP015-MoveFrom-MoveTo.docx", "lo__TC-table-DnD-move.docx"]) {
				for (const accept of [true, false]) {
					const opened = await openBytes(new Uint8Array(readFileSync(join(CORPUS_DIR, "docx", file))))
					const session = new DocxEditorSession(opened.context)
					const kept: string[] = []

					session.state.doc.descendants(node => {
						const has = (...types: (typeof marks.insertion)[]): boolean =>
							types.some(type => type.isInSet(node.marks) !== undefined)

						if (node.isText && !(accept ? has(marks.move_from, marks.deletion) : has(marks.move_to, marks.insertion)))
							kept.push(node.text ?? "")

						return true
					})
					session.dispatch(
						resolveChanges(session, storyReviewIndex(session), { from: 0, to: session.state.doc.content.size }, accept)
							.tr as never
					)
					expect(session.state.doc.textContent, `${file} ${String(accept)}`).toBe(kept.join(""))
				}
			}
		}
	)

	it("resolves a change of many paragraphs and rows at once: reject gives the document back, accept what is left", async () => {
		const cell = (text: string): string => `<w:tc><w:p>${run(text)}</w:p></w:tc>`
		const table =
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
			[1, 2, 3].map(row => `<w:tr>${cell(`r${String(row)}a`)}${cell(`r${String(row)}b`)}</w:tr>`).join("") +
			"</w:tbl>"
		const many = (from: number): string => Array.from({ length: 80 }, (_, k) => p(`Paragraph ${String(from + k)}`)).join("")

		for (const accept of [true, false]) {
			for (const whole of [true, false]) {
				const doc = await tracked({ body: many(0) + table + many(80) })
				const session = doc.session
				const before = session.state.doc
				let at = -1

				before.descendants((node, pos) => {
					if (node.isText && node.text === "r2a") at = pos + 1

					return at < 0
				})

				const selection = whole ? new AllSelection(before) : TextSelection.create(before, 600, at)

				session.dispatch(session.state.tr.setSelection(selection).deleteSelection())

				const kept: string[] = []

				session.state.doc.descendants(node => {
					if (node.isText && marks.deletion.isInSet(node.marks) === undefined) kept.push(node.text ?? "")

					return true
				})
				session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, accept).tr as never)
				expect(storyReviewIndex(session).revisionCount).toBe(0)

				if (!accept) {
					expect(session.state.doc.eq(before)).toBe(true)

					continue
				}

				expect(session.state.doc.textContent).toBe(kept.join(""))

				let rows = 0

				session.state.doc.descendants(node => {
					if (node.type === docxSchema.nodes.table_row) rows++

					return node.type !== docxSchema.nodes.paragraph
				})
				expect(rows).toBe(whole ? 0 : 2)
				if (whole) expect(texts(session)).toEqual([""])
				await expect(save(doc, [session])).resolves.toBeDefined()
			}
		}
	})

	it("records a mark step on content it changes, not on content that has the mark already", async () => {
		const doc = await tracked({ body: pr(run("Source", "<w:i/>")) + p("Plain") })
		const session = doc.session
		// The mark "Source" has (adding it again changes nothing).
		const italic = marks.italic.isInSet(session.state.doc.child(0).firstChild?.marks ?? []) ?? marks.italic.create()

		session.dispatch(session.state.tr.addMark(1, 7, italic))
		expect(texts(session)).toEqual(["Source", "Plain"])
		session.dispatch(session.state.tr.addMark(9, 14, italic))
		expect(texts(session)).toEqual(["Source", "[~Plain~]"])
		session.dispatch(session.state.tr.removeMark(1, 14, marks.italic))
		expect(texts(session)).toEqual(["[~Source~]", "Plain"])
	})

	it("takes the anchors of a comment a tracked deletion holds whole when it is accepted, at the caret, by id or all", async () => {
		const spec: SyntheticDocx = {
			body:
				`<w:p>${run("Alpha ")}<w:commentRangeStart w:id="0"/>${run("beta")}<w:commentRangeEnd w:id="0"/>` +
				`<w:r><w:commentReference w:id="0"/></w:r>${run(" gamma")}</w:p>`,
			comments: `<w:comment w:id="0" w:author="Bo" w:date="2020-01-01T00:00:00Z"><w:p>${run("Note")}</w:p></w:comment>`
		}
		const anchors = (session: DocxEditorSession): number => {
			let count = 0

			session.state.doc.descendants(node => {
				if (node.type === docxSchema.nodes.comment_ref || node.type === docxSchema.nodes.marker) count++

				return true
			})

			return count
		}

		for (const how of ["caret", "id", "all", "reject"] as const) {
			const doc = await tracked(spec)
			const session = doc.session

			// "a beta g" with the anchors in it.
			select(session, 5, 15)
			session.dispatch(session.state.tr.deleteSelection())
			expect(anchors(session)).toBe(3)

			const id = storyReviewIndex(session).changeAt(6)?.id ?? ""
			const scope = how === "caret" ? { from: 6, to: 6 } : how === "id" ? { id } : { all: true as const }

			session.dispatch(resolveChanges(session, storyReviewIndex(session), scope, how !== "reject").tr as never)
			expect(anchors(session), how).toBe(how === "reject" ? 3 : 0)
			expect(session.state.doc.textContent, how).toBe(how === "reject" ? "Alpha beta gamma" : "Alphgamma")
		}
	})

	it("makes accepting and rejecting an undo step of their own, right after an edit", async () => {
		for (const many of [false, true]) {
			const doc = await tracked({ body: Array.from({ length: many ? 80 : 1 }, (_, k) => p(`one ${String(k)}`)).join("") })
			const session = doc.session

			session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)).deleteSelection())

			const deleted = session.state.doc

			session.dispatch(resolveChanges(session, storyReviewIndex(session), { all: true }, false).tr as never)
			session.execute({ type: "history.undo" })
			expect(session.state.doc.eq(deleted), String(many)).toBe(true)
		}
	})
})

describe("docx tracked changes: what a resolved change leaves", () => {
	it("writes no empty paragraph mark properties when a deleted mark is rejected after reopening", async () => {
		const tocPr = '<w:pPr><w:pStyle w:val="TOC1"/></w:pPr>'
		const body =
			`<w:p>${tocPr}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Intro</w:t></w:r></w:p>` +
			`<w:p>${tocPr}<w:r><w:t>Results</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` +
			p("After")
		const opened = await pagedEditor(buildDocx({ body }))
		const session = opened.editor.body.session

		opened.context.identity.author = "Ann"
		opened.context.review.tracking = true
		session.dispatch(
			session.state.tr.setSelection(
				TextSelection.create(session.state.doc, 1, session.state.doc.child(0).nodeSize + session.state.doc.child(1).nodeSize - 1)
			)
		)
		session.dispatch(session.state.tr.deleteSelection())
		await settleAll(opened.editor)

		const tracked = (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })).bytes as Uint8Array
		const again = await pagedEditor(tracked)

		expect(await again.editor.execute({ type: "review.rejectAll" })).toBe(true)
		await settleAll(again.editor)

		const xml = new TextDecoder().decode(
			unzipSync((await saveDocx({ pkg: again.pkg, context: again.context, sessions: again.editor.sessions })).bytes as Uint8Array)[
				"word/document.xml"
			]
		)

		expect(xml).toContain('<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/>')
		expect(xml).not.toMatch(/<w:rPr><\/w:rPr>|<w:pPr><\/w:pPr>/)
		opened.editor.dispose()
		again.editor.dispose()
	})

	it("takes a hyperlink whose text an accepted deletion took out away, proofing marks inside it and all", async () => {
		const link =
			'<w:hyperlink r:id="rIdLink" w:history="1"><w:proofErr w:type="gramStart"/>' +
			run("Working") +
			'<w:proofErr w:type="gramEnd"/>' +
			run(" with lists") +
			"</w:hyperlink>"
		const opened = await pagedEditor(
			buildDocx({
				body: pr(run("Before ") + link + run(" after")),
				relationships: [{ id: "rIdLink", type: "hyperlink", target: "https://example.com/", external: true }]
			})
		)
		const { editor, context } = opened
		const session = editor.body.session

		context.identity.author = "Ann"
		context.review.tracking = true
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 8, 28)))
		session.dispatch(session.state.tr.deleteSelection())
		expect(await editor.execute({ type: "review.acceptAll" })).toBe(true)
		await settleAll(editor)

		const xml = new TextDecoder().decode(
			unzipSync((await saveDocx({ pkg: opened.pkg, context, sessions: editor.sessions })).bytes as Uint8Array)["word/document.xml"]
		)

		expect(xml).not.toContain("<w:hyperlink")
		expect(session.state.doc.textContent).toBe("Before  after")
		editor.dispose()
	})
})
