import { type MouseEvent } from "react"
import { photosRangeSelection } from "@/features/photos/components/photoGrid.logic"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"

// Modifier-click multi-select for the photos grid — mirrors the drive listbox's own pointer-select
// semantics (useDriveListboxNav.handlePointerSelect: plain click selects one, ctrl/cmd toggles, shift
// extends a range from the last non-shift anchor) without the drag-and-drop ancestry guard or the
// per-variant reset effect that hook also owns (a single flat surface, not a navigable tree). The
// cursor/virtualizer-scroll half lives in usePhotosGridNav; both entry points resolve a shift range
// through the same photosRangeSelection.
export interface PhotosSelection {
	handlePointerSelect: (index: number, event: MouseEvent<HTMLDivElement>) => void
}

export function usePhotosSelection(items: PhotoItem[], anchorUuid: string | null, setAnchorUuid: (uuid: string | null) => void) {
	function handlePointerSelect(index: number, event: MouseEvent<HTMLDivElement>): void {
		const item = items[index]

		if (!item) {
			return
		}

		if (event.shiftKey) {
			usePhotosStore.getState().setSelectedItems(photosRangeSelection(items, anchorUuid, index))

			return
		}

		if (event.metaKey || event.ctrlKey) {
			usePhotosStore.getState().toggleSelectedItem(item)
			setAnchorUuid(item.data.uuid)

			return
		}

		usePhotosStore.getState().setSelectedItems([item])
		setAnchorUuid(item.data.uuid)
	}

	return { handlePointerSelect }
}
