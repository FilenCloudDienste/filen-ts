import { useState, type KeyboardEvent, type MouseEvent } from "react"
import { type Virtualizer } from "@tanstack/react-virtual"
import {
	clampListboxIndex,
	isPlainClickDeselect,
	isToggleModifier,
	listboxKeyTarget,
	listboxKeyTargetIsInteractive,
	listboxPageStep,
	listboxRangeItems,
	resolveCursorIndex,
	touchTapIntent
} from "@/features/drive/lib/listbox"
import { type DriveItem } from "@/features/drive/lib/item"
import { useListboxTypeAhead } from "@/features/drive/hooks/useListboxTypeAhead"
import { toggleSelection, type BrowseSelection } from "@/features/publicLinks/lib/browse.logic"
import { hasCommandModifier, isActivationKey } from "@/lib/rowKeys"

interface UsePublicListboxNavParams {
	items: readonly DriveItem[]
	selection: BrowseSelection
	onSelectionChange: (next: BrowseSelection) => void
	virtualizer: Pick<Virtualizer<HTMLDivElement, Element>, "scrollToIndex">
	focusItem: (index: number) => void
	onOpen: (index: number) => void
	// The row the cursor and the range anchor start on, by uuid; null for none yet.
	initialKey: string | null
	// Items per virtual row (1 in the list, the grid's column count) and that row's height: Up/Down move a row, Left/Right
	// an item in a grid, and PageUp/PageDown a screenful of rows.
	columns: number
	rowHeight: number
}

export interface PublicListboxNav {
	safeActiveIndex: number
	handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
	handlePointerSelect: (index: number, event: MouseEvent<HTMLDivElement>, pointerType: string) => void
	// Cursor and range anchor, as a plain click moves them: where a row's box or a marquee leaves them.
	setCursor: (index: number) => void
	// Scrolls to and focuses the cursor row.
	focusCursor: () => void
}

function keysOf(items: readonly DriveItem[]): BrowseSelection {
	return new Set(items.map(item => item.data.uuid))
}

// A public directory's listbox, drive's model (useDriveListboxNav) over a selection the page holds instead of
// drive's store: plain arrows, Home/End and PageUp/PageDown move the cursor, Shift extends a range from the anchor,
// Space toggles, type-ahead jumps by name; a click selects, Ctrl/Cmd toggles, Shift selects a range, and a touch
// tap opens or, once something is selected, toggles. Open, select-all and clear-selection are the drive.* keymap
// actions the browser registers. In a grid, Up/Down move a row of tiles and Left/Right one tile. One level per mount: the
// browser remounts the list on navigation.
export function usePublicListboxNav({
	items,
	selection,
	onSelectionChange,
	virtualizer,
	focusItem,
	onOpen,
	initialKey,
	columns,
	rowHeight
}: UsePublicListboxNavParams): PublicListboxNav {
	// By uuid, not position: a sort or a filter keystroke reorders the rows under the cursor.
	const [activeKey, setActiveKey] = useState<string | null>(initialKey)
	const [anchorKey, setAnchorKey] = useState<string | null>(initialKey)
	// Where each last resolved, for when its row leaves the list (React's adjust-during-render pattern).
	const [activeFallback, setActiveFallback] = useState(0)
	const [anchorFallback, setAnchorFallback] = useState(0)
	const typeAhead = useListboxTypeAhead()

	const keys = items.map(item => item.data.uuid)
	const safeActiveIndex = clampListboxIndex(resolveCursorIndex(activeKey, keys, activeFallback), items.length)
	const safeAnchorIndex = clampListboxIndex(resolveCursorIndex(anchorKey, keys, anchorFallback), items.length)

	if (activeFallback !== safeActiveIndex) {
		setActiveFallback(safeActiveIndex)
	}

	if (anchorFallback !== safeAnchorIndex) {
		setAnchorFallback(safeAnchorIndex)
	}

	function moveActive(nextIndexRaw: number): number {
		const next = clampListboxIndex(nextIndexRaw, items.length)

		setActiveKey(keys[next] ?? null)
		// The virtualizer lays out rows: a grid's tile scrolls in with its row.
		virtualizer.scrollToIndex(Math.floor(next / columns), { align: "auto" })
		focusItem(next)

		return next
	}

	function handlePointerSelect(index: number, event: MouseEvent<HTMLDivElement>, pointerType: string): void {
		const key = keys[index]

		if (key === undefined) {
			return
		}

		const touch = touchTapIntent(pointerType, event, selection.size)

		if (touch === "open") {
			setActiveKey(key)
			setAnchorKey(key)
			onOpen(index)

			return
		}

		if (event.shiftKey) {
			onSelectionChange(keysOf(listboxRangeItems(items, safeAnchorIndex, index)))
			setActiveKey(key)

			return
		}

		setActiveKey(key)
		setAnchorKey(key)

		if (touch === "toggle" || isToggleModifier(event)) {
			onSelectionChange(toggleSelection(selection, key))

			return
		}

		const sole = selection.size === 1 && selection.has(key) ? [{ data: { uuid: key } }] : []

		onSelectionChange(isPlainClickDeselect(sole, key, event.detail) ? new Set() : new Set([key]))
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		// A row's menus are portaled out but stay its React descendants, and its ⋯ trigger owns its own keys.
		if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target) || listboxKeyTargetIsInteractive(event.target)) {
			return
		}

		if (items.length === 0) {
			return
		}

		const typed = typeAhead(event, items, safeActiveIndex)

		if (typed !== null) {
			if (typed !== -1) {
				setAnchorKey(keys[moveActive(typed)] ?? null)
			}

			return
		}

		if (event.key === " " && isActivationKey(event)) {
			event.preventDefault()

			const key = keys[safeActiveIndex]

			if (key !== undefined) {
				onSelectionChange(toggleSelection(selection, key))
				setAnchorKey(key)
			}

			return
		}

		const target = hasCommandModifier(event)
			? null
			: listboxKeyTarget(
					event.key,
					safeActiveIndex,
					items.length,
					columns,
					columns > 1,
					listboxPageStep(event.currentTarget.clientHeight, rowHeight, columns)
				)

		if (target === null) {
			return
		}

		event.preventDefault()

		const next = moveActive(target)

		if (event.shiftKey) {
			onSelectionChange(keysOf(listboxRangeItems(items, safeAnchorIndex, next)))
		} else {
			setAnchorKey(keys[next] ?? null)
		}
	}

	function setCursor(index: number): void {
		const key = keys[clampListboxIndex(index, items.length)] ?? null

		setActiveKey(key)
		setAnchorKey(key)
	}

	function focusCursor(): void {
		if (items.length > 0) {
			moveActive(safeActiveIndex)
		}
	}

	return { safeActiveIndex, handleKeyDown, handlePointerSelect, setCursor, focusCursor }
}
