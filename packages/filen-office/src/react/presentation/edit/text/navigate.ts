import type { ShapeRef } from "../../../../core/presentation/model"
import type { SlideRender } from "../../../../core/presentation/output"

// Keys that leave the body being edited for another one, as PowerPoint's: in a table, Tab and Shift+Tab to the next
// and previous cell in reading order (Tab in the last cell adds a row), Up and Down past the cell's first or last
// line to the cell above or below; Ctrl+Enter to the next title or body placeholder (a new slide on the same layout
// after the last one). The host opens what the editor names.

export type CellMove = "next" | "previous" | "up" | "down"

export type TextNavigation =
	// Another body on this slide: a cell of the same table or a placeholder.
	| { readonly kind: "open"; readonly shape: ShapeRef }
	// A row added at the bottom of `table` (its row count is `at`), then `shape`, its first cell, opened.
	| { readonly kind: "addRow"; readonly table: ShapeRef; readonly at: number; readonly shape: ShapeRef }
	// A new slide after this one on its layout, its first placeholder opened.
	| { readonly kind: "addSlide" }

// The table layer of a frame on the slide in view (a group's member's names the member, its box the group).
function tableOf(render: SlideRender, id: number): NonNullable<SlideRender["layers"][number]["table"]> | undefined {
	for (const layer of render.layers)
		if (layer.table !== undefined && layer.box !== undefined && (layer.box.id === id || layer.shape.id === id)) return layer.table

	return undefined
}

// Index of the merged area (row, col, rows, cols quads, row-major) covering a cell; -1 for none.
function areaIndex(areas: ArrayLike<number>, row: number, col: number): number {
	for (let k = 0; k + 3 < areas.length; k += 4) {
		const r = areas[k] ?? 0
		const c = areas[k + 1] ?? 0

		if (row >= r && row < r + (areas[k + 2] ?? 1) && col >= c && col < c + (areas[k + 3] ?? 1)) return k
	}

	return -1
}

// Where a cell key goes from the cell (row, col) of a table whose merged areas are `areas` and which has `rows` rows:
// an origin cell, "addRow" (Tab in the last cell), or undefined (nothing past the table's edge).
export function cellStep(
	areas: ArrayLike<number>,
	rows: number,
	cell: { readonly row: number; readonly col: number },
	move: CellMove
): { readonly row: number; readonly col: number } | "addRow" | undefined {
	const at = areaIndex(areas, cell.row, cell.col)

	if (at < 0) return undefined

	const origin = (k: number): { row: number; col: number } => ({ row: areas[k] ?? 0, col: areas[k + 1] ?? 0 })

	switch (move) {
		case "next":
			return at + 7 < areas.length ? origin(at + 4) : "addRow"
		case "previous":
			return at >= 4 ? origin(at - 4) : undefined
		case "up":
		case "down": {
			const row = move === "up" ? (areas[at] ?? 0) - 1 : (areas[at] ?? 0) + (areas[at + 2] ?? 1)

			if (row < 0 || row >= rows) return undefined

			const next = areaIndex(areas, row, cell.col)

			return next < 0 ? undefined : origin(next)
		}
	}
}

// What a cell key does from `shape`'s cell on the slide in view; undefined when it goes nowhere.
export function cellNavigation(render: SlideRender | undefined, shape: ShapeRef, move: CellMove): TextNavigation | undefined {
	const cell = shape.cell

	if (render === undefined || cell === undefined) return undefined

	const table = tableOf(render, shape.id)

	if (table === undefined) return undefined

	const rows = table.rowEdges.length - 1
	const step = cellStep(table.areas, rows, cell, move)
	const frame: ShapeRef = { slide: shape.slide, id: shape.id }

	if (step === undefined) return undefined
	if (step === "addRow") return { kind: "addRow", table: frame, at: rows, shape: { ...frame, cell: { row: rows, col: 0 } } }

	return { kind: "open", shape: { ...frame, cell: step } }
}

// The slide's own title and body placeholders, in reading (z) order.
function placeholders(render: SlideRender): number[] {
	const out: number[] = []

	for (const layer of render.layers) {
		const box = layer.box

		if (box?.body === "placeholder" && layer.shape.slide === render.ref && !out.includes(box.id)) out.push(box.id)
	}

	return out
}

export function firstPlaceholder(render: SlideRender): ShapeRef | undefined {
	const id = placeholders(render)[0]

	return id === undefined ? undefined : { slide: render.ref, id }
}

// Ctrl+Enter from `shape`: the next placeholder after it, or a new slide past the last one.
export function placeholderNavigation(render: SlideRender | undefined, shape: ShapeRef): TextNavigation | undefined {
	if (render === undefined || render.ref !== shape.slide) return undefined

	const ids = placeholders(render)
	let after = -1

	// A shape that is not a placeholder goes to the first placeholder after it in z-order.
	for (const layer of render.layers) {
		const id = layer.box?.id

		if (id === shape.id) break
		if (id !== undefined && ids.includes(id)) after = ids.indexOf(id)
	}

	const own = ids.indexOf(shape.id)
	const next = ids[(own >= 0 ? own : after) + 1]

	return next === undefined ? { kind: "addSlide" } : { kind: "open", shape: { slide: render.ref, id: next } }
}
