import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { useIsOnline } from "@/lib/useIsOnline"
import {
	driveBulkActions,
	isBulkActionOfflineDisabled,
	runBulkDescriptor,
	type BulkDialogActionKind
} from "@/features/drive/components/bulkActionBar.logic"
import { CONTEXT_TREE_MENU_FAMILY } from "@/features/drive/components/directoryTreeSubmenu"
import { TransferSubmenu } from "@/features/drive/components/transferSubmenu"
import { BulkExtractSubmenu, CompressSubmenu } from "@/features/drive/components/archiveSubmenus"
import { DriveContextMenuContent, type ItemDestination } from "@/features/drive/components/itemMenu"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"

export interface DriveBulkMenuProps {
	variant: DriveVariant
	selectedItems: DriveItem[]
	onBulkAction: (kind: BulkDialogActionKind) => void
}

// Right-clicking a row that is part of a 2+ selection opens THIS menu instead of the single-item one
// (DriveCellContextMenuContent below picks between them) — the same descriptor set the floating bulk bar
// renders, from the same builder, so the two surfaces can never offer different bulk actions. No
// separator rules: the bulk list is short and the bar has no grouping either.
//
// ContextMenuContent children only mount when the menu opens (Base UI portal), so the hooks below
// cost nothing per row — the same property ItemMenuEntries already relies on.
export function DriveBulkContextMenuContent({ variant, selectedItems, onBulkAction }: DriveBulkMenuProps) {
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	const descriptors = driveBulkActions(variant, aggregateDriveSelectionFlags(selectedItems))

	return (
		<ContextMenuContent>
			{descriptors.map(descriptor => {
				const offlineDisabled = isBulkActionOfflineDisabled(descriptor.id, isOnline)

				// Moves or copies the whole selection, same submenus as the single-item menu. They open offline
				// too, for their clipboard entries; each gates its own destinations.
				if (descriptor.id === "move" || descriptor.id === "copy") {
					return (
						<TransferSubmenu
							key={descriptor.id}
							mode={descriptor.id}
							family={CONTEXT_TREE_MENU_FAMILY}
							items={selectedItems}
							onChooseDestination={onBulkAction}
						/>
					)
				}

				if (descriptor.id === "compress") {
					return (
						<CompressSubmenu
							key={descriptor.id}
							family={CONTEXT_TREE_MENU_FAMILY}
							disabled={offlineDisabled}
							items={selectedItems}
							variant={variant}
							onMoreOptions={() => {
								onBulkAction("compress")
							}}
						/>
					)
				}

				if (descriptor.id === "extract") {
					return (
						<BulkExtractSubmenu
							key={descriptor.id}
							family={CONTEXT_TREE_MENU_FAMILY}
							disabled={offlineDisabled}
							items={selectedItems}
							variant={variant}
							onChooseDestination={() => {
								onBulkAction("extractTo")
							}}
						/>
					)
				}

				return (
					<ContextMenuItem
						key={descriptor.id}
						variant={descriptor.destructive ? "destructive" : "default"}
						disabled={offlineDisabled}
						title={offlineDisabled ? t("common:offlineActionDisabled") : undefined}
						onClick={() => {
							runBulkDescriptor(descriptor, selectedItems, onBulkAction)
						}}
					>
						{createElement(descriptor.icon, { "aria-hidden": true })}
						{t(descriptor.labelKey)}
					</ContextMenuItem>
				)
			})}
		</ContextMenuContent>
	)
}

export interface DriveCellContextMenuContentProps extends DriveBulkMenuProps {
	// Right-clicked inside a 2+ selection: the bulk menu over it rather than this item's own.
	bulkMenu: boolean
	item: DriveItem
	onItemAction: (kind: ItemActionDialogKind, item: DriveItem) => void
	searchHit: boolean
	onOpen: () => void
	destination: ItemDestination
}

// The right-click menu of a listing row or tile (driveRow.tsx/driveTile.tsx).
export function DriveCellContextMenuContent({
	bulkMenu,
	item,
	variant,
	selectedItems,
	onBulkAction,
	onItemAction,
	searchHit,
	onOpen,
	destination
}: DriveCellContextMenuContentProps) {
	return bulkMenu ? (
		<DriveBulkContextMenuContent
			variant={variant}
			selectedItems={selectedItems}
			onBulkAction={onBulkAction}
		/>
	) : (
		<DriveContextMenuContent
			item={item}
			variant={variant}
			onItemAction={onItemAction}
			searchHit={searchHit}
			onOpen={onOpen}
			destination={destination}
		/>
	)
}
