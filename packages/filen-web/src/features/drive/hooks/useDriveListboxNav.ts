import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { clampListboxIndex, listboxKeyTarget, listboxRange, resolveCursorIndex } from "@/features/drive/lib/listbox"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant, type DriveViewMode } from "@/features/drive/lib/preferences"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { type DriveVirtualizer } from "@/features/drive/hooks/useDriveVirtualizer"

// Bounds the rAF poll moveActive() uses to focus a cursor target that scrollToIndex just brought
// into range but that hasn't mounted (and registered its ref) yet.
const FOCUS_RETRY_FRAMES = 10

interface UseDriveListboxNavParams {
	items: DriveItem[]
	viewMode: DriveViewMode
	columns: number
	virtualizer: DriveVirtualizer["activeVirtualizer"]
	itemRefs: DriveVirtualizer["itemRefs"]
	// A fresh directory/variant must never inherit the previous one's selection or cursor — keyed on
	// [variant, splat] so both a remount and an in-place param change (deeper nav within drive.$.tsx)
	// reset here.
	variant: DriveVariant
	splat: string
	onOpen: (index: number) => void
}

export interface DriveListboxNav {
	safeActiveIndex: number
	handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
	handlePointerSelect: (index: number, event: MouseEvent<HTMLDivElement>) => void
	// Moves the roving cursor + range anchor to `index` without scrolling/focusing — mirrors what a
	// plain click does (setActive + setAnchor), used by the marquee to land the cursor at drag end.
	setCursor: (index: number) => void
}

// ARIA listbox roving-cursor navigation on top of the virtualizer: owns the cursor (activeIndex) and
// range anchor, plain-Arrow/Home/End movement, Space toggle, Shift+Arrow range extension, and pointer
// selection. Select-all/clear-selection are NOT handled here — they're registered keymap commands (see
// the drive.* action defs in features/drive/lib/keymap.ts).
export function useDriveListboxNav({
	items,
	viewMode,
	columns,
	virtualizer,
	itemRefs,
	variant,
	splat,
	onOpen
}: UseDriveListboxNavParams): DriveListboxNav {
	// Tracked by item identity (uuid), not position — a positional index alone drifts under a
	// background reorder (sort-by-size backfilling sizes, a live socket/optimistic patch) with no
	// navigation, silently retargeting Enter/Shift+Arrow onto the wrong item. `null` means "no move
	// has happened yet in this directory/variant", which resolveCursorIndex falls back to the fallback
	// index below (0 initially), same as the plain positional default this replaces.
	const [activeUuid, setActiveUuid] = useState<string | null>(null)
	const [anchorUuid, setAnchorUuid] = useState<string | null>(null)
	// The last position each cursor actually resolved to — what resolveCursorIndex falls back to once
	// its uuid is no longer present in `items` (deleted/filtered/moved out from under the cursor), so
	// a vanished target lands on its nearest surviving neighbor instead of snapping back to index 0.
	// Kept as state (not a ref) and adjusted synchronously during render — React's documented pattern
	// for deriving state from a changed input without an extra effect round trip (see "Adjusting state
	// when a prop changes" in the React docs); a ref cannot be read during render under React Compiler.
	const [activeFallback, setActiveFallback] = useState(0)
	const [anchorFallback, setAnchorFallback] = useState(0)
	const focusRequestRef = useRef(0)
	const pendingReveal = useDriveStore(state => state.pendingReveal)

	const uuids = items.map(item => item.data.uuid)
	const safeActiveIndex = clampListboxIndex(resolveCursorIndex(activeUuid, uuids, activeFallback), items.length)
	const safeAnchorIndex = clampListboxIndex(resolveCursorIndex(anchorUuid, uuids, anchorFallback), items.length)

	if (activeFallback !== safeActiveIndex) {
		setActiveFallback(safeActiveIndex)
	}

	if (anchorFallback !== safeAnchorIndex) {
		setAnchorFallback(safeAnchorIndex)
	}

	// A fresh directory/variant must never inherit the previous one's selection or cursor. Routes
	// that only change `splat` (deeper nav within the same drive.$.tsx route) re-render this
	// component in place rather than remounting it, so a plain mount effect would miss that case —
	// keying on [variant, splat] instead covers both a remount and an in-place param change. The
	// cursor reset is a deliberate navigation-driven reset (fires once per navigation, not a cascade);
	// keeping it a post-commit effect preserves the exact pre-split behavior (clear selection + reset
	// cursor together, after the new listing commits).
	useEffect(() => {
		useDriveStore.getState().clearSelectedItems()
		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate navigation reset, see above
		setActiveUuid(null)
		setAnchorUuid(null)
		setActiveFallback(0)
		setAnchorFallback(0)

		// A reveal armed for a DIFFERENT listing means the user navigated somewhere else instead — drop
		// it rather than let it hijack this listing's cursor. One armed for THIS listing is left alone;
		// the effect below is still waiting to consume it.
		const reveal = useDriveStore.getState().pendingReveal

		if (reveal !== null && reveal.splat !== splat) {
			useDriveStore.getState().clearPendingReveal()
		}
	}, [variant, splat])

	// Focus is imperative by nature here: the target index may be scrolled fully out of the mounted
	// window, and scrollToIndex's resulting re-render happens through the virtualizer's own
	// scroll-event subscription, not synchronously with the state update below — so on the very next
	// render the target row/tile may not exist in the DOM (and its ref) yet. A bounded rAF poll picks
	// it up once it mounts; `focusRequestRef` lets a rapid run of keypresses invalidate an older,
	// still-polling request instead of it stealing focus back after a newer one already landed.
	function moveActive(nextIndexRaw: number): number {
		const next = clampListboxIndex(nextIndexRaw, items.length)
		const rowIndex = viewMode === "grid" ? Math.floor(next / columns) : next

		setActiveUuid(items[next]?.data.uuid ?? null)
		virtualizer.scrollToIndex(rowIndex, { align: "auto" })
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

	// Declared AFTER the navigation reset above so a same-commit reset can't clear the selection this
	// one just made. One-shot: the request is consumed before the cursor moves, so it can never
	// re-fire and steal a click the user made afterwards. A request whose row hasn't landed yet stays
	// pending — this re-runs when `items` arrives, which is the virtualized/late-fetch case the
	// destination listing actually hits.
	useEffect(() => {
		if (pendingReveal?.splat !== splat) {
			return
		}

		const index = items.findIndex(item => item.data.uuid === pendingReveal.uuid)

		if (index === -1) {
			return
		}

		const item = items[index]

		if (item) {
			useDriveStore.getState().setSelectedItems([item])
		}

		useDriveStore.getState().clearPendingReveal()
		// eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot navigation-driven cursor move that clears its own trigger, see above
		moveActive(index)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- moveActive is re-created every render; the request above is self-clearing, so re-running on its identity would only add churn
	}, [pendingReveal, items, splat])

	function selectRange(anchor: number, active: number) {
		const rangeItems: DriveItem[] = []

		for (const i of listboxRange(anchor, active)) {
			const item = items[i]

			if (item) {
				rangeItems.push(item)
			}
		}

		useDriveStore.getState().setSelectedItems(rangeItems)
	}

	function handlePointerSelect(index: number, event: MouseEvent<HTMLDivElement>) {
		const item = items[index]

		if (!item) {
			return
		}

		if (event.shiftKey) {
			selectRange(safeAnchorIndex, index)
			setActiveUuid(item.data.uuid)

			return
		}

		if (event.metaKey || event.ctrlKey) {
			useDriveStore.getState().toggleSelectedItem(item)
			setActiveUuid(item.data.uuid)
			setAnchorUuid(item.data.uuid)

			return
		}

		useDriveStore.getState().setSelectedItems([item])
		setActiveUuid(item.data.uuid)
		setAnchorUuid(item.data.uuid)
	}

	// ARIA listbox cursor semantics (roving tabindex): plain Arrow/Home/End move the cursor only —
	// they never change the selection — Space toggles the active item, Shift+Arrow extends a range
	// from the last non-shift cursor position. Select-all (Cmd/Ctrl+A) and clear-selection (Escape)
	// are NOT handled here — they're registered drive.selectAll/drive.clearSelection commands (see
	// the drive.* action defs in features/drive/lib/keymap.ts) so they stay user-remappable with
	// one firing owner; keeping a second hand-rolled check here would double-fire on every keypress.
	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (items.length === 0) {
			return
		}

		if (event.key === " ") {
			event.preventDefault()

			const item = items[safeActiveIndex]

			if (item) {
				useDriveStore.getState().toggleSelectedItem(item)
				setAnchorUuid(item.data.uuid)
			}

			return
		}

		if (event.key === "Enter") {
			event.preventDefault()
			onOpen(safeActiveIndex)

			return
		}

		const target = listboxKeyTarget(event.key, safeActiveIndex, items.length, viewMode === "grid" ? columns : 1, viewMode === "grid")

		if (target === null) {
			return
		}

		event.preventDefault()

		const next = moveActive(target)

		if (event.shiftKey) {
			selectRange(safeAnchorIndex, next)
		} else {
			setAnchorUuid(items[next]?.data.uuid ?? null)
		}
	}

	function setCursor(index: number) {
		const clamped = clampListboxIndex(index, items.length)
		const uuid = items[clamped]?.data.uuid ?? null

		setActiveUuid(uuid)
		setAnchorUuid(uuid)
	}

	return { safeActiveIndex, handleKeyDown, handlePointerSelect, setCursor }
}
