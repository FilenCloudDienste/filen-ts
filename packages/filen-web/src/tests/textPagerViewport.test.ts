import { describe, expect, it } from "vitest"
import {
	appendRows,
	maxHeldRows,
	nextLine,
	numberRows,
	placedWindow,
	positionStore,
	prependRows,
	scrollWindow,
	visibleRows,
	wantsAfter,
	wantsBefore,
	type PagerWindow,
	type WindowBounds,
	type WindowRow
} from "@/features/preview/lib/textPager/viewport.logic"

// Rows of 10 bytes each from `from`, numbered from `line`.
function rows(from: number, count: number, line: number | null = null): WindowRow[] {
	return Array.from({ length: count }, (_, index) => ({
		start: from + index * 10,
		end: from + (index + 1) * 10,
		breaks: true,
		line: line === null ? null : line + index
	}))
}

const BOUNDS: WindowBounds = { start: 0, size: 100_000, rowHeight: 20, height: 200 }

describe("textPager viewport", () => {
	it("scrolls within its rows: never above the first, never past the file's end at the bottom", () => {
		const window = { rows: rows(0, 50), top: 0, shift: 0 }

		expect(scrollWindow(window, 45, BOUNDS)).toMatchObject({ top: 2, shift: 5 })
		expect(scrollWindow(window, -45, BOUNDS)).toMatchObject({ top: 0, shift: 0 })

		const end = { rows: rows(99_500, 50), top: 30, shift: 0 }

		// 50 rows of 20 px under a 200 px view: the last row's bottom meets the view's at 800 px.
		expect(scrollWindow(end, 10_000, BOUNDS)).toMatchObject({ top: 40, shift: 0 })
	})

	it("places a located row near the top, and the file's end at the bottom", () => {
		expect(placedWindow(rows(1000, 40), 10, 3, BOUNDS)).toMatchObject({ top: 7 })
		expect(placedWindow(rows(99_800, 20), 18, 3, BOUNDS)).toMatchObject({ top: 10 })
	})

	it("asks for rows near either end of what it holds, and only where the file goes on", () => {
		const shown = visibleRows(BOUNDS)

		expect(wantsBefore({ rows: rows(1000, 40), top: shown - 1, shift: 0 }, BOUNDS)).toBe(true)
		expect(wantsBefore({ rows: rows(0, 40), top: 0, shift: 0 }, BOUNDS)).toBe(false)
		expect(wantsAfter({ rows: rows(1000, 40), top: 40 - shown, shift: 0 }, BOUNDS)).toBe(true)
		expect(wantsAfter({ rows: rows(99_600, 40), top: 39, shift: 0 }, BOUNDS)).toBe(false)
	})

	it("holds a bounded number of rows however far it scrolls", () => {
		let window: PagerWindow<WindowRow> = { rows: rows(0, 20), top: 0, shift: 0 }

		for (let step = 0; step < 100; step++) {
			const last = window.rows.at(-1)?.end ?? 0

			window = appendRows(window, rows(last, 20), BOUNDS)
			window = scrollWindow(window, 20 * 20, BOUNDS)
			expect(window.rows.length).toBeLessThanOrEqual(maxHeldRows(BOUNDS) + 20)
		}

		const first = window.rows[0]?.start ?? 0
		const top = window.top
		const prepended = prependRows(window, rows(first - 200, 20), BOUNDS)

		expect(prepended.top).toBe(top + 20)
		expect(prepended.rows.length).toBeLessThanOrEqual(Math.max(maxHeldRows(BOUNDS), prepended.top + 2 * visibleRows(BOUNDS)))
	})

	it("follows line numbers across a break only", () => {
		expect(nextLine({ start: 0, end: 5, breaks: true, line: 7 })).toBe(8)
		expect(nextLine({ start: 0, end: 5, breaks: false, line: 7 })).toBe(7)
		expect(nextLine({ start: 0, end: 5, breaks: true, line: null })).toBeNull()
	})

	it("tells its listeners when the position moves", () => {
		const store = positionStore()
		let calls = 0
		const unsubscribe = store.subscribe(() => {
			calls++
		})

		store.set(10)
		store.set(10)
		unsubscribe()
		store.set(20)
		expect([calls, store.get()]).toEqual([1, 20])
	})

	it("numbers rows from the first one's line, within the counted prefix only, keeping the rows", () => {
		const held = [
			{ start: 0, end: 10, breaks: false, line: null },
			{ start: 10, end: 20, breaks: true, line: null },
			{ start: 20, end: 30, breaks: true, line: null },
			{ start: 30, end: 40, breaks: true, line: null }
		]
		const numbered = numberRows(held, 7, 25)

		expect(numbered.map(row => row.line)).toEqual([7, 7, 8, null])
		expect(numbered.map(row => row.start)).toEqual(held.map(row => row.start))
	})
})
