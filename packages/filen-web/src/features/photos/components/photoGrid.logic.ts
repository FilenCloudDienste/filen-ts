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
