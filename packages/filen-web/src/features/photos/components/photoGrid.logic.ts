import { listboxKeyTarget, listboxRange } from "@/features/drive/lib/listbox"
import { drivePreviewSources, type PreviewSource } from "@/features/preview/lib/previewSource"
import type { PhotoItem } from "@/features/photos/lib/captureSort"

export interface TileClickIntent {
	kind: "open" | "select"
}

// A bare pick of the three modifier flags a click event carries — decoupled from React's own
// MouseEvent type so this stays a plain function callers can feed a hand-built object into (see
// photosTileClick.test.ts), the same shape usePhotosSelection's own handlePointerSelect narrows to.
export interface ClickModifiers {
	shiftKey: boolean
	metaKey: boolean
	ctrlKey: boolean
}

// A plain click (no modifier) opens the viewer when the grid has no active selection — the whole
// point of a photos grid is browsing, so the FIRST click on a fresh grid should show the photo, not
// merely highlight its tile. Once ANY selection exists (via a modifier-click or the row menu's own
// "Select" entry — see itemActions.ts), the grid is in selection mode and a plain click reverts to
// the web-wide convention instead: replace the selection with just this item (usePhotosSelection's
// own plain-click branch), exactly matching how a plain click behaves on an already-selected drive
// tile. A modifier held (shift/ctrl/cmd) ALWAYS builds/extends the selection regardless of whether
// one is already active — the one case a click must never open the viewer, mirroring drive's own
// modifier-click-never-opens rule (driveTile.tsx only ever opens on a doubleClick, never a modified
// single one).
export function resolveTileClickIntent(modifiers: ClickModifiers, hasSelection: boolean): TileClickIntent {
	if (modifiers.shiftKey || modifiers.metaKey || modifiers.ctrlKey) {
		return { kind: "select" }
	}

	return { kind: hasSelection ? "select" : "open" }
}

export interface PreviewOpenTarget {
	sources: PreviewSource[]
	index: number
}

// Builds the frozen pager snapshot + starting slot for a tile click at `index` — the WHOLE current
// (already capture-sorted) items array becomes the pager's candidate list, opened at the clicked
// tile's own position within it, mirroring drive's own previewableSiblings + siblingIndex pairing but
// with no extra filter step (a photos listing is already image/video-only by construction, see
// predicate.ts). Returns null for a stale/out-of-range index — a click racing a background refetch
// that shrank the list — rather than opening on a wrong or undefined slot.
export function previewOpenTarget(items: PhotoItem[], index: number): PreviewOpenTarget | null {
	if (index < 0 || index >= items.length) {
		return null
	}

	return { sources: drivePreviewSources(items), index }
}

// The items a shift-extended selection covers: everything between the anchor (or `index` itself when
// there is no live anchor) and `index`, inclusive. One resolver for both entry points —
// modifier-click (usePhotosSelection) and Shift+Arrow (usePhotosGridNav).
export function photosRangeSelection(items: readonly PhotoItem[], anchorUuid: string | null, index: number): PhotoItem[] {
	const anchorIndex = anchorUuid === null ? -1 : items.findIndex(existing => existing.data.uuid === anchorUuid)
	const resolvedAnchor = anchorIndex === -1 ? index : anchorIndex

	return listboxRange(resolvedAnchor, index)
		.map(rangeIndex => items[rangeIndex])
		.filter((rangeItem): rangeItem is PhotoItem => rangeItem !== undefined)
}

export type PhotosGridKeyAction = { kind: "move"; target: number } | { kind: "toggle" } | { kind: "open" } | { kind: "none" }

// The photos grid's key semantics, composed from the shared cursor table: Space toggles the cursor
// item's selection, Enter opens the viewer, arrows/Home/End move the cursor. Always a grid (photos has
// no list mode), so the vertical step is always `columns` and the horizontal axis is always live.
// Select-all/clear-selection are NOT here — they stay registered keymap commands (photoGrid.tsx).
export function photosGridKeyAction(key: string, activeIndex: number, itemCount: number, columns: number): PhotosGridKeyAction {
	if (itemCount === 0) {
		return { kind: "none" }
	}

	if (key === " ") {
		return { kind: "toggle" }
	}

	if (key === "Enter") {
		return { kind: "open" }
	}

	const target = listboxKeyTarget(key, activeIndex, itemCount, columns, true)

	return target === null ? { kind: "none" } : { kind: "move", target }
}
