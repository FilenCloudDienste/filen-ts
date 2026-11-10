import { useTranslation } from "react-i18next"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import {
	driveBulkActions,
	driveBulkKbdAction,
	driveDeleteKeyTarget,
	isBulkActionOfflineDisabled,
	isBulkDownloadEnabled,
	runBulkDescriptor,
	type BulkDialogActionKind
} from "@/features/drive/components/bulkActionBar.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { DROPDOWN_TREE_MENU_FAMILY } from "@/features/drive/components/directoryTreeSubmenu"
import { BulkExtractMenuEntries, CompressMenuEntries } from "@/features/drive/components/archiveSubmenus"
import { DownloadAsEntries } from "@/features/drive/components/downloadAsSubmenu"
import { BulkActionButton, BulkActionMenuButton, SelectionActionBar } from "@/components/selectionActionBar"

export interface BulkActionBarProps {
	variant: DriveVariant
	selectedItems: DriveItem[]
	onDialogAction: (kind: BulkDialogActionKind) => void
}

// Bottom-anchored floating selection bar (directoryListing.tsx overlays it on the listing container
// while a selection exists) — the toolbar stays put; this replaces nothing.
export function BulkActionBar({ variant, selectedItems, onDialogAction }: BulkActionBarProps) {
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	const flags = aggregateDriveSelectionFlags(selectedItems)
	const descriptors = driveBulkActions(variant, flags)
	const deleteKeyTarget = driveDeleteKeyTarget(descriptors)

	return (
		<SelectionActionBar
			count={selectedItems.length}
			clearKbdAction="drive.clearSelection"
			onClear={() => {
				useDriveStore.getState().clearSelectedItems()
			}}
		>
			{descriptors.map(descriptor => {
				const offlineDisabled = isBulkActionOfflineDisabled(descriptor.id, isOnline)
				// isBulkDownloadEnabled is effectively always true here (the bar only mounts once a
				// selection exists) — kept as a defensive check mirroring itemMenu.logic.ts's own
				// downloadDescriptor rather than assuming the caller never renders an empty selection.
				// Every other descriptor stays always-enabled.
				const disabled = (descriptor.id === "download" && !isBulkDownloadEnabled(selectedItems)) || offlineDisabled
				const disabledReason = offlineDisabled ? t("common:offlineActionDisabled") : undefined

				// Compress, Extract and Download as open the same entries their submenus hold in the menus.
				if (descriptor.id === "downloadAs") {
					return (
						<BulkActionMenuButton
							key={descriptor.id}
							icon={descriptor.icon}
							label={t(descriptor.labelKey)}
							disabled={disabled}
							disabledReason={disabledReason}
							kbdAction={driveBulkKbdAction(descriptor.id, deleteKeyTarget)}
						>
							<DownloadAsEntries
								family={DROPDOWN_TREE_MENU_FAMILY}
								items={selectedItems}
							/>
						</BulkActionMenuButton>
					)
				}

				if (descriptor.id === "compress" || descriptor.id === "extract") {
					return (
						<BulkActionMenuButton
							key={descriptor.id}
							icon={descriptor.icon}
							label={t(descriptor.labelKey)}
							disabled={disabled}
							disabledReason={disabledReason}
							kbdAction={driveBulkKbdAction(descriptor.id, deleteKeyTarget)}
						>
							{descriptor.id === "compress" ? (
								<CompressMenuEntries
									family={DROPDOWN_TREE_MENU_FAMILY}
									items={selectedItems}
									variant={variant}
									onMoreOptions={() => {
										onDialogAction("compress")
									}}
								/>
							) : (
								<BulkExtractMenuEntries
									family={DROPDOWN_TREE_MENU_FAMILY}
									items={selectedItems}
									variant={variant}
									onChooseDestination={() => {
										onDialogAction("extractTo")
									}}
								/>
							)}
						</BulkActionMenuButton>
					)
				}

				return (
					<BulkActionButton
						key={descriptor.id}
						icon={descriptor.icon}
						label={t(descriptor.labelKey)}
						destructive={descriptor.destructive}
						disabled={disabled}
						disabledReason={disabledReason}
						kbdAction={driveBulkKbdAction(descriptor.id, deleteKeyTarget)}
						onClick={() => {
							runBulkDescriptor(descriptor, selectedItems, onDialogAction)
						}}
					/>
				)
			})}
		</SelectionActionBar>
	)
}
