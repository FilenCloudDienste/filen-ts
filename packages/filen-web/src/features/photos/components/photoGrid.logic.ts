import { isSelectionGesture, listboxRangeItems, touchTapIntent, type ClickModifiers } from "@/features/drive/lib/listbox"
import { type DriveItem } from "@/features/drive/lib/item"
import type { PhotoItem } from "@/features/photos/lib/captureSort"
import { timelineKeyTarget, type PhotosTimeline } from "@/features/photos/lib/timeline"

export interface TileClickIntent {
	kind: "open" | "select" | "toggle"
}

// A plain click (no modifier) opens the viewer when the grid has no active selection — the whole
// point of a photos grid is browsing, so the FIRST click on a fresh grid should show the photo, not
// merely highlight its tile. Once ANY selection exists (via a modifier-click or the row menu's own
// "Select" entry — see itemActions.ts), the grid is in selection mode and a plain click reverts to
// the web-wide convention instead: replace the selection with just this item (photosPointerSelect's
// own plain-click branch), exactly matching how a plain click behaves on an already-selected drive
// tile. A modifier held (shift/ctrl/cmd) ALWAYS builds/extends the selection regardless of whether
// one is already active — the one case a click must never open the viewer, mirroring drive's own
// modifier-click-never-opens rule (driveTile.tsx only ever opens on a doubleClick, never a modified
// single one). A touch tap opens the same way but toggles in selection mode (touchTapIntent), where a
// click would replace the selection.
export function resolveTileClickIntent(modifiers: ClickModifiers, hasSelection: boolean, pointerType: string): TileClickIntent {
	if (touchTapIntent(pointerType, modifiers, hasSelection ? 1 : 0) === "toggle") {
		return { kind: "toggle" }
	}

	if (isSelectionGesture(modifiers)) {
		return { kind: "select" }
	}

	return { kind: hasSelection ? "select" : "open" }
}

export interface PreviewOpenTarget {
	sources: DriveItem[]
	index: number
}

// Builds the frozen pager snapshot + starting slot for a tile click at `index` — the WHOLE current
// (already capture-sorted) items array becomes the pager's candidate list as-is (never mutated, so no
// copy), opened at the clicked tile's own position within it, mirroring drive's own previewableSiblings
// + siblingIndex pairing but with no extra filter step (a photos listing is already image/video-only by
// construction, see predicate.ts). Returns null for a stale/out-of-range index — a click racing a background refetch
// that shrank the list — rather than opening on a wrong or undefined slot.
export function previewOpenTarget(items: PhotoItem[], index: number): PreviewOpenTarget | null {
	if (index < 0 || index >= items.length) {
		return null
	}

	return { sources: items, index }
}

// The items a shift-extended selection covers: everything between the anchor (or `index` itself when
// there is no live anchor) and `index`, inclusive. One resolver for both entry points —
// modifier-click (photosPointerSelect) and Shift+Arrow (usePhotosGridNav).
export function photosRangeSelection(items: readonly PhotoItem[], anchorUuid: string | null, index: number): PhotoItem[] {
	const anchorIndex = anchorUuid === null ? -1 : items.findIndex(existing => existing.data.uuid === anchorUuid)
	const resolvedAnchor = anchorIndex === -1 ? index : anchorIndex

	return listboxRangeItems(items, resolvedAnchor, index)
}

export type PhotosGridKeyAction = { kind: "move"; target: number } | { kind: "toggle" } | { kind: "open" } | { kind: "none" }

// The photos grid's key semantics: Space toggles the cursor item's selection, Enter opens the viewer,
// arrows/Home/End move the cursor over the month timeline (timelineKeyTarget). Select-all/clear-selection
// are NOT here — they stay registered keymap commands (photoGrid.tsx).
export function photosGridKeyAction(key: string, activeIndex: number, itemCount: number, timeline: PhotosTimeline): PhotosGridKeyAction {
	if (itemCount === 0) {
		return { kind: "none" }
	}

	if (key === " ") {
		return { kind: "toggle" }
	}

	if (key === "Enter") {
		return { kind: "open" }
	}

	const target = timelineKeyTarget(key, activeIndex, itemCount, timeline)

	return target === null ? { kind: "none" } : { kind: "move", target }
}
