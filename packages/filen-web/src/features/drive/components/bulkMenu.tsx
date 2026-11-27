import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { DRIVE_ACTION_SHORTCUTS } from "@/features/drive/lib/selectionActions"
import { type DriveDialogAction } from "@/features/drive/lib/selectionDispatch"
import { DriveContextMenuContent, type ItemDestination } from "@/features/drive/components/itemMenu"

export interface DriveCellContextMenuContentProps {
	// Right-clicked inside a 2+ selection: the menu acts on the whole selection rather than this item alone.
	bulkMenu: boolean
	item: DriveItem
	variant: DriveVariant
	selectedItems: DriveItem[]
	onDialogAction: DriveDialogAction
	searchHit: boolean
	onOpen: () => void
	destination: ItemDestination
}

// The right-click menu of a listing row or tile (driveRow.tsx/driveTile.tsx): the same builder as the selection bar,
// over the selection or the one item.
export function DriveCellContextMenuContent({
	bulkMenu,
	item,
	variant,
	selectedItems,
	onDialogAction,
	searchHit,
	onOpen,
	destination
}: DriveCellContextMenuContentProps) {
	return (
		<DriveContextMenuContent
			items={bulkMenu ? selectedItems : [item]}
			variant={variant}
			onDialogAction={onDialogAction}
			searchHit={searchHit}
			onOpen={onOpen}
			destination={destination}
			shortcuts={DRIVE_ACTION_SHORTCUTS}
		/>
	)
}
