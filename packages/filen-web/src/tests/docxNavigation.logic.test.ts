import { describe, expect, it } from "vitest"
import { Schema, type Node } from "prosemirror-model"
import type { DocxOutline, DocxOutlineEntry } from "@filen/office/core/docx/paged"
import { FIND_CLOSED } from "@/features/preview/components/docxEditorFind.logic"
import {
	NAVIGATION_CLOSED,
	dropBefore,
	headingKeys,
	headingRows,
	matchContext,
	openedNavigation,
	sameHeadings,
	seededFind
} from "@/features/preview/components/docxNavigation.logic"

// Word's Navigation pane: the Headings tree (collapsing, depth, drop places), and the Results' context.

const schema = new Schema({
	nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} }
})

function doc(...paragraphs: string[]): Node {
	return schema.node(
		"doc",
		null,
		paragraphs.map(text => schema.node("paragraph", null, text === "" ? [] : [schema.text(text)]))
	)
}

function outline(...entries: [number, string][]): DocxOutline {
	return {
		doc: doc("x"),
		entries: entries.map(([level, text], index): DocxOutlineEntry => ({ level, text, pos: index * 10 }))
	}
}

describe("headings tree", () => {
	const tree = outline([0, "One"], [1, "One a"], [2, "One a i"], [1, "One b"], [0, "Two"], [2, "Two deep"], [0, "One"])

	it("keys repeated headings by occurrence", () => {
		const keys = headingKeys(tree.entries)

		expect(new Set(keys).size).toBe(keys.length)
		expect(keys[0]).not.toBe(keys[6])
	})

	it("indents a heading under the headings above it, a skipped level one step", () => {
		const rows = headingRows(tree, headingKeys(tree.entries), new Set())

		expect(rows.map(row => [row.entry.text, row.depth, row.parent])).toEqual([
			["One", 0, true],
			["One a", 1, true],
			["One a i", 2, false],
			["One b", 1, false],
			["Two", 0, true],
			["Two deep", 1, false],
			["One", 0, false]
		])
	})

	it("hides a collapsed heading's subheadings, and keeps it collapsed by its key", () => {
		const keys = headingKeys(tree.entries)
		const rows = headingRows(tree, keys, new Set([keys[0] ?? ""]))

		expect(rows.map(row => row.entry.text)).toEqual(["One", "Two", "Two deep", "One"])
		expect(rows[0]?.collapsed).toBe(true)
		// A heading without subheadings is never collapsed.
		expect(headingRows(tree, keys, new Set([keys[6] ?? ""]))[6]?.collapsed).toBe(false)
	})

	it("drops before the row's heading, or before the next row's below its middle", () => {
		const keys = headingKeys(tree.entries)
		const rows = headingRows(tree, keys, new Set([keys[0] ?? ""]))

		expect(dropBefore(rows, 1, false, tree.entries.length)).toBe(4)
		// Below the collapsed "One": before "Two", past its hidden subheadings.
		expect(dropBefore(rows, 0, true, tree.entries.length)).toBe(4)
		expect(dropBefore(rows, rows.length - 1, true, tree.entries.length)).toBe(tree.entries.length)
	})

	it("tells whether two outlines list the same headings", () => {
		expect(sameHeadings(tree, outline(...tree.entries.map(entry => [entry.level, entry.text] as [number, string])))).toBe(true)
		expect(sameHeadings(tree, outline([0, "One"]))).toBe(false)
		expect(sameHeadings(outline([0, "A"]), outline([1, "A"]))).toBe(false)
	})
})

describe("results", () => {
	it("shows a match in its paragraph's text", () => {
		const document = doc("First", "The quick brown fox")
		// "quick": the second paragraph's text starts at 8.
		const from = 8 + "The ".length

		expect(matchContext(document, { from, to: from + 5 })).toEqual({ before: "The ", match: "quick", after: " brown fox" })
	})

	it("cuts long context to whole words with an ellipsis", () => {
		const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda"
		const document = doc(`${words} TARGET ${words}`)
		const from = 1 + words.length + 1
		const context = matchContext(document, { from, to: from + 6 }, 20)

		expect(context.match).toBe("TARGET")
		expect(context.before.startsWith("…")).toBe(true)
		expect(context.before.length).toBeLessThanOrEqual(21)
		expect(context.before.endsWith("lambda ")).toBe(true)
		expect(context.after.endsWith("…")).toBe(true)
		expect(context.after.startsWith(" alpha")).toBe(true)
	})
})

describe("pane state", () => {
	it("focuses the search box when opened to search, and keeps the tab", () => {
		const opened = openedNavigation({ ...NAVIGATION_CLOSED, tab: "pages" }, true)

		expect(opened).toEqual({ open: true, tab: "pages", focus: 1 })
		expect(openedNavigation(opened, false).focus).toBe(1)
	})

	it("searches the selection's text, else the last search, leaving the find bar closed", () => {
		const last = { ...FIND_CLOSED, query: "old", active: 3 }

		expect(seededFind(last, undefined)).toBe(last)
		expect(seededFind(last, "old")).toBe(last)
		expect(seededFind(last, "new")).toEqual({ ...last, query: "new", active: -1 })
		expect(seededFind(last, "new").open).toBe(false)
	})
})
