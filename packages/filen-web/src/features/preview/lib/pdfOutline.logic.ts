import type { PdfOutlineItem } from "@filen/office/dom/pdf"

// The outline pane's tree over the flattened outline (loadPdfOutline: reading order, each item's depth): which rows
// show under the collapsed ones, how the arrow keys move, which rows' destinations to resolve (the rows on screen and a
// margin, never the rest), and the section the current page is in.

// Rows past the ones on screen whose destinations are resolved too, each way.
export const OUTLINE_RESOLVE_MARGIN = 20

export function hasChildren(items: readonly PdfOutlineItem[], index: number): boolean {
	const item = items[index]
	const next = items[index + 1]

	return item !== undefined && next !== undefined && next.depth > item.depth
}

// The items shown (their indexes into `items`): every item but the descendants of a collapsed one.
export function visibleRows(items: readonly PdfOutlineItem[], collapsed: ReadonlySet<number>): number[] {
	const rows: number[] = []
	let hiddenBelow = Number.POSITIVE_INFINITY

	items.forEach((item, index) => {
		if (item.depth > hiddenBelow) return

		hiddenBelow = Number.POSITIVE_INFINITY
		rows.push(index)

		if (collapsed.has(index) && hasChildren(items, index)) hiddenBelow = item.depth
	})

	return rows
}

// The item a row's parent is (the nearest earlier item one level up), or null at the top level.
export function parentOf(items: readonly PdfOutlineItem[], index: number): number | null {
	const depth = items[index]?.depth ?? 0

	for (let at = index - 1; at >= 0; at--) {
		if ((items[at]?.depth ?? 0) < depth) return at
	}

	return null
}

// The rows whose destinations want resolving: those from `first` to `last` (positions in `rows`) and the margin, not
// resolved yet.
export function rowsToResolve(
	rows: readonly number[],
	first: number,
	last: number,
	resolved: ReadonlyMap<number, number | null>
): number[] {
	const from = Math.max(0, first - OUTLINE_RESOLVE_MARGIN)
	const to = Math.min(rows.length - 1, last + OUTLINE_RESOLVE_MARGIN)
	const wanted: number[] = []

	for (let at = from; at <= to; at++) {
		const index = rows[at]

		if (index !== undefined && !resolved.has(index)) wanted.push(index)
	}

	return wanted
}

// The section `page` (1-based) is in: of the items resolved, the last in reading order whose page is at or before it.
export function currentSection(resolved: ReadonlyMap<number, number | null>, page: number): number | null {
	let best: number | null = null
	let bestPage = 0

	for (const [index, target] of resolved) {
		if (target === null || target > page) continue

		if (best === null || target > bestPage || (target === bestPage && index > best)) {
			best = index
			bestPage = target
		}
	}

	return best
}

export type OutlineKey = "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End"

// Where a tree key moves the focus (an item index), or a collapse/expand of the focused one; null when it does nothing.
export function outlineKeyMove(
	items: readonly PdfOutlineItem[],
	rows: readonly number[],
	collapsed: ReadonlySet<number>,
	focused: number,
	key: OutlineKey
): { readonly kind: "focus"; readonly index: number } | { readonly kind: "collapse" | "expand"; readonly index: number } | null {
	const at = rows.indexOf(focused)

	switch (key) {
		case "ArrowDown": {
			const next = rows[at + 1]

			return next === undefined ? null : { kind: "focus", index: next }
		}
		case "ArrowUp": {
			const previous = at > 0 ? rows[at - 1] : undefined

			return previous === undefined ? null : { kind: "focus", index: previous }
		}
		case "Home": {
			const first = rows[0]

			return first === undefined || first === focused ? null : { kind: "focus", index: first }
		}
		case "End": {
			const last = rows.at(-1)

			return last === undefined || last === focused ? null : { kind: "focus", index: last }
		}
		case "ArrowRight":
			if (!hasChildren(items, focused)) return null

			return collapsed.has(focused) ? { kind: "expand", index: focused } : { kind: "focus", index: focused + 1 }
		case "ArrowLeft": {
			if (hasChildren(items, focused) && !collapsed.has(focused)) return { kind: "collapse", index: focused }

			const parent = parentOf(items, focused)

			return parent === null ? null : { kind: "focus", index: parent }
		}
	}
}

// Each item's place among its siblings (the items under the same parent): aria-posinset (1-based) and aria-setsize, which
// a virtualized tree has to state as only some rows are in the DOM.
export function outlinePositions(items: readonly PdfOutlineItem[]): { readonly posInSet: number; readonly setSize: number }[] {
	// Each parent's sibling count so far; an item's position is the count once it is added, so one pass is linear.
	const sizes = new Map<number, number>()
	const groupOf: number[] = []
	const posInSet: number[] = []
	const parents: number[] = []

	items.forEach((item, index) => {
		parents.length = item.depth
		const parent = item.depth > 0 ? (parents[item.depth - 1] ?? -1) : -1
		const size = (sizes.get(parent) ?? 0) + 1

		sizes.set(parent, size)
		groupOf.push(parent)
		posInSet.push(size)
		parents[item.depth] = index
	})

	return items.map((_, index) => ({ posInSet: posInSet[index] ?? 1, setSize: sizes.get(groupOf[index] ?? -1) ?? 1 }))
}

// What the Outline key does: toggle the viewer's pane, show the editor's rail on its Outline tab, or nothing where
// that would not show (the pane is hidden below sm, the rail below md) and must not be saved as open either.
export function outlineKeyTarget({
	hasOutline,
	editing,
	paneShows,
	railShows
}: {
	readonly hasOutline: boolean
	readonly editing: boolean
	readonly paneShows: boolean
	readonly railShows: boolean
}): "pane" | "rail" | "none" {
	if (!hasOutline) return "none"
	if (editing) return railShows ? "rail" : "none"

	return paneShows ? "pane" : "none"
}
