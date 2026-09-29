import { useEffect, useState, type MouseEvent } from "react"
import { clampListboxIndex, isToggleModifier, listboxRangeItems, resolveCursorIndex } from "@/features/drive/lib/listbox"

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
}

export interface ListPointerSelection {
	// Drive's modifier-click model: plain click replaces the selection with just this item, Ctrl/Cmd+click
	// toggles it into a multi-selection, Shift+click extends a range from the last non-shift anchor.
	handlePointerSelect: (index: number, event: MouseEvent) => void
}

// The pointer half of useDriveListboxNav for Link-based row lists: no roving keyboard cursor (the rows
// are real anchors, not a virtualizer-backed ARIA listbox), just the anchor-tracked range/toggle math.
export function useListPointerSelection<T extends { uuid: string }>({
	items,
	actions,
	resetKey,
	clearOnUnmount
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

	function handlePointerSelect(index: number, event: MouseEvent): void {
		const item = items[index]

		if (!item) {
			return
		}

		if (event.shiftKey) {
			// The anchor deliberately does NOT move: a run of Shift+clicks keeps ranging from the last
			// plain/Ctrl+click, like useDriveListboxNav's separate range anchor.
			actions.set(listboxRangeItems(items, safeAnchorIndex, index))

			return
		}

		if (isToggleModifier(event)) {
			actions.toggle(item)
			setAnchorUuid(item.uuid)

			return
		}

		actions.set([item])
		setAnchorUuid(item.uuid)
	}

	return { handlePointerSelect }
}
