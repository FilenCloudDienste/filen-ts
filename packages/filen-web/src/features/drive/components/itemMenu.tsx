import { createElement, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { toggleFavorite, restoreItems } from "@/features/drive/lib/actions"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/stores/drive"
import {
	driveItemActions,
	startItemDownload,
	type ItemActionDescriptor,
	type ItemActionDialogKind,
	type ItemActionId
} from "@/features/drive/components/itemMenu.logic"
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"

export interface ItemMenuContentProps {
	item: DriveItem
	variant: DriveVariant
	// Fires for every "dialog"-run descriptor (rename/move/color/versions/info/link/trash/delete) —
	// the listing-level dialog host (directory-listing.tsx) owns turning this into an open dialog.
	// "direct"-run descriptors (favorite/restore) never call this — they resolve fully in place below.
	onItemAction: (kind: ItemActionDialogKind, item: DriveItem) => void
}

interface MenuItemFamily {
	Item: typeof DropdownMenuItem
	Separator: typeof DropdownMenuSeparator
}

// Groups the flat descriptor list for readability: a rule before the reference/reveal action (info)
// and before whichever removal action closes the list (trash in the normal menu, deletePermanently in
// the trash/undecryptable-reduced menus) — a pure presentation concern the gating builder itself
// shouldn't own.
const SEPARATOR_BEFORE = new Set<ItemActionId>(["info", "trash", "deletePermanently"])

// Shared per-item action list, rendered by BOTH the right-click context menu and the ⋯ dropdown (see
// DriveContextMenuContent/DriveDropdownMenuContent below) — one descriptor list (driveItemActions),
// one mapping from descriptor to menu row. Base UI's ContextMenu and DropdownMenu are separate Root
// families with their own Item/Separator primitives (not interchangeable across triggers even though
// their props are structurally identical), so the one piece each caller supplies is which family to
// render rows with.
function ItemMenuEntries({ item, variant, onItemAction, family }: ItemMenuContentProps & { family: MenuItemFamily }) {
	const { t } = useTranslation("drive")
	const descriptors = driveItemActions(item, variant)
	const { Item, Separator } = family

	async function runDirect(descriptor: Extract<ItemActionDescriptor, { run: "direct" }>): Promise<void> {
		// Checked FIRST, before any `await` below — startItemDownload's FSA save picker needs this
		// click's own live user gesture (see download.ts), so nothing here may yield to the event loop
		// ahead of it. disabled=false is already guaranteed by the Item's own `disabled` prop below (a
		// disabled MenuItem never fires onClick at all), so this never runs for a directory.
		if (descriptor.id === "download") {
			startItemDownload(item)
			return
		}

		if (descriptor.id === "favorite") {
			const outcome = await toggleFavorite(item)

			if (outcome.status === "error") {
				toast.error(errorLabel(outcome.dto))
				return
			}

			// Unfavoriting while the favorites listing is open drops the row from that listing (cache
			// patch in actions.ts) — mirrors the restore/trash cleanup below so its uuid doesn't linger
			// in the selection store as a ghost "N selected" count. Favoriting-ON and any non-favorites
			// variant leave the item visible, so selection is left untouched in both of those cases.
			if (variant === "favorites" && !outcome.item.data.favorited) {
				useDriveStore.getState().removeFromSelection([outcome.item.data.uuid])
			}

			return
		}

		// "favorite" and "restore" are the only ids the builder ever marks "direct" — restore is the
		// remaining case. A restored item always vanishes from the trash listing it was selected in
		// (see actions.ts), so a successful outcome also drops it from selection — mirrors
		// directory-listing.tsx's identical cleanup after a trash/delete confirm.
		const outcome = await restoreItems([item])
		toastBulkOutcome(outcome)
		useDriveStore.getState().removeFromSelection(outcome.succeeded.map(succeededItem => succeededItem.data.uuid))
	}

	return (
		<>
			{descriptors.map((descriptor, index) => (
				<Fragment key={descriptor.id}>
					{index > 0 && SEPARATOR_BEFORE.has(descriptor.id) ? <Separator /> : null}
					<Item
						variant={descriptor.destructive ? "destructive" : "default"}
						disabled={descriptor.enabled === false}
						onClick={event => {
							// The ⋯ dropdown is mounted as a React descendant of the row's own clickable div
							// (needed so the trigger button sits visually inside the row) — Base UI's MenuItem
							// itself never stops propagation, and a portaled popup's synthetic events still
							// bubble through the REACT tree (not the DOM tree), so without this an item click
							// would also fire the row's onClick and reselect it.
							event.stopPropagation()

							if (descriptor.run === "direct") {
								void runDirect(descriptor)
								return
							}

							onItemAction(descriptor.dialogKind, item)
						}}
					>
						{createElement(descriptor.icon, { "aria-hidden": true })}
						{t(descriptor.labelKey)}
					</Item>
				</Fragment>
			))}
		</>
	)
}

// Right-click surface — rendered inside a per-row/tile <ContextMenu> (see drive-row.tsx/drive-tile.tsx).
export function DriveContextMenuContent({ item, variant, onItemAction }: ItemMenuContentProps) {
	return (
		<ContextMenuContent>
			<ItemMenuEntries
				item={item}
				variant={variant}
				onItemAction={onItemAction}
				family={{ Item: ContextMenuItem, Separator: ContextMenuSeparator }}
			/>
		</ContextMenuContent>
	)
}

// ⋯ trigger surface — rendered inside a per-row/tile <DropdownMenu> (see drive-row.tsx/drive-tile.tsx).
export function DriveDropdownMenuContent({ item, variant, onItemAction }: ItemMenuContentProps) {
	return (
		<DropdownMenuContent align="end">
			<ItemMenuEntries
				item={item}
				variant={variant}
				onItemAction={onItemAction}
				family={{ Item: DropdownMenuItem, Separator: DropdownMenuSeparator }}
			/>
		</DropdownMenuContent>
	)
}
