import { useEffect, useState, type MouseEvent } from "react"
import {
	clampListboxIndex,
	isSelectionGesture,
	isToggleModifier,
	listboxRangeItems,
	resolveCursorIndex,
	touchTapIntent
} from "@/features/drive/lib/listbox"

export interface ListPointerSelectionActions<T> {
	set: (items: T[]) => void
	toggle: (item: T) => void
	clear: () => void
}

export interface UseListPointerSelectionParams<T> {
	// The ordered, currently-rendered selectable set. Shift-range math walks this array's indices.
	items: readonly T[]
	// Must be stable (module scope): it is an effect dependency.
	actions: ListPointerSelectionActions<T>
	// Selection and anchor clear on mount and whenever this changes.
	resetKey?: string
	// Also clear on unmount, so a surface that leaves never strands a selection in its background store.
	clearOnUnmount?: boolean
	// The live selection's size: a touch tap toggles while it is non-zero (touchTapIntent).
	selectionCount: number
}

export interface ListPointerSelection {
	// Drive's modifier-click model: plain click replaces the selection with just this item, Ctrl/Cmd+click
	// toggles it into a multi-selection, Shift+click extends a range from the last non-shift anchor. A
	// touch tap leaves the selection alone, or toggles the item in selection mode. True when the click
	// was a selection gesture, which must not also navigate (selectionAwareLinkClick).
	handlePointerSelect: (index: number, event: MouseEvent, pointerType: string) => boolean
	// A Ctrl/Cmd+click's toggle, for a touch long-press.
	toggleAt: (index: number) => void
}

// The pointer half of useDriveListboxNav for Link-based row lists: no roving keyboard cursor (the rows
// are real anchors, not a virtualizer-backed ARIA listbox), just the anchor-tracked range/toggle math.
export function useListPointerSelection<T extends { uuid: string }>({
	items,
	actions,
	resetKey,
	clearOnUnmount,
	selectionCount
}: UseListPointerSelectionParams<T>): ListPointerSelection {
	// Tracked by uuid, not position: a background reorder (a live socket patch, a pin moving an item into
	// another sort bucket) would otherwise silently retarget the next Shift+click's range. The fallback is
	// the last position the uuid resolved to, used only once it is gone (mirrors useDriveListboxNav).
	const [anchorUuid, setAnchorUuid] = useState<string | null>(null)
	const [anchorFallback, setAnchorFallback] = useState(0)
	const [anchorResetKey, setAnchorResetKey] = useState(resetKey)

	if (anchorResetKey !== resetKey) {
		setAnchorResetKey(resetKey)
		setAnchorUuid(null)
		setAnchorFallback(0)
	}

	const uuids = items.map(item => item.uuid)
	const safeAnchorIndex = clampListboxIndex(resolveCursorIndex(anchorUuid, uuids, anchorFallback), items.length)

	if (anchorFallback !== safeAnchorIndex) {
		setAnchorFallback(safeAnchorIndex)
	}

	useEffect(() => {
		actions.clear()

		if (!clearOnUnmount) {
			return undefined
		}

		return () => {
			actions.clear()
		}
	}, [resetKey, actions, clearOnUnmount])

	function toggleAt(index: number): void {
		const item = items[index]

		if (item) {
			actions.toggle(item)
			setAnchorUuid(item.uuid)
		}
	}

	function handlePointerSelect(index: number, event: MouseEvent, pointerType: string): boolean {
		const item = items[index]

		if (!item) {
			return isSelectionGesture(event)
		}

		const touch = touchTapIntent(pointerType, event, selectionCount)

		if (touch === "open") {
			return false
		}

		if (event.shiftKey) {
			// The anchor deliberately does NOT move: a run of Shift+clicks keeps ranging from the last
			// plain/Ctrl+click, like useDriveListboxNav's separate range anchor.
			actions.set(listboxRangeItems(items, safeAnchorIndex, index))

			return true
		}

		if (touch === "toggle" || isToggleModifier(event)) {
			toggleAt(index)

			return true
		}

		actions.set([item])
		setAnchorUuid(item.uuid)

		return false
	}

	return { handlePointerSelect, toggleAt }
}
