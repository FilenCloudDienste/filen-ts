import type { Node } from "prosemirror-model"
import { TextSelection, type Transaction } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import {
	DocxEditorSession,
	STORY_FIND_LIMIT,
	findInStory,
	findPattern,
	matchHolds,
	replaceAll,
	replaceMatches,
	selectMatch
} from "@filen/office/core/docx/edit"
import { nodeText, openSpec, sessionOf } from "./docxEditFixtures"
import { p } from "./docxSynthetic"

const LOCKED = (value: string): string =>
	`<w:p><w:sdt><w:sdtPr><w:id w:val="7"/><w:lock w:val="sdtContentLocked"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>${value}</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t xml:space="preserve"> and of</w:t></w:r></w:p>`
const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
const TABLE = (rows: number): string =>
	`<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${Array.from({ length: rows }, (_, k) => `<w:tr>${cell(`row ${String(k)} of`)}${cell("none")}</w:tr>`).join("")}</w:tbl>`
const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`

// The text of `doc` carrying a mark of `type`, in document order.
function textWith(doc: Node, type: string): string {
	let out = ""

	doc.descendants(node => {
		if (node.isText && node.marks.some(mark => mark.type.name === type)) out += node.text ?? ""

		return true
	})

	return out
}

// Replace All's transaction and count; the test fails when it replaced nothing.
function replacing(result: ReturnType<typeof replaceAll>): { readonly tr: Transaction; readonly count: number } {
	if (result === null || !("tr" in result)) throw new Error(`nothing replaced: ${JSON.stringify(result)}`)

	return result
}

const BOLD_RUN = '<w:p><w:r><w:t xml:space="preserve">plain </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r></w:p>'

describe("findInStory", () => {
	it("finds matches across paragraphs at document positions", async () => {
		const session = await sessionOf({ body: p("One fish two fish") + p("red Fish") })
		const doc = session.state.doc
		const matches = findInStory(doc, "fish")

		expect(matches).toHaveLength(3)

		for (const match of matches) expect(doc.textBetween(match.from, match.to).toLowerCase()).toBe("fish")

		expect(findInStory(doc, "Fish", { caseSensitive: true })).toHaveLength(1)
	})

	it("treats the query literally and an empty one as nothing", async () => {
		const session = await sessionOf({ body: p("a.b a+b (x)") })
		const doc = session.state.doc

		expect(findInStory(doc, ".")).toHaveLength(1)
		expect(findInStory(doc, "a+b")).toHaveLength(1)
		expect(findInStory(doc, "(x)")).toHaveLength(1)
		expect(findInStory(doc, "")).toEqual([])
		expect(findPattern("")).toBeNull()
	})

	it("never matches across an inline atom", async () => {
		const session = await sessionOf({ body: "<w:p><w:r><w:t>ab</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>cd</w:t></w:r></w:p>" })
		const doc = session.state.doc

		expect(findInStory(doc, "bc")).toEqual([])
		expect(findInStory(doc, "cd")).toHaveLength(1)

		const [match] = findInStory(doc, "cd")

		expect(match === undefined ? "" : doc.textBetween(match.from, match.to)).toBe("cd")
	})

	it("matches across normalisation forms on whole characters", async () => {
		const session = await sessionOf({ body: p("Le CAFE\u0301 et le cafe\u0301") })
		const doc = session.state.doc
		const matches = findInStory(doc, "café")

		expect(matches.map(match => doc.textBetween(match.from, match.to))).toEqual(["CAFE\u0301", "cafe\u0301"])
		expect(matches.every(match => matchHolds(doc, match, "café"))).toBe(true)
	})

	it("finds whole words only when asked: a letter, digit, mark or underscore on either side rules a match out", async () => {
		const session = await sessionOf({
			body:
				p("the other them, The. the2 the_ 2the") +
				"<w:p><w:r><w:t>the</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>the</w:t></w:r></w:p>"
		})
		const doc = session.state.doc
		const words = findInStory(doc, "the", { wholeWord: true })

		expect(findInStory(doc, "the")).toHaveLength(9)
		expect(words.map(match => doc.textBetween(match.from, match.to))).toEqual(["the", "The", "the", "the"])
		expect(findInStory(doc, "the", { wholeWord: true, caseSensitive: true })).toHaveLength(3)
		// Only an edge of the query that is a word character needs a boundary.
		expect(findInStory(doc, "the ", { wholeWord: true })).toHaveLength(1)
		expect(findInStory(doc, "m, the", { wholeWord: true })).toHaveLength(0)
		expect(findInStory(doc, ". the2", { wholeWord: true })).toHaveLength(1)
	})

	it("judges a whole-word match against the text around it when checking that it holds", async () => {
		const session = await sessionOf({ body: p("cat cat") })
		const [first, second] = findInStory(session.state.doc, "cat", { wholeWord: true })

		if (first === undefined || second === undefined) throw new Error("no match")

		session.dispatch(session.state.tr.insertText("s", first.to))
		expect(matchHolds(session.state.doc, first, "cat", { wholeWord: true })).toBe(false)
		expect(matchHolds(session.state.doc, first, "cat")).toBe(true)

		// "cats cat" to "cats xcat": the second match, moved by both insertions, now follows a letter.
		session.dispatch(session.state.tr.insertText("x", second.from + 1))

		const moved = { from: second.from + 2, to: second.to + 2 }

		expect(session.state.doc.textBetween(moved.from, moved.to)).toBe("cat")
		expect(matchHolds(session.state.doc, moved, "cat", { wholeWord: true })).toBe(false)
		expect(matchHolds(session.state.doc, moved, "cat")).toBe(true)
	})

	it("honours the limit", async () => {
		const session = await sessionOf({ body: p("x ".repeat(50)) })

		expect(findInStory(session.state.doc, "x", {}, 7)).toHaveLength(7)
	})
})

describe("replaceMatches", () => {
	it("replaces every match in one undoable step, keeping the formatting where each starts", async () => {
		const session = await sessionOf({ body: BOLD_RUN + p("plain again") })
		const matches = findInStory(session.state.doc, "plain")
		const tr = replaceMatches(session.state, matches, "plain", "simple")

		expect(tr).not.toBeNull()

		if (tr === null) return

		expect(session.dispatch(tr)).toBe(true)
		expect(nodeText(session.state.doc.child(0))).toBe("simple Bold")
		expect(nodeText(session.state.doc.child(1))).toBe("simple again")
		expect(session.snapshot().dirty).toBe(true)
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(nodeText(session.state.doc.child(0))).toBe("plain Bold")
		expect(nodeText(session.state.doc.child(1))).toBe("plain again")
	})

	it("keeps the run's formatting of the match", async () => {
		const session = await sessionOf({ body: BOLD_RUN })
		const matches = findInStory(session.state.doc, "Bold")
		const tr = replaceMatches(session.state, matches, "Bold", "Strong")

		if (tr === null) throw new Error("no replacement")

		session.dispatch(tr)

		const [match] = findInStory(session.state.doc, "Strong")

		if (match === undefined) throw new Error("not replaced")

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, match.from, match.to)))
		expect(session.snapshot().formats.bold).toBe("on")
	})

	it("deletes with an empty replacement and skips matches that no longer hold", async () => {
		const session = await sessionOf({ body: p("cat cat cat") })
		const matches = findInStory(session.state.doc, "cat")

		expect(matches).toHaveLength(3)

		// The middle one is edited away first.
		const middle = matches[1]

		if (middle === undefined) throw new Error("no match")

		session.dispatch(session.state.tr.insertText("dog", middle.from, middle.to))
		expect(matchHolds(session.state.doc, middle, "cat")).toBe(false)

		const tr = replaceMatches(session.state, matches, "cat", "")

		if (tr === null) throw new Error("nothing replaced")

		session.dispatch(tr)
		expect(nodeText(session.state.doc.child(0))).toBe(" dog ")
	})

	it("returns null when nothing holds and refuses in a read-only session", async () => {
		const session = await sessionOf({ body: p("abc") }, { readOnly: true })
		const matches = findInStory(session.state.doc, "abc")

		expect(replaceMatches(session.state, [], "abc", "x")).toBeNull()

		const tr = replaceMatches(session.state, matches, "abc", "x")

		if (tr === null) throw new Error("no transaction")

		expect(session.dispatch(tr)).toBe(false)
		expect(nodeText(session.state.doc.child(0))).toBe("abc")
	})
})

describe("replaceAll", () => {
	it("replaces every match, past what find shows, in one undoable step with the true count", async () => {
		const session = await sessionOf({ body: p("ab ".repeat(6000)) + BOLD_RUN + p("ab ".repeat(6000)) })

		expect(findInStory(session.state.doc, "ab")).toHaveLength(STORY_FIND_LIMIT)

		const result = replacing(replaceAll(session.state, "ab", "xyz"))

		expect(result.count).toBe(12_000)
		expect(result.tr.steps).toHaveLength(1)
		expect(session.dispatch(result.tr)).toBe(true)
		expect(findInStory(session.state.doc, "ab")).toHaveLength(0)
		expect(findInStory(session.state.doc, "xyz", {}, Number.POSITIVE_INFINITY)).toHaveLength(12_000)
		expect(nodeText(session.state.doc.child(1))).toBe("plain Bold")
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(findInStory(session.state.doc, "ab", {}, Number.POSITIVE_INFINITY)).toHaveLength(12_000)
	})

	it("keeps each match's formatting, deletes with an empty replacement, and is null without a match", async () => {
		const session = await sessionOf({ body: BOLD_RUN + p("cat cat") })
		const bold = replacing(replaceAll(session.state, "Bold", "Strong"))

		session.dispatch(bold.tr)

		const [match] = findInStory(session.state.doc, "Strong")

		if (match === undefined) throw new Error("not replaced")

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, match.from, match.to)))
		expect(session.snapshot().formats.bold).toBe("on")

		const cats = replacing(replaceAll(session.state, "CAT", ""))

		expect(cats.count).toBe(2)
		session.dispatch(cats.tr)
		expect(nodeText(session.state.doc.child(1))).toBe(" ")
		expect(replaceAll(session.state, "dog", "x")).toBeNull()
		expect(replaceAll(session.state, "CAT", "x", { caseSensitive: true })).toBeNull()
	})

	it("leaves text inside longer words alone with whole words only", async () => {
		const session = await sessionOf({ body: p("the other there the") })
		const result = replacing(replaceAll(session.state, "the", "a", { wholeWord: true }))

		expect(result.count).toBe(2)
		session.dispatch(result.tr)
		expect(nodeText(session.state.doc.child(0))).toBe("a other there a")
	})
})

describe("replaceAll over many blocks", () => {
	it("replaces matches in thousands of blocks in few steps, undone to the same blocks", async () => {
		const body = Array.from({ length: 3000 }, (_, k) => p(k % 3 === 0 ? `part ${String(k)} of it` : "plain")).join("") + TABLE(2000)
		const session = await sessionOf({ body })
		const before = session.state.doc
		const result = replacing(replaceAll(session.state, "of", "OF", { caseSensitive: true }))

		expect(result.count).toBe(3000)
		// One over the paragraphs, one inside the long table (a step per paragraph would copy the 3,001 blocks
		// around each of its 3,000 paragraphs).
		expect(result.tr.steps).toHaveLength(2)
		expect(session.dispatch(result.tr)).toBe(true)
		expect(findInStory(session.state.doc, "of", { caseSensitive: true }, Number.POSITIVE_INFINITY)).toHaveLength(0)
		expect(findInStory(session.state.doc, "OF", { caseSensitive: true }, Number.POSITIVE_INFINITY)).toHaveLength(3000)
		expect(session.state.doc.child(1)).toBe(before.child(1))
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(session.state.doc.eq(before)).toBe(true)

		// The same blocks come back: the paragraphs, and the long table's rows (the table around them is a copy).
		let same = 0

		before.forEach((child, _, index) => {
			const now = session.state.doc.child(index)

			if (child.type.name === "table") child.forEach((row, __, at) => (same += now.child(at) === row ? 1 : 0))
			else if (now === child) same++
		})

		expect(same).toBe(before.childCount - 1 + 2000)
	})

	it("replaces around a locked control, leaving its content, in one rebuild undone to the same blocks", async () => {
		const session = await sessionOf({ body: p("one of") + LOCKED("of") + p("two of") })
		const before = session.state.doc
		const result = replacing(replaceAll(session.state, "of", "OF", { caseSensitive: true }))

		expect(result.count).toBe(3)
		expect(result.tr.steps).toHaveLength(1)
		expect(session.dispatch(result.tr)).toBe(true)
		expect(session.state.doc.textContent).toBe("one OFof and OFtwo OF")
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect([0, 1, 2].map(k => session.state.doc.child(k) === before.child(k))).toEqual([true, true, true])
	})

	it("leaves the text after a run-level control outside it when a match ending the control is deleted", async () => {
		const plain = `<w:p>${run("before ")}<w:sdt><w:sdtPr><w:id w:val="9"/><w:text/></w:sdtPr><w:sdtContent>${run("plain foo")}</w:sdtContent></w:sdt>${run(" after foo")}</w:p>`
		const session = await sessionOf({ body: plain })

		expect(session.dispatch(replacing(replaceAll(session.state, "foo", "")).tr)).toBe(true)
		expect(session.state.doc.textContent).toBe("before plain  after ")
		expect(textWith(session.state.doc, "content_control")).toBe("plain ")
	})

	it("records only the matches as changed when tracked", async () => {
		const opened = await openSpec({ body: `<w:p>${run("foo one foo")}</w:p>` })

		opened.context.identity.author = "Ann"
		opened.context.review.tracking = true

		const session = new DocxEditorSession(opened.context)

		expect(session.dispatch(replacing(replaceAll(session.state, "foo", "BAR")).tr)).toBe(true)
		expect(textWith(session.state.doc, "deletion")).toBe("foofoo")
		expect(textWith(session.state.doc, "insertion")).toBe("BARBAR")
	})

	it("makes text replaced inside another author's insertion plain, whatever else the edit holds", async () => {
		const inserted = `<w:p><w:ins w:id="20" w:author="Bob" w:date="2025-01-01T00:00:00Z">${run("inserted foo")}</w:ins>${run(" end")}</w:p>`
		const plain = `<w:p><w:sdt><w:sdtPr><w:id w:val="9"/><w:text/></w:sdtPr><w:sdtContent>${run("plain foo")}</w:sdtContent></w:sdt></w:p>`

		for (const body of [inserted, inserted + plain]) {
			const session = await sessionOf({ body })
			// The control's own text changes too, which the forms rules finish as a command of theirs.
			const tr = replaceMatches(session.state, findInStory(session.state.doc, "o"), "o", "oo")

			if (tr === null) throw new Error("nothing replaced")

			expect(session.dispatch(tr)).toBe(true)
			expect(textWith(session.state.doc, "insertion")).toBe("inserted f")
		}
	})

	it("leaves matches in deleted text as they are and replaces the others", async () => {
		const deleted =
			'<w:p><w:r><w:t xml:space="preserve">one of </w:t></w:r><w:del w:id="1" w:author="Ann" w:date="2020-01-01T00:00:00Z"><w:r><w:delText>of</w:delText></w:r></w:del></w:p>'
		const session = await sessionOf({ body: p("two of") + deleted })
		const result = replacing(replaceAll(session.state, "of", "OF", { caseSensitive: true }))

		expect(result.count).toBe(2)
		expect(session.dispatch(result.tr)).toBe(true)
		expect(session.state.doc.textContent).toBe("two OFone OF of")
	})

	it("tracks a Replace All over thousands of paragraphs, also ones holding tracked changes, in few steps", async () => {
		const reviewed = (k: number): string =>
			`<w:p>${run(`line ${String(k)} of `)}<w:ins w:id="${String(k + 10)}" w:author="Bob" w:date="2025-01-01T00:00:00Z">${run("x")}</w:ins></w:p>`
		const opened = await openSpec({ body: Array.from({ length: 5000 }, (_, k) => reviewed(k)).join("") })

		opened.context.identity.author = "Ann"
		opened.context.review.tracking = true

		const session = new DocxEditorSession(opened.context)
		const before = session.state.doc
		const result = replacing(replaceAll(session.state, "of", "OF", { caseSensitive: true }))

		expect(result.count).toBe(5000)
		expect(result.tr.steps.length).toBeLessThan(10)
		expect(session.dispatch(result.tr)).toBe(true)
		expect(textWith(session.state.doc, "deletion")).toBe("of".repeat(5000))
		expect(textWith(session.state.doc, "insertion")).toBe("OFx".repeat(5000))
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(session.state.doc.eq(before)).toBe(true)
	})
})

describe("selectMatch", () => {
	it("selects a match and refuses one outside the document", async () => {
		const session = await sessionOf({ body: p("find me here") })
		const [match] = findInStory(session.state.doc, "me")

		if (match === undefined) throw new Error("no match")

		const tr = selectMatch(session.state, match)

		expect(tr).not.toBeNull()

		if (tr !== null) session.dispatch(tr)

		expect(session.state.selection.from).toBe(match.from)
		expect(session.state.selection.to).toBe(match.to)
		expect(selectMatch(session.state, { from: 0, to: session.state.doc.content.size + 5 })).toBeNull()
	})
})

describe("markSaved", () => {
	it("marks the document as it was written saved, leaving later edits unsaved", async () => {
		const session = await sessionOf({ body: p("abc") })

		session.dispatch(session.state.tr.insertText("x", 1))

		const written = session.state.doc

		session.dispatch(session.state.tr.insertText("y", 1))
		session.markSaved(written)
		expect(session.snapshot().dirty).toBe(true)
		session.markSaved()
		expect(session.snapshot().dirty).toBe(false)
	})
})
