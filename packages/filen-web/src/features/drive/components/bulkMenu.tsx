import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { useIsOnline } from "@/lib/useIsOnline"
import {
	driveBulkActions,
	isBulkActionOfflineDisabled,
	runBulkFavorite,
	startBulkDownload,
	type BulkActionDescriptor,
	type BulkDialogActionKind
} from "@/features/drive/components/bulkActionBar.logic"
import { ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"

export interface DriveBulkMenuProps {
	variant: DriveVariant
	selectedItems: DriveItem[]
	onBulkAction: (kind: BulkDialogActionKind) => void
}

// Right-clicking a row that is part of a 2+ selection opens THIS menu instead of the single-item one
// (driveRow.tsx/driveTile.tsx pick between them) — the same descriptor set the floating bulk bar
// renders, from the same builder, so the two surfaces can never offer different bulk actions. No
// separator rules: the bulk list is short and the bar has no grouping either.
//
// ContextMenuContent children only mount when the menu opens (Base UI portal), so the hooks below
// cost nothing per row — the same property ItemMenuEntries already relies on.
export function DriveBulkContextMenuContent({ variant, selectedItems, onBulkAction }: DriveBulkMenuProps) {
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	const descriptors = driveBulkActions(variant, aggregateDriveSelectionFlags(selectedItems))

	// download is checked FIRST, before dialog/favorite — startBulkDownload's FSA save picker needs
	// this click's own live user gesture (see features/drive/lib/download.ts), so nothing here may
	// yield to the event loop ahead of it. Mirrors bulkActionBar.tsx's identical dispatch.
	function runDescriptor(descriptor: BulkActionDescriptor): void {
		if (descriptor.id === "download") {
			startBulkDownload(selectedItems)
			return
		}

		if (descriptor.run === "direct") {
			void runBulkFavorite(selectedItems)
			return
		}

		onBulkAction(descriptor.dialogKind)
	}

	return (
		<ContextMenuContent>
			{descriptors.map(descriptor => {
				const offlineDisabled = isBulkActionOfflineDisabled(descriptor.id, isOnline)

				return (
					<ContextMenuItem
						key={descriptor.id}
						variant={descriptor.destructive ? "destructive" : "default"}
						disabled={offlineDisabled}
						title={offlineDisabled ? t("common:offlineActionDisabled") : undefined}
						onClick={event => {
							// A portaled popup's synthetic events still bubble through the REACT tree, so
							// without this an item click would also fire the row's own onClick and collapse
							// the selection this menu is acting on — see itemMenu.tsx's identical guard.
							event.stopPropagation()
							runDescriptor(descriptor)
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
