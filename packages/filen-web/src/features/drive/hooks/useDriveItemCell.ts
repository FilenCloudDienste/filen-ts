import { type MouseEvent } from "react"
import { driveItemName } from "@filen/shared"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { canWriteVariant, type DriveVariant } from "@/features/drive/lib/preferences"
import { sharedIdentityLabel } from "@/features/drive/lib/format"
import { splatToUuids } from "@/features/drive/lib/navigate"
import { canDragVariant } from "@/features/drive/lib/dnd.logic"
import { buildDragSourceProps } from "@/features/drive/lib/dnd"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { type BulkDialogActionKind } from "@/features/drive/components/bulkActionBar.logic"
import { type ItemDestination } from "@/features/drive/components/itemMenu"
import { type DestinationActions } from "@/features/drive/components/destinationMenu"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"
import { LISTING_SPRING } from "@/features/drive/lib/springLoad"
import { useTouchLongPress } from "@/lib/useTouchLongPress"

// The props a listing row (driveRow.tsx) and a grid tile (driveTile.tsx) share.
export interface DriveItemCellProps {
	item: DriveItem
	index: number
	// The listing's full item count. Virtualized: only a window of cells is mounted, so the DOM child
	// count is a fabricated total and the set size has to come from the owning list.
	total: number
	selected: boolean
	active: boolean
	variant: DriveVariant
	// The current listing's "/drive/$" splat — the cell's own ancestry (for the drag-move self/descendant
	// guard) is this chain plus the cell's uuid. A primitive so a memoized cell keeps its identity.
	splat: string
	// Search results only: the item's ancestor-name chain from the search root (empty for a direct
	// child of it) — undefined outside an active search, where a cell has nothing to show here.
	searchParentPath?: string | undefined
	// The listing's already-reconciled selection — right-clicking a cell inside a 2+ selection opens the
	// BULK menu over exactly these items (freshest metadata, same as the bulk bar reads).
	selectedItems: DriveItem[]
	// `pointerType` is the one behind the click (useTouchLongPress's pointerType): a touch tap opens or
	// toggles instead of selecting.
	onPointerSelect: (index: number, event: MouseEvent<HTMLDivElement>, pointerType: string) => void
	// Moves the roving cursor + range anchor to a cell (useDriveListboxNav's setCursor) — the retarget
	// half of a right-click or a touch long-press, neither of which reaches onPointerSelect.
	onCursorMove: (index: number) => void
	onOpen: (index: number) => void
	onItemAction: (kind: ItemActionDialogKind, item: DriveItem) => void
	// The listing's create/upload host (useDirectoryDestination), for a directory cell's New submenu.
	destinationActions: (uuid: string | null) => DestinationActions
	onBulkAction: (kind: BulkDialogActionKind) => void
	registerRef: (index: number, el: HTMLDivElement | null) => void
}

export type DriveItemCellParams = Pick<
	DriveItemCellProps,
	| "item"
	| "index"
	| "variant"
	| "splat"
	| "selected"
	| "selectedItems"
	| "searchParentPath"
	| "destinationActions"
	| "onOpen"
	| "onCursorMove"
>

// Everything a row and a tile derive alike; each keeps only its own layout.
export function useDriveItemCell({
	item,
	index,
	variant,
	splat,
	selected,
	selectedItems,
	searchParentPath,
	destinationActions,
	onOpen,
	onCursorMove
}: DriveItemCellParams) {
	const name = driveItemName(item)
	const open = () => {
		onOpen(index)
	}
	// Drag-to-move: a move-capable cell is a drag source; a directory cell is also a drop target for a
	// move (self/descendant/same-parent guarded via its own ancestry). The accessible move route stays
	// the item menu's "Move" action — this is a pointer-only enhancement.
	const dragSource = buildDragSourceProps(item, variant, selectedItems)
	// A cross-directory search hit is the only case "Open containing directory" has somewhere to go —
	// searchParentPath is "" for a direct child of the search root and undefined outside a search.
	const searchHit = searchParentPath !== undefined && searchParentPath.length > 0
	const targetAncestry = [...splatToUuids(splat), item.data.uuid]
	// ⌘V pastes into the listing on screen, not into this cell, so the cell's Paste shows no shortcut.
	const destination: ItemDestination = { actionsFor: destinationActions, ancestry: targetAncestry, pasteShortcut: false }
	const springable = isDirectoryItem(item) && !item.data.undecryptable
	const drop = useDriveDropTarget({
		targetUuid: item.data.uuid,
		targetAncestry,
		routeChain: { parent: item.data.parent },
		targetName: name,
		// Internal drags: owned My Drive directories only.
		disabled: item.type !== "directory" || !canDragVariant(variant),
		// A drag resting on a directory opens it (springLoad.ts), and files from the system upload into it
		// wherever the listing's own dropzone would upload (canWriteVariant, judged for this directory).
		// Neither for an undecryptable one, which doesn't open either.
		spring: springable ? { timing: LISTING_SPRING, open } : undefined,
		acceptFiles: springable && canWriteVariant(variant, item.data.uuid)
	})
	// Only the two shared variants' ROOT listing resolve a counterparty; every other variant/nested
	// item gets null (no badge) — see sharedIdentityLabel's own doc comment.
	const shared = sharedIdentityLabel(item, variant)
	const bulkMenu = selected && selectedItems.length > 1
	// Cut for a later paste: dimmed, Explorer-style, until the paste or the next copy/cut. The ⋯ trigger
	// keeps its own hover-only opacity.
	const cut = useDriveClipboardStore(state => state.cutUuids.has(item.data.uuid))
	// Right-clicking outside the current selection retargets it to this cell (the file-manager
	// convention) — otherwise a single-item menu would open while unrelated cells stayed highlighted.
	// Merges with ContextMenuTrigger's own handler (Base UI's mergeProps chains same-name handlers). The
	// cursor and range anchor move with it — a right-click is a pointer selection, and leaving them
	// behind would make the next Arrow jump from an unselected cell and Shift+Click range from an anchor
	// the user never set. A touch long-press toggles the cell instead, exactly like a Ctrl/Cmd+click, and
	// opens no menu (the ⋯ trigger is always shown on a coarse pointer).
	const press = useTouchLongPress<HTMLDivElement>({
		onLongPress: () => {
			useDriveStore.getState().toggleSelectedItem(item)
			onCursorMove(index)
		},
		onContextMenu: () => {
			if (!selected) {
				useDriveStore.getState().setSelectedItems([item])
				onCursorMove(index)
			}
		}
	})

	return { name, open, dragSource, searchHit, destination, drop, shared, bulkMenu, cut, press }
}
