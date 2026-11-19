import { describe, expect, it } from "vitest"
import { AxisFlag, SHEET_MAX_ROWS, type SheetAxisLayout, type SheetLayout } from "../core/sheet/protocol"
import { axisPositions } from "../core/xlsx/drawings/geometry"
import { axisEntry, createGridAxis, shownIndex } from "../react/sheet/axis"
import { MAX_SCROLL_PX, SCROLL_MARGIN_PX, domExtent, toDom, toVirtual } from "../react/sheet/scroll"
import { bodyTotal, edgeAt, gridView, hitAxis, revealOffset, screenOf } from "../react/sheet/view"

// The grid's geometry: axes over sparse size exceptions, scaled scrolling past the browsers' element-size caps, and
// the panes of one scroll position.

function axisLayout(defaultSize: number, entries: readonly [index: number, size: number, flags?: number][]): SheetAxisLayout {
	return {
		defaultSize,
		indices: Uint32Array.from(entries, entry => entry[0]),
		sizes: Float32Array.from(entries, entry => entry[1]),
		styles: new Uint32Array(entries.length),
		flags: Uint16Array.from(entries, entry => entry[2] ?? 0)
	}
}

// The same answers by walking every index.
function bruteOffset(sizes: readonly number[], index: number): number {
	let sum = 0

	for (let k = 0; k < index; k++) sum += sizes[k] ?? 0

	return sum
}

function bruteIndexAt(sizes: readonly number[], position: number): number {
	let start = 0

	for (let k = 0; k < sizes.length; k++) {
		const size = sizes[k] ?? 0

		if (position < start + size) return k

		start += size
	}

	return sizes.length - 1
}

function layout(rows: SheetAxisLayout, cols: SheetAxisLayout, pane: SheetLayout["pane"]): SheetLayout {
	return {
		sheet: 0,
		version: 1,
		rowCount: 10,
		colCount: 5,
		rows,
		cols,
		merges: new Uint32Array(0),
		pane,
		zoom: 100,
		gridLines: true,
		headings: true,
		rightToLeft: false,
		protection: null
	}
}

describe("grid axes", () => {
	it("answers offsets, sizes and hit positions as walking every index does, hidden and resized ones included", () => {
		let seed = 7
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31

			return seed / 2 ** 31
		}

		for (let round = 0; round < 40; round++) {
			const count = 1 + Math.floor(random() * 300)
			const entries: [number, number, number][] = []

			for (let index = 0; index < count; index++) {
				if (random() < 0.15) entries.push([index, Math.round(random() * 60), random() < 0.3 ? AxisFlag.HIDDEN : 0])
			}

			const axis = createGridAxis(axisLayout(20, entries), count, 1)
			const sizes = Array.from({ length: count }, (_, index) => {
				const entry = entries.find(item => item[0] === index)

				return entry === undefined ? 20 : entry[2] === AxisFlag.HIDDEN ? 0 : entry[1]
			})

			expect(axis.total).toBe(bruteOffset(sizes, count))

			for (let index = 0; index <= count; index++) expect(axis.offset(index)).toBe(bruteOffset(sizes, index))
			for (let index = 0; index < count; index++) expect(axis.size(index)).toBe(sizes[index])
			for (let position = 0; position < axis.total; position += 3) expect(axis.indexAt(position)).toBe(bruteIndexAt(sizes, position))
		}
	})

	it("scales sizes by the zoom and takes a drag's overrides (NaN back to the default)", () => {
		const base = axisLayout(64, [[2, 100]])
		const zoomed = createGridAxis(base, 10, 1.5)

		expect(zoomed.size(0)).toBe(96)
		expect(zoomed.size(2)).toBe(150)

		const dragged = createGridAxis(
			base,
			10,
			1,
			new Map([
				[2, Number.NaN],
				[5, 30]
			])
		)

		expect(dragged.size(2)).toBe(64)
		expect(dragged.size(5)).toBe(30)
		expect(dragged.offset(6)).toBe(5 * 64 + 30)
	})

	it("answers runs of alike indices as walking every index does, a drag's overrides cutting into them", () => {
		let seed = 11
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31

			return seed / 2 ** 31
		}

		for (let round = 0; round < 60; round++) {
			const count = 1 + Math.floor(random() * 300)
			const starts: number[] = []
			const counts: number[] = []
			const sizes: number[] = []
			const flags: number[] = []
			const truth = Array.from({ length: count + 20 }, () => 20)

			for (let index = 0; index < count + 20;) {
				if (random() < 0.2) {
					const length = 1 + Math.floor(random() * 40)
					const size = Math.round(random() * 60)
					const hidden = random() < 0.4

					starts.push(index)
					counts.push(length)
					sizes.push(size)
					flags.push(hidden ? AxisFlag.HIDDEN : 0)

					for (let k = index; k < index + length && k < truth.length; k++) truth[k] = hidden ? 0 : size

					index += length
				} else {
					index++
				}
			}

			const overrides = new Map<number, number>()

			for (let k = 0; k < 4; k++) {
				const index = Math.floor(random() * count)
				const px = random() < 0.3 ? Number.NaN : Math.round(random() * 50)

				overrides.set(index, px)
			}

			for (const [index, px] of overrides) truth[index] = Number.isNaN(px) ? 20 : px

			const layout: SheetAxisLayout = {
				defaultSize: 20,
				indices: Uint32Array.from(starts),
				sizes: Float32Array.from(sizes),
				styles: new Uint32Array(starts.length),
				flags: Uint16Array.from(flags),
				counts: Uint32Array.from(counts)
			}
			const axis = createGridAxis(layout, count, 1, overrides)
			const expected = truth.slice(0, count)

			expect(axis.total).toBe(bruteOffset(expected, count))

			for (let index = 0; index <= count; index++) expect(axis.offset(index)).toBe(bruteOffset(expected, index))
			for (let index = 0; index < count; index++) expect(axis.size(index)).toBe(expected[index])
			for (let position = 0; position < axis.total; position += 3)
				expect(axis.indexAt(position)).toBe(bruteIndexAt(expected, position))

			let lastShown = count - 1

			while (lastShown >= 0 && expected[lastShown] === 0) lastShown--

			expect(axis.lastShown).toBe(lastShown)
		}
	})

	it("places drawings and finds row styles on runs as on the same indices one by one", () => {
		const runs: SheetAxisLayout = {
			defaultSize: 20,
			indices: Uint32Array.of(3, 10),
			sizes: Float32Array.of(35, 50),
			styles: Uint32Array.of(4, 5),
			flags: Uint16Array.of(0, AxisFlag.HIDDEN),
			counts: Uint32Array.of(4, 3)
		}
		const single = axisLayout(20, [
			[3, 35],
			[4, 35],
			[5, 35],
			[6, 35],
			[10, 50, AxisFlag.HIDDEN],
			[11, 50, AxisFlag.HIDDEN],
			[12, 50, AxisFlag.HIDDEN]
		])
		const a = axisPositions(runs)
		const b = axisPositions(single)

		for (let index = 0; index < 20; index++) {
			expect(a.start(index)).toBe(b.start(index))
			expect(a.size(index)).toBe(b.size(index))
		}

		expect(axisEntry(runs, 5)).toEqual({ style: 4, flags: 0 })
		expect(axisEntry(runs, 7)).toBeNull()
		expect(axisEntry(runs, 12)).toEqual({ style: 5, flags: AxisFlag.HIDDEN })
	})

	it("holds hidden rows to the grid's end as one entry", () => {
		const layout: SheetAxisLayout = {
			...axisLayout(20, [[10, 0, AxisFlag.HIDDEN]]),
			counts: Uint32Array.of(SHEET_MAX_ROWS - 10)
		}
		const axis = createGridAxis(layout, SHEET_MAX_ROWS, 1)

		expect(axis.total).toBe(200)
		expect(axis.lastShown).toBe(9)
		expect(axis.indexAt(199)).toBe(9)
		expect(axis.hidden(SHEET_MAX_ROWS - 1)).toBe(true)
	})

	it("holds a million rows in memory for its exceptions alone and finds the last row", () => {
		const axis = createGridAxis(axisLayout(20, [[5, 0, AxisFlag.HIDDEN]]), SHEET_MAX_ROWS, 1)

		expect(axis.total).toBe((SHEET_MAX_ROWS - 1) * 20)
		expect(axis.indexAt(axis.total - 1)).toBe(SHEET_MAX_ROWS - 1)
		expect(axis.hidden(5)).toBe(true)
		expect(shownIndex(axis, 5, 1)).toBe(6)
		expect(shownIndex(axis, 5, -1)).toBe(4)
	})

	it("steps over hidden runs, default gaps and single 0 px overrides as walking every index does", () => {
		const runs: SheetAxisLayout = {
			...axisLayout(20, [
				[3, 0, AxisFlag.HIDDEN],
				[10, 30],
				[12, 0, AxisFlag.HIDDEN],
				[50_000, 0, AxisFlag.HIDDEN]
			]),
			counts: Uint32Array.of(5, 2, 40_000, 5_000)
		}
		const count = 100_000
		// Row 60,000 dragged to 0 px, row 0 too (the axis's first index).
		const axis = createGridAxis(
			runs,
			count,
			1,
			new Map([
				[60_000, 0],
				[0, 0]
			])
		)
		const brute = (from: number, direction: 1 | -1): number => {
			for (let index = Math.min(from, count - 1); index >= 0 && index < count; index += direction)
				if (axis.size(index) > 0) return index

			return -1
		}

		expect(axis.nextShown?.(12, 1)).toBe(40_012)
		expect(axis.nextShown?.(40_011, -1)).toBe(11)
		expect(axis.nextShown?.(3, 1)).toBe(8)
		expect(axis.nextShown?.(7, -1)).toBe(2)
		expect(axis.nextShown?.(60_000, 1)).toBe(60_001)
		expect(axis.nextShown?.(60_000, -1)).toBe(59_999)
		expect(axis.nextShown?.(54_999, -1)).toBe(49_999)
		expect(axis.nextShown?.(50_000, 1)).toBe(55_000)
		expect(axis.nextShown?.(0, 1)).toBe(1)
		expect(axis.nextShown?.(0, -1)).toBe(-1)
		expect(axis.nextShown?.(count - 1, 1)).toBe(count - 1)
		expect(axis.nextShown?.(count, 1)).toBe(-1)

		for (const from of [
			0,
			1,
			2,
			3,
			7,
			8,
			9,
			10,
			11,
			12,
			30_000,
			40_011,
			40_012,
			49_999,
			50_000,
			55_000,
			59_999,
			60_000,
			60_001,
			count - 1
		])
			for (const direction of [1, -1] as const) expect(shownIndex(axis, from, direction)).toBe(brute(from, direction))
	})

	it("stops at the axis's ends when nothing is shown past a hidden run", () => {
		const axis = createGridAxis({ ...axisLayout(20, [[0, 0, AxisFlag.HIDDEN]]), counts: Uint32Array.of(5) }, 10, 1, new Map([[9, 0]]))

		expect(axis.nextShown?.(0, -1)).toBe(-1)
		expect(axis.nextShown?.(4, -1)).toBe(-1)
		expect(axis.nextShown?.(0, 1)).toBe(5)
		expect(axis.nextShown?.(9, 1)).toBe(-1)
		expect(axis.nextShown?.(9, -1)).toBe(8)
		expect(shownIndex(axis, 9, 1)).toBe(-1)
		expect(shownIndex(axis, 2, -1)).toBe(-1)
	})
})

describe("scaled scrolling", () => {
	it("keeps the scrolled element under the browsers' caps and reaches both ends", () => {
		const virtual = SHEET_MAX_ROWS * 20 * 4
		const view = 800

		expect(domExtent(virtual)).toBe(MAX_SCROLL_PX)
		expect(toVirtual(0, virtual, view)).toBe(0)
		expect(toVirtual(MAX_SCROLL_PX - view, virtual, view)).toBe(virtual - view)

		for (const offset of [0, 1234567, virtual / 2, virtual - view]) {
			const back = toVirtual(toDom(offset, virtual, view), virtual, view)

			// One browser pixel moves at most the scale factor's pixels of sheet.
			expect(Math.abs(back - offset)).toBeLessThanOrEqual(Math.ceil(virtual / MAX_SCROLL_PX))
		}
	})

	it("maps one to one for a stretch at both ends, so a finger's pan there moves the sheet as far as the scroller", () => {
		const virtual = SHEET_MAX_ROWS * 20
		const view = 800
		const domEnd = MAX_SCROLL_PX - view

		for (const dom of [0, 1, 500, 400_000, SCROLL_MARGIN_PX]) {
			expect(toVirtual(dom, virtual, view)).toBe(dom)
			expect(toVirtual(domEnd - dom, virtual, view)).toBe(virtual - view - dom)
			expect(toDom(dom, virtual, view)).toBe(dom)
			expect(toDom(virtual - view - dom, virtual, view)).toBe(domEnd - dom)
		}

		// Monotone and continuous across the scaled middle.
		let last = -1

		for (let dom = 0; dom <= domEnd; dom += 4999) {
			const offset = toVirtual(dom, virtual, view)

			expect(offset).toBeGreaterThanOrEqual(last)
			last = offset
		}
	})

	it("maps one to one under the cap", () => {
		expect(domExtent(5000)).toBe(5000)
		expect(toVirtual(1234, 5000, 600)).toBe(1234)
		expect(toDom(1234, 5000, 600)).toBe(1234)
		expect(toVirtual(9999, 5000, 600)).toBe(4400)
	})
})

describe("grid view", () => {
	const rows = axisLayout(20, [])
	const cols = axisLayout(64, [[1, 0, AxisFlag.HIDDEN]])

	it("places frozen rows and columns before the scrolled ones and hit-tests each part", () => {
		const sheet = layout(rows, cols, { rows: 2, cols: 1, firstRow: 0, firstCol: 0, topRow: 2, leftCol: 1 })
		const axes = { rows: createGridAxis(rows, 200, 1), cols: createGridAxis(cols, 40, 1), scale: 1 }
		const view = gridView(axes, sheet, { top: 100, left: 0 }, 600, 400)

		expect(view.rows.header).toBe(20)
		expect(view.rows.frozen).toBe(2)
		expect(view.rows.first).toBe(7)
		expect(screenOf(view.rows, 0)).toBe(20)
		expect(screenOf(view.rows, 7)).toBe(20 + 40)
		expect(hitAxis(view.rows, 10)).toEqual({ part: "header" })
		expect(hitAxis(view.rows, 25)).toEqual({ part: "frozen", index: 0 })
		expect(hitAxis(view.rows, 61)).toEqual({ part: "body", index: 7 })
		expect(bodyTotal(view.rows)).toBe(200 * 20 - 40)
		// Column 1 is hidden: the scrolled part starts at column 2.
		expect(view.cols.first).toBe(2)
	})

	it("scrolls the least that reveals a cell and leaves frozen ones alone", () => {
		const sheet = layout(rows, cols, { rows: 2, cols: 0, firstRow: 0, firstCol: 0, topRow: 2, leftCol: 0 })
		const axes = { rows: createGridAxis(rows, 200, 1), cols: createGridAxis(cols, 40, 1), scale: 1 }
		const view = gridView(axes, sheet, { top: 0, left: 0 }, 600, 400)

		expect(revealOffset(view.rows, 1)).toBe(0)
		expect(revealOffset(view.rows, 5)).toBe(0)
		// The body shows 400 - 20 - 40 = 340 px: row 30 ends at 31 * 20 - 40.
		expect(revealOffset(view.rows, 30)).toBe(31 * 20 - 40 - 340)
	})

	it("shows a frozen block that starts past the sheet's first row, and the rows above it nowhere", () => {
		// Frozen while scrolled: rows 3 and 4 (0-based) frozen, rows 0-2 not shown, the scrolled part from row 5.
		const sheet = layout(rows, cols, { rows: 2, cols: 0, firstRow: 3, firstCol: 0, topRow: 9, leftCol: 0 })
		const axes = { rows: createGridAxis(rows, 200, 1), cols: createGridAxis(cols, 40, 1), scale: 1 }
		const view = gridView(axes, sheet, { top: 0, left: 0 }, 600, 400)

		expect([view.rows.frozenFirst, view.rows.frozenEnd, view.rows.frozen, view.rows.frozenSize]).toEqual([3, 5, 2, 40])
		expect(view.rows.first).toBe(5)
		expect(screenOf(view.rows, 3)).toBe(20)
		expect(screenOf(view.rows, 4)).toBe(40)
		expect(screenOf(view.rows, 5)).toBe(60)
		expect(hitAxis(view.rows, 25)).toEqual({ part: "frozen", index: 3 })
		expect(hitAxis(view.rows, 61)).toEqual({ part: "body", index: 5 })
		// Rows above the block: none scrolls them into view.
		expect(revealOffset(view.rows, 1)).toBe(0)
		expect(bodyTotal(view.rows)).toBe(200 * 20 - 100)

		const scrolled = gridView(axes, sheet, { top: 80, left: 0 }, 600, 400)

		expect(scrolled.rows.first).toBe(9)
		expect(screenOf(scrolled.rows, 9)).toBe(60)
		expect(edgeAt(scrolled.rows, 21, 4)).toBeNull()
	})

	it("finds the header edge a pointer is on, skipping hidden columns", () => {
		const sheet = layout(rows, cols, null)
		const axes = { rows: createGridAxis(rows, 200, 1), cols: createGridAxis(cols, 40, 1), scale: 1 }
		const view = gridView(axes, sheet, { top: 0, left: 0 }, 600, 400)
		const header = view.cols.header

		// Column 0 ends at header + 64; column 1 is hidden, so the edge before column 2 is column 0's.
		expect(edgeAt(view.cols, header + 63, 4)).toBe(0)
		expect(edgeAt(view.cols, header + 66, 4)).toBe(0)
		expect(edgeAt(view.cols, header + 100, 4)).toBeNull()
	})
})
