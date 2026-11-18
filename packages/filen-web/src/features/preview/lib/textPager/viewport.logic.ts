// The large text viewer's window onto its rows: the rows it holds (a few screens around what shows), the first row
// shown and how far it is scrolled past. Scrolling moves within the held rows; more are asked for near either end, and
// what lies far from the view is dropped, so the page holds a bounded number of rows however far it scrolls.

export interface WindowRow {
	readonly start: number
	readonly end: number
	readonly breaks: boolean
	readonly line: number | null
}

export interface PagerWindow<Row extends WindowRow> {
	readonly rows: readonly Row[]
	// The first row shown, and the pixels of it scrolled out of view.
	readonly top: number
	readonly shift: number
}

export interface WindowBounds {
	// The text's first byte (past a byte order mark) and the file's size.
	readonly start: number
	readonly size: number
	readonly rowHeight: number
	// The view's height in pixels.
	readonly height: number
}

// Rows the view shows, the last perhaps in part.
export function visibleRows(bounds: Pick<WindowBounds, "rowHeight" | "height">): number {
	return Math.max(1, Math.ceil(bounds.height / bounds.rowHeight) + 1)
}

// Rows the view shows whole.
export function wholeRows(bounds: Pick<WindowBounds, "rowHeight" | "height">): number {
	return Math.max(1, Math.floor(bounds.height / bounds.rowHeight))
}

// Rows held at most: the view and two screens either side.
export function maxHeldRows(bounds: Pick<WindowBounds, "rowHeight" | "height">): number {
	return visibleRows(bounds) * 5
}

function atEnd(rows: readonly WindowRow[], bounds: WindowBounds): boolean {
	return (rows.at(-1)?.end ?? bounds.size) >= bounds.size
}

// The window scrolled by `delta` pixels, kept within its rows: never above the first, and never past the file's last
// row at the view's bottom (nor past the last held row until more arrive).
export function scrollWindow<Row extends WindowRow>(window: PagerWindow<Row>, delta: number, bounds: WindowBounds): PagerWindow<Row> {
	const { rowHeight, height } = bounds
	const total = window.rows.length * rowHeight
	const max = atEnd(window.rows, bounds) ? Math.max(0, total - height) : Math.max(0, total - rowHeight)
	const position = Math.min(max, Math.max(0, window.top * rowHeight + window.shift + delta))
	const top = Math.floor(position / rowHeight)

	return { ...window, top, shift: position - top * rowHeight }
}

// A window over freshly located rows with `focus` near the top, `before` rows above it where there are, and the file's
// end never above the view's bottom.
export function placedWindow<Row extends WindowRow>(
	rows: readonly Row[],
	focus: number,
	before: number,
	bounds: WindowBounds
): PagerWindow<Row> {
	const top = Math.max(0, focus - before)

	return atEnd(rows, bounds)
		? { rows, top: Math.min(top, Math.max(0, rows.length - wholeRows(bounds))), shift: 0 }
		: { rows, top, shift: 0 }
}

// Whether the file's last row shows whole: held, and its bottom at or above the view's.
export function showsEnd(window: PagerWindow<WindowRow>, bounds: WindowBounds): boolean {
	return (
		atEnd(window.rows, bounds) &&
		window.rows.length * bounds.rowHeight - (window.top * bounds.rowHeight + window.shift) <= bounds.height
	)
}

// Whether the window wants rows above it, or below.
export function wantsBefore(window: PagerWindow<WindowRow>, bounds: WindowBounds): boolean {
	const first = window.rows[0]

	return first !== undefined && first.start > bounds.start && window.top < visibleRows(bounds)
}

export function wantsAfter(window: PagerWindow<WindowRow>, bounds: WindowBounds): boolean {
	return window.rows.length > 0 && !atEnd(window.rows, bounds) && window.rows.length - window.top < 2 * visibleRows(bounds)
}

// `more` rows ending where the window's first starts, prepended; rows far below the view are dropped.
export function prependRows<Row extends WindowRow>(window: PagerWindow<Row>, more: readonly Row[], bounds: WindowBounds): PagerWindow<Row> {
	const rows = [...more, ...window.rows]
	const top = window.top + more.length
	const keep = Math.max(maxHeldRows(bounds), top + 2 * visibleRows(bounds))

	return { rows: rows.slice(0, keep), top, shift: window.shift }
}

// `more` rows starting where the window's last ends, appended; rows far above the view are dropped.
export function appendRows<Row extends WindowRow>(window: PagerWindow<Row>, more: readonly Row[], bounds: WindowBounds): PagerWindow<Row> {
	const rows = [...window.rows, ...more]
	const drop = Math.max(0, Math.min(window.top - visibleRows(bounds), rows.length - maxHeldRows(bounds)))

	return { rows: drop === 0 ? rows : rows.slice(drop), top: window.top - drop, shift: window.shift }
}

// The rows with their lines from `first` (the first row's), each kept only where the counted prefix (to `frontier`)
// reaches it. The rows themselves (their cuts) stay as they are.
export function numberRows<Row extends WindowRow>(rows: readonly Row[], first: number | null, frontier: number): Row[] {
	let line = first

	return rows.map(row => {
		const numbered = { ...row, line: line !== null && row.start < frontier ? line : null }

		line = line === null ? null : line + (row.breaks ? 1 : 0)

		return numbered
	})
}

// The line the row after `row` is on.
export function nextLine(row: WindowRow): number | null {
	return row.line === null ? null : row.line + (row.breaks ? 1 : 0)
}

// The view's position for the status (its first row's offset, the file's size once its end shows).
export interface PositionStore {
	readonly get: () => number
	readonly set: (offset: number) => void
	readonly subscribe: (listener: () => void) => () => void
}

export function positionStore(): PositionStore {
	let value = 0
	const listeners = new Set<() => void>()

	return {
		get: () => value,
		set: offset => {
			if (offset !== value) {
				value = offset

				for (const listener of listeners) listener()
			}
		},
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		}
	}
}
