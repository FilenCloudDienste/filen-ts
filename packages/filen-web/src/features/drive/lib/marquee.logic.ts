import { type DriveViewMode } from "@/features/drive/lib/preferences"

// Pure rect→index-range math for the drive listing's rubber-band selection. Kept DOM-free: the listing
// is virtualized, so unmounted rows/tiles have no boxes to hit-test against — selection through
// scrolled-away regions is computed in ITEM SPACE from the virtualizer's own geometry (row height /
// grid column math) plus scrollTop, and that math lives here so it is exhaustively unit-testable.

// A rectangle in CONTENT coordinates (0 = top/left of the scrollable content, not the viewport). The
// marquee is anchored in content space so it stretches correctly while the listing auto-scrolls.
export interface MarqueeContentRect {
	top: number
	bottom: number
	left: number
	right: number
}

// Normalizes two content-space points (drag anchor + current pointer) into a rect with top<=bottom and
// left<=right, regardless of drag direction.
export function marqueeRectFromPoints(ax: number, ay: number, bx: number, by: number): MarqueeContentRect {
	return {
		top: Math.min(ay, by),
		bottom: Math.max(ay, by),
		left: Math.min(ax, bx),
		right: Math.max(ax, bx)
	}
}

// List mode: each row is a full-width band of `rowHeight`. A row intersects when the rect's vertical
// span overlaps the row's [i*h,(i+1)*h) band — an edge-touch (rect ending exactly on a boundary) never
// reaches into the next row. A plain click never selects because the hook only starts marqueeing past a
// small drag threshold, not because of this math. Horizontal extent is irrelevant: rows span full width.
export function marqueeListIndices(rect: MarqueeContentRect, itemCount: number, rowHeight: number): number[] {
	if (itemCount === 0 || rowHeight <= 0 || rect.bottom <= 0 || rect.top >= itemCount * rowHeight) {
		return []
	}

	const first = Math.max(0, Math.floor(rect.top / rowHeight))
	const last = Math.min(itemCount - 1, Math.ceil(rect.bottom / rowHeight) - 1)

	if (first > last) {
		return []
	}

	const out: number[] = []

	for (let i = first; i <= last; i++) {
		out.push(i)
	}

	return out
}

// Grid mode: item i sits at (row = floor(i/cols), col = i%cols). Rows are `rowHeight` bands like list.
// Within a row each tile is a fixed `tileWidth` box centered in its column cell (cellWidth =
// contentWidth/cols), so a rect falling entirely in a between-tile gutter selects nothing in that
// column — hit-test each candidate cell's ACTUAL tile box, not the whole cell. The last grid row can be
// partial: an index past itemCount is skipped.
export function marqueeGridIndices(
	rect: MarqueeContentRect,
	itemCount: number,
	columns: number,
	contentWidth: number,
	tileWidth: number,
	rowHeight: number
): number[] {
	if (itemCount === 0 || columns <= 0 || rowHeight <= 0 || contentWidth <= 0 || rect.bottom <= 0) {
		return []
	}

	const rowCount = Math.ceil(itemCount / columns)

	if (rect.top >= rowCount * rowHeight) {
		return []
	}

	const firstRow = Math.max(0, Math.floor(rect.top / rowHeight))
	const lastRow = Math.min(rowCount - 1, Math.ceil(rect.bottom / rowHeight) - 1)

	if (firstRow > lastRow) {
		return []
	}

	const cellWidth = contentWidth / columns
	// columns is floor(contentWidth/tileWidth) upstream, so cellWidth >= tileWidth normally; clamp for
	// the forced-single-column case where the container is narrower than one tile.
	const boxWidth = Math.min(tileWidth, cellWidth)
	const inset = Math.max(0, (cellWidth - tileWidth) / 2)
	const out: number[] = []

	for (let row = firstRow; row <= lastRow; row++) {
		for (let col = 0; col < columns; col++) {
			const index = row * columns + col

			if (index >= itemCount) {
				break
			}

			const tileLeft = col * cellWidth + inset
			const tileRight = tileLeft + boxWidth

			if (rect.left < tileRight && rect.right > tileLeft) {
				out.push(index)
			}
		}
	}

	return out
}

// Dispatches to the mode-specific hit-test. `columns`/`contentWidth`/`tileWidth` are ignored in list
// mode. Returns ascending indices.
export function marqueeIndices(
	rect: MarqueeContentRect,
	itemCount: number,
	viewMode: DriveViewMode,
	columns: number,
	contentWidth: number,
	tileWidth: number,
	rowHeight: number
): number[] {
	return viewMode === "list"
		? marqueeListIndices(rect, itemCount, rowHeight)
		: marqueeGridIndices(rect, itemCount, columns, contentWidth, tileWidth, rowHeight)
}

// The single item index under a content-space point, or -1 for a gutter / empty cell / out of range.
// Moves the roving cursor to where the drag ended (mirrors click-selection setting the cursor to the
// clicked item). `rowHeight` is the mode's row band (ROW_HEIGHT list, TILE_ROW_HEIGHT grid).
export function marqueeIndexAtPoint(
	x: number,
	y: number,
	itemCount: number,
	viewMode: DriveViewMode,
	columns: number,
	contentWidth: number,
	tileWidth: number,
	rowHeight: number
): number {
	if (itemCount === 0 || rowHeight <= 0 || y < 0) {
		return -1
	}

	const row = Math.floor(y / rowHeight)

	if (viewMode === "list") {
		return row < itemCount ? row : -1
	}

	if (columns <= 0 || contentWidth <= 0 || x < 0) {
		return -1
	}

	const cellWidth = contentWidth / columns
	const col = Math.floor(x / cellWidth)

	if (col >= columns) {
		return -1
	}

	const boxWidth = Math.min(tileWidth, cellWidth)
	const inset = Math.max(0, (cellWidth - tileWidth) / 2)
	const tileLeft = col * cellWidth + inset
	const tileRight = tileLeft + boxWidth

	if (x < tileLeft || x > tileRight) {
		return -1
	}

	const index = row * columns + col

	return index < itemCount ? index : -1
}

// Signed px/frame the scroll container should advance when the pointer nears its top/bottom edge while
// marqueeing. Negative = scroll up, positive = down, 0 = outside both edge zones. Magnitude ramps
// linearly with proximity, capped at `maxSpeed`; a pointer past the edge (outside the container) pins to
// full speed. `clientY`/`top`/`height` are viewport-space (the container's own getBoundingClientRect).
export function marqueeAutoScrollVelocity(clientY: number, top: number, height: number, edge: number, maxSpeed: number): number {
	if (edge <= 0 || height <= 0) {
		return 0
	}

	const distTop = clientY - top
	const distBottom = top + height - clientY

	if (distTop < edge) {
		const ratio = Math.min(1, Math.max(0, (edge - distTop) / edge))

		return -ratio * maxSpeed
	}

	if (distBottom < edge) {
		const ratio = Math.min(1, Math.max(0, (edge - distBottom) / edge))

		return ratio * maxSpeed
	}

	return 0
}
