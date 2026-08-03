import { useRef, useState, type KeyboardEvent } from "react"
import { type Virtualizer } from "@tanstack/react-virtual"
import { clampListboxIndex, resolveCursorIndex } from "@/features/drive/lib/listbox"
import { photosGridKeyAction, photosGridKeyTargetIsInteractive, photosRangeSelection } from "@/features/photos/components/photoGrid.logic"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"

// Bounds the rAF poll moveActive() uses to focus a cursor target that scrollToIndex just brought into
// range but that hasn't mounted (and registered its ref) yet.
const FOCUS_RETRY_FRAMES = 10

interface UsePhotosGridNavParams {
	items: PhotoItem[]
	columns: number
	virtualizer: Virtualizer<HTMLDivElement, Element>
	anchorUuid: string | null
	setAnchorUuid: (uuid: string | null) => void
	onOpen: (index: number) => void
}

export interface PhotosGridNav {
	safeActiveIndex: number
	handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
	registerRef: (index: number, el: HTMLDivElement | null) => void
	// Cursor only — what a pointer click moves (the anchor stays owned by usePhotosSelection).
	setActive: (index: number) => void
	// Cursor AND anchor — what a marquee drag-end moves, mirroring drive's own setCursor.
	setCursor: (index: number) => void
	resetCursor: () => void
}

// Roving-tabindex keyboard operability for the photos grid: the cursor, arrow/Home/End movement,
// Space toggle, Enter open and Shift+Arrow range extension. Purpose-built and grid-only — photos has
// no list mode, no nested navigation, no drag-and-drop ancestry guard and no per-variant reset, so
// this is deliberately not a port of useDriveListboxNav. Select-all/clear-selection are NOT handled
// here — they are registered keymap commands (photoGrid.tsx).
export function usePhotosGridNav({
	items,
	columns,
	virtualizer,
	anchorUuid,
	setAnchorUuid,
	onOpen
}: UsePhotosGridNavParams): PhotosGridNav {
	// Tracked by item identity (uuid), not position — a positional index alone drifts under a
	// background refetch that reorders the grid, silently retargeting Enter onto the wrong photo.
	const [activeUuid, setActiveUuid] = useState<string | null>(null)
	// The last position the cursor actually resolved to — what resolveCursorIndex falls back to once
	// its uuid is gone from `items`. Adjusted during render (React's documented alternative to an
	// effect), never in an effect body.
	const [activeFallback, setActiveFallback] = useState(0)
	const focusRequestRef = useRef(0)
	const itemRefs = useRef(new Map<number, HTMLDivElement>())

	const uuids = items.map(item => item.data.uuid)
	const safeActiveIndex = clampListboxIndex(resolveCursorIndex(activeUuid, uuids, activeFallback), items.length)

	if (activeFallback !== safeActiveIndex) {
		setActiveFallback(safeActiveIndex)
	}

	function registerRef(index: number, el: HTMLDivElement | null): void {
		if (el) {
			itemRefs.current.set(index, el)
		} else {
			itemRefs.current.delete(index)
		}
	}

	// Focus is imperative by nature here: the target row may be scrolled fully out of the mounted
	// window, and scrollToIndex's re-render lands through the virtualizer's own scroll subscription,
	// not synchronously with the state update below. A bounded rAF poll picks the tile up once it
	// mounts; `focusRequestRef` makes an older, still-polling request inert once a newer one lands.
	function moveActive(nextIndexRaw: number): number {
		const next = clampListboxIndex(nextIndexRaw, items.length)

		setActiveUuid(items[next]?.data.uuid ?? null)
		virtualizer.scrollToIndex(Math.floor(next / columns), { align: "auto" })
		focusRequestRef.current = next

		const attemptFocus = (attemptsLeft: number) => {
			if (focusRequestRef.current !== next) {
				return
			}

			const el = itemRefs.current.get(next)

			if (el) {
				if (document.activeElement !== el) {
					el.focus({ preventScroll: true })
				}

				return
			}

			if (attemptsLeft <= 0) {
				return
			}

			requestAnimationFrame(() => {
				attemptFocus(attemptsLeft - 1)
			})
		}

		requestAnimationFrame(() => {
			attemptFocus(FOCUS_RETRY_FRAMES)
		})

		return next
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		// The tile's ⋯ trigger is in the tab sequence alongside the tile face, and its Enter/Space belong
		// to the button, not the grid — see photosGridKeyTargetIsInteractive.
		if (photosGridKeyTargetIsInteractive(event.target)) {
			return
		}

		const action = photosGridKeyAction(event.key, safeActiveIndex, items.length, columns)

		if (action.kind === "none") {
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

		if (action.kind === "open") {
			onOpen(safeActiveIndex)

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

	function resetCursor(): void {
		setActiveUuid(null)
		setActiveFallback(0)
	}

	return { safeActiveIndex, handleKeyDown, registerRef, setActive, setCursor, resetCursor }
}
