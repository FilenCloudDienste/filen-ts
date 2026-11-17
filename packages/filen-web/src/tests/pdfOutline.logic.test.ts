import { describe, expect, it } from "vitest"
import type { PdfOutlineItem } from "@filen/office/dom/pdf"
import {
	currentSection,
	hasChildren,
	outlineKeyMove,
	OUTLINE_RESOLVE_MARGIN,
	parentOf,
	rowsToResolve,
	visibleRows
} from "@/features/preview/lib/pdfOutline.logic"

const item = (title: string, depth: number): PdfOutlineItem => ({ title, depth, dest: [depth] })

// 0 Intro, 1 Methods (2 Data, 3 Model (4 Fit)), 5 Results
const OUTLINE = [item("Intro", 0), item("Methods", 0), item("Data", 1), item("Model", 1), item("Fit", 2), item("Results", 0)]

describe("the outline pane's tree", () => {
	it("hides a collapsed item's descendants", () => {
		expect(visibleRows(OUTLINE, new Set())).toEqual([0, 1, 2, 3, 4, 5])
		expect(visibleRows(OUTLINE, new Set([1]))).toEqual([0, 1, 5])
		expect(visibleRows(OUTLINE, new Set([3]))).toEqual([0, 1, 2, 3, 5])
		// A collapsed leaf hides nothing.
		expect(visibleRows(OUTLINE, new Set([2]))).toEqual([0, 1, 2, 3, 4, 5])
		expect([hasChildren(OUTLINE, 1), hasChildren(OUTLINE, 2), hasChildren(OUTLINE, 5)]).toEqual([true, false, false])
		expect([parentOf(OUTLINE, 4), parentOf(OUTLINE, 2), parentOf(OUTLINE, 5)]).toEqual([3, 1, null])
	})

	it("moves with the tree keys", () => {
		const open = new Set<number>()
		const rows = visibleRows(OUTLINE, open)

		expect(outlineKeyMove(OUTLINE, rows, open, 0, "ArrowDown")).toEqual({ kind: "focus", index: 1 })
		expect(outlineKeyMove(OUTLINE, rows, open, 0, "ArrowUp")).toBeNull()
		expect(outlineKeyMove(OUTLINE, rows, open, 1, "ArrowRight")).toEqual({ kind: "focus", index: 2 })
		expect(outlineKeyMove(OUTLINE, rows, open, 1, "ArrowLeft")).toEqual({ kind: "collapse", index: 1 })
		expect(outlineKeyMove(OUTLINE, rows, open, 4, "ArrowLeft")).toEqual({ kind: "focus", index: 3 })
		expect(outlineKeyMove(OUTLINE, rows, open, 2, "End")).toEqual({ kind: "focus", index: 5 })
		expect(outlineKeyMove(OUTLINE, rows, open, 5, "Home")).toEqual({ kind: "focus", index: 0 })

		const closed = new Set([1])

		expect(outlineKeyMove(OUTLINE, visibleRows(OUTLINE, closed), closed, 1, "ArrowRight")).toEqual({ kind: "expand", index: 1 })
		expect(outlineKeyMove(OUTLINE, visibleRows(OUTLINE, closed), closed, 1, "ArrowDown")).toEqual({ kind: "focus", index: 5 })
	})

	it("resolves only the rows on screen and the margin, once each", () => {
		const rows = Array.from({ length: 200 }, (_, index) => index)

		expect(rowsToResolve(rows, 50, 60, new Map())).toEqual(rows.slice(50 - OUTLINE_RESOLVE_MARGIN, 60 + OUTLINE_RESOLVE_MARGIN + 1))
		expect(rowsToResolve(rows, 0, 5, new Map([[0, 1]]))).toEqual(rows.slice(1, 5 + OUTLINE_RESOLVE_MARGIN + 1))
	})

	it("marks the last section at or before the current page", () => {
		const resolved = new Map<number, number | null>([
			[0, 1],
			[1, 3],
			[2, 3],
			[3, 7],
			[5, null]
		])

		expect(currentSection(resolved, 1)).toBe(0)
		expect(currentSection(resolved, 4)).toBe(2)
		expect(currentSection(resolved, 9)).toBe(3)
		expect(currentSection(new Map(), 3)).toBeNull()
	})
})
