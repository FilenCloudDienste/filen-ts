import type { MarqueeContentRect } from "@/features/drive/lib/marquee.logic"

// The photos grid as virtual rows: a header per capture month, then that month's tiles in rows of
// `columns`. Every size is known up front (a header is TIMELINE_HEADER_HEIGHT, a tile row is one cell
// tall), so offsets are computed here rather than measured, and the virtualizer, the marquee and the
// scrubber all read the same numbers.

export const TIMELINE_HEADER_HEIGHT = 40

export type TimelineRow =
	{ kind: "header"; key: string; year: number; month: number } | { kind: "tiles"; key: string; start: number; end: number }

export interface PhotosTimeline {
	rows: TimelineRow[]
	// Content-space top of each row; rows are separated by `gap`.
	rowStarts: number[]
	// The tile row each item sits in.
	rowOfItem: number[]
	totalSize: number
	columns: number
	cellSize: number
	gap: number
}

export interface TimelineDate {
	year: number
	// 0-11
	month: number
}

export function timelineRowSize(timeline: PhotosTimeline, row: TimelineRow): number {
	return row.kind === "header" ? TIMELINE_HEADER_HEIGHT : timeline.cellSize
}

// `dates` runs parallel to the (capture-sorted) items, so each month is one contiguous run.
export function buildPhotosTimeline(dates: readonly TimelineDate[], columns: number, cellSize: number, gap: number): PhotosTimeline {
	const rows: TimelineRow[] = []
	const rowStarts: number[] = []
	const rowOfItem = new Array<number>(dates.length)
	let offset = 0

	const push = (row: TimelineRow): void => {
		if (rows.length > 0) {
			offset += gap
		}

		rows.push(row)
		rowStarts.push(offset)
		offset += row.kind === "header" ? TIMELINE_HEADER_HEIGHT : cellSize
	}

	let index = 0

	while (index < dates.length) {
		const first = dates[index]

		if (first === undefined) {
			break
		}

		let groupEnd = index + 1

		while (groupEnd < dates.length && dates[groupEnd]?.year === first.year && dates[groupEnd]?.month === first.month) {
			groupEnd++
		}

		const monthKey = `${String(first.year)}-${String(first.month)}`

		push({ kind: "header", key: `h:${monthKey}`, year: first.year, month: first.month })

		for (let start = index; start < groupEnd; start += columns) {
			const end = Math.min(start + columns, groupEnd)

			for (let item = start; item < end; item++) {
				rowOfItem[item] = rows.length
			}

			push({ kind: "tiles", key: `t:${monthKey}:${String((start - index) / columns)}`, start, end })
		}

		index = groupEnd
	}

	return { rows, rowStarts, rowOfItem, totalSize: offset, columns, cellSize, gap }
}

function nextTileRow(timeline: PhotosTimeline, from: number, step: 1 | -1): Extract<TimelineRow, { kind: "tiles" }> | null {
	for (let rowIndex = from + step; rowIndex >= 0 && rowIndex < timeline.rows.length; rowIndex += step) {
		const row = timeline.rows[rowIndex]

		if (row?.kind === "tiles") {
			return row
		}
	}

	return null
}

// Arrow keys move by what is on screen: up/down to the same column of the tile row above or below,
// across a month header, onto that row's last tile when it is shorter. Past the first or last row the
// cursor lands on the first or last item, as the drive grid's clamp does. Left/right, Home and End
// walk the capture order.
export function timelineKeyTarget(key: string, activeIndex: number, itemCount: number, timeline: PhotosTimeline): number | null {
	if (key === "ArrowRight") {
		return activeIndex + 1
	}

	if (key === "ArrowLeft") {
		return activeIndex - 1
	}

	if (key === "Home") {
		return 0
	}

	if (key === "End") {
		return itemCount - 1
	}

	if (key !== "ArrowDown" && key !== "ArrowUp") {
		return null
	}

	const step = key === "ArrowDown" ? 1 : -1
	const rowIndex = timeline.rowOfItem[activeIndex]
	const row = rowIndex === undefined ? undefined : timeline.rows[rowIndex]

	if (rowIndex === undefined || row?.kind !== "tiles") {
		return activeIndex + step * timeline.columns
	}

	const target = nextTileRow(timeline, rowIndex, step)

	if (target === null) {
		return step === 1 ? itemCount - 1 : 0
	}

	return Math.min(target.start + (activeIndex - row.start), target.end - 1)
}

// First row whose bottom edge lies below `y`.
function firstRowEndingAfter(timeline: PhotosTimeline, y: number): number {
	let low = 0
	let high = timeline.rows.length

	while (low < high) {
		const mid = (low + high) >>> 1
		const row = timeline.rows[mid]
		const start = timeline.rowStarts[mid] ?? 0

		if (row !== undefined && start + timelineRowSize(timeline, row) <= y) {
			low = mid + 1
		} else {
			high = mid
		}
	}

	return low
}

function cellWidthFor(timeline: PhotosTimeline, contentWidth: number): number {
	return (contentWidth - timeline.gap * (timeline.columns - 1)) / timeline.columns
}

// The items whose tile box the marquee rectangle overlaps, ascending. Headers and gutters select
// nothing.
export function timelineMarqueeIndices(rect: MarqueeContentRect, timeline: PhotosTimeline, contentWidth: number): number[] {
	if (contentWidth <= 0 || timeline.columns <= 0) {
		return []
	}

	const cellWidth = cellWidthFor(timeline, contentWidth)
	const out: number[] = []

	for (let rowIndex = firstRowEndingAfter(timeline, rect.top); rowIndex < timeline.rows.length; rowIndex++) {
		const row = timeline.rows[rowIndex]
		const start = timeline.rowStarts[rowIndex] ?? 0

		if (row === undefined || start >= rect.bottom) {
			break
		}

		if (row.kind !== "tiles") {
			continue
		}

		for (let item = row.start; item < row.end; item++) {
			const left = (item - row.start) * (cellWidth + timeline.gap)

			if (rect.left < left + cellWidth && rect.right > left) {
				out.push(item)
			}
		}
	}

	return out
}

// The item whose tile is under a content-space point, or -1.
export function timelineIndexAtPoint(x: number, y: number, timeline: PhotosTimeline, contentWidth: number): number {
	if (x < 0 || y < 0 || contentWidth <= 0 || timeline.columns <= 0) {
		return -1
	}

	const rowIndex = firstRowEndingAfter(timeline, y)
	const row = timeline.rows[rowIndex]
	const start = timeline.rowStarts[rowIndex] ?? 0

	if (row?.kind !== "tiles" || y < start) {
		return -1
	}

	const cellWidth = cellWidthFor(timeline, contentWidth)
	const column = Math.floor(x / (cellWidth + timeline.gap))

	if (x - column * (cellWidth + timeline.gap) > cellWidth) {
		return -1
	}

	const item = row.start + column

	return item < row.end ? item : -1
}

// The month header row at or above a content offset: what the scrubber names while it is dragged.
export function timelineHeaderAt(timeline: PhotosTimeline, y: number): Extract<TimelineRow, { kind: "header" }> | null {
	for (let rowIndex = Math.min(firstRowEndingAfter(timeline, y), timeline.rows.length - 1); rowIndex >= 0; rowIndex--) {
		const row = timeline.rows[rowIndex]

		if (row?.kind === "header") {
			return row
		}
	}

	return null
}

export interface TimelineYearMark {
	year: number
	// Content offset of the year's newest month header.
	offset: number
}

export function timelineYearMarks(timeline: PhotosTimeline): TimelineYearMark[] {
	const marks: TimelineYearMark[] = []

	for (const [rowIndex, row] of timeline.rows.entries()) {
		if (row.kind === "header" && marks[marks.length - 1]?.year !== row.year) {
			marks.push({ year: row.year, offset: timeline.rowStarts[rowIndex] ?? 0 })
		}
	}

	return marks
}

const monthFormats = new Map<string, Intl.DateTimeFormat>()

// "July 2023" in the UI language.
export function formatTimelineMonth(locale: string, year: number, month: number): string {
	let format = monthFormats.get(locale)

	if (format === undefined) {
		format = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" })
		monthFormats.set(locale, format)
	}

	return format.format(new Date(year, month, 1))
}
