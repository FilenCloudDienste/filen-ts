import { type MouseEvent } from "react"
import { isPlainClickDeselect, isToggleModifier } from "@/features/drive/lib/listbox"
import { photosRangeSelection } from "@/features/photos/components/photoGrid.logic"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"

// Modifier-click multi-select for the photos grid — mirrors the drive listbox's own pointer-select
// semantics (useDriveListboxNav.handlePointerSelect: plain click selects one, or deselects the sole
// selected item, ctrl/cmd toggles, shift extends a range from the last non-shift anchor) without the
// drag-and-drop ancestry guard or the per-variant reset effect that hook also owns (a single flat
// surface, not a navigable tree). The cursor/virtualizer-scroll half lives in usePhotosGridNav; both
// entry points resolve a shift range through the same photosRangeSelection. A plain function, not a
// hook, so the grid's compiled click handler stays stable across renders.
export function photosPointerSelect(
	items: PhotoItem[],
	anchorUuid: string | null,
	setAnchorUuid: (uuid: string | null) => void,
	index: number,
	event: MouseEvent<HTMLDivElement>
): void {
	const item = items[index]

	if (!item) {
		return
	}

	if (event.shiftKey) {
		usePhotosStore.getState().setSelectedItems(photosRangeSelection(items, anchorUuid, index))

		return
	}

	if (isToggleModifier(event)) {
		photosToggleSelect(item, setAnchorUuid)

		return
	}

	const store = usePhotosStore.getState()

	if (isPlainClickDeselect(store.selectedItems, item.data.uuid, event.detail)) {
		store.clearSelectedItems()
	} else {
		store.setSelectedItems([item])
	}

	setAnchorUuid(item.data.uuid)
}

// Toggles one photo in or out of the selection and anchors a later Shift range on it: a Ctrl/Cmd+click,
// and on touch a long-press or a tap in selection mode.
export function photosToggleSelect(item: PhotoItem, setAnchorUuid: (uuid: string | null) => void): void {
	usePhotosStore.getState().toggleSelectedItem(item)
	setAnchorUuid(item.data.uuid)
}
