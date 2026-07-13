import { type MouseEvent } from "react"
import { listboxRange } from "@/features/drive/lib/listbox"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"

// Modifier-click multi-select for the photos grid — mirrors the drive listbox's own pointer-select
// semantics (useDriveListboxNav.handlePointerSelect: plain click selects one, ctrl/cmd toggles, shift
// extends a range from the last non-shift anchor) without the roving-tabindex/virtualizer-scroll
// machinery that hook also owns: photos has no keyboard arrow navigation to drive, no drag-and-drop
// ancestry guard, and no per-variant reset effect (a single flat surface, not a navigable tree), so
// reusing listboxRange's pure range math directly here is simpler than threading photos through the
// heavier drive-specific hook.
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
			const anchorIndex = anchorUuid === null ? -1 : items.findIndex(existing => existing.data.uuid === anchorUuid)
			const resolvedAnchor = anchorIndex === -1 ? index : anchorIndex
			const rangeItems = listboxRange(resolvedAnchor, index)
				.map(rangeIndex => items[rangeIndex])
				.filter((rangeItem): rangeItem is PhotoItem => rangeItem !== undefined)

			usePhotosStore.getState().setSelectedItems(rangeItems)

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
