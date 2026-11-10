import { useState, type KeyboardEvent } from "react"
import { type Virtualizer } from "@tanstack/react-virtual"
import { useRovingItemRefs } from "@/features/drive/hooks/useRovingItemRefs"
import { clampListboxIndex, listboxKeyTargetIsInteractive, resolveCursorIndex } from "@/features/drive/lib/listbox"
import { photosGridKeyAction, photosRangeSelection } from "@/features/photos/components/photoGrid.logic"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { type PhotosTimeline } from "@/features/photos/lib/timeline"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { hasCommandModifier } from "@/lib/rowKeys"

interface UsePhotosGridNavParams {
	items: PhotoItem[]
	timeline: PhotosTimeline
	virtualizer: Pick<Virtualizer<HTMLDivElement, Element>, "scrollToIndex">
	anchorUuid: string | null
	setAnchorUuid: (uuid: string | null) => void
}

export interface PhotosGridNav {
	safeActiveIndex: number
	handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
	registerRef: (index: number, el: HTMLDivElement | null) => void
	// Cursor only — what a pointer click moves (the anchor stays owned by photosPointerSelect).
	setActive: (index: number) => void
	// Cursor AND anchor — what a marquee drag-end moves, mirroring drive's own setCursor.
	setCursor: (index: number) => void
	// Cursor and anchor, scrolled to and focused — what a keyboard jump (a month) moves.
	moveTo: (index: number) => void
	resetCursor: () => void
}

// Roving-tabindex keyboard operability for the photos grid: the cursor, arrow/Home/End/PageUp/PageDown movement
// over the month timeline, Space toggle and Shift+Arrow range extension. Purpose-built and grid-only — photos has
// no list mode, no nested navigation, no drag-and-drop ancestry guard and no per-variant reset, so
// this is deliberately not a port of useDriveListboxNav. Open, select-all, clear-selection and the month jumps
// (Shift+PageUp/PageDown) are NOT handled here — they are registered keymap commands (photoGrid.tsx).
export function usePhotosGridNav({ items, timeline, virtualizer, anchorUuid, setAnchorUuid }: UsePhotosGridNavParams): PhotosGridNav {
	// Tracked by item identity (uuid), not position — a positional index alone drifts under a
	// background refetch that reorders the grid, silently retargeting Enter onto the wrong photo.
	const [activeUuid, setActiveUuid] = useState<string | null>(null)
	// The last position the cursor actually resolved to — what resolveCursorIndex falls back to once
	// its uuid is gone from `items`. Adjusted during render (React's documented alternative to an
	// effect), never in an effect body.
	const [activeFallback, setActiveFallback] = useState(0)
	const { registerRef, focusItem } = useRovingItemRefs()

	const uuids = items.map(item => item.data.uuid)
	const safeActiveIndex = clampListboxIndex(resolveCursorIndex(activeUuid, uuids, activeFallback), items.length)

	if (activeFallback !== safeActiveIndex) {
		setActiveFallback(safeActiveIndex)
	}

	function moveActive(nextIndexRaw: number): number {
		const next = clampListboxIndex(nextIndexRaw, items.length)

		setActiveUuid(items[next]?.data.uuid ?? null)
		virtualizer.scrollToIndex(timeline.rowOfItem[next] ?? 0, { align: "auto" })
		focusItem(next)

		return next
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		// A tile's menus are portaled out of the grid but stay its React descendants, so a menu item's
		// key bubbles here too; and the tile's ⋯ trigger owns its own Space (see
		// listboxKeyTargetIsInteractive). Neither is the grid's.
		if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target) || listboxKeyTargetIsInteractive(event.target)) {
			return
		}

		// Ctrl, Cmd or Alt make the key some shortcut's; Shift extends a range with an arrow, toggles nothing, and with
		// PageUp/PageDown is the month jump's.
		if (hasCommandModifier(event) || (event.shiftKey && (event.key === "PageUp" || event.key === "PageDown"))) {
			return
		}

		const action = photosGridKeyAction(event.key, safeActiveIndex, items.length, timeline, event.currentTarget.clientHeight)

		if (action.kind === "none" || (action.kind === "toggle" && event.shiftKey)) {
			return
		}

		event.preventDefault()

		if (action.kind === "toggle") {
			const item = items[safeActiveIndex]

			if (item) {
				usePhotosStore.getState().toggleSelectedItem(item)
				setAnchorUuid(item.data.uuid)
			}

			return
		}

		const next = moveActive(action.target)

		if (event.shiftKey) {
			usePhotosStore.getState().setSelectedItems(photosRangeSelection(items, anchorUuid, next))
		} else {
			setAnchorUuid(items[next]?.data.uuid ?? null)
		}
	}

	function setActive(index: number): void {
		setActiveUuid(items[clampListboxIndex(index, items.length)]?.data.uuid ?? null)
	}

	function setCursor(index: number): void {
		const uuid = items[clampListboxIndex(index, items.length)]?.data.uuid ?? null

		setActiveUuid(uuid)
		setAnchorUuid(uuid)
	}

	function moveTo(index: number): void {
		setAnchorUuid(items[moveActive(index)]?.data.uuid ?? null)
	}

	function resetCursor(): void {
		setActiveUuid(null)
		setActiveFallback(0)
	}

	return { safeActiveIndex, handleKeyDown, registerRef, setActive, setCursor, moveTo, resetCursor }
}
