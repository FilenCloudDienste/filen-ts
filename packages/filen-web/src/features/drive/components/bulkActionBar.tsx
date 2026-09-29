import { useTranslation } from "react-i18next"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { startDownloads } from "@/features/drive/lib/download"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import {
	driveBulkActions,
	isBulkActionOfflineDisabled,
	isBulkDownloadEnabled,
	runBulkFavorite,
	type BulkActionDescriptor,
	type BulkDialogActionKind
} from "@/features/drive/components/bulkActionBar.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { BulkActionButton, SelectionActionBar } from "@/components/selectionActionBar"

export interface BulkActionBarProps {
	variant: DriveVariant
	selectedItems: DriveItem[]
	onDialogAction: (kind: BulkDialogActionKind) => void
}

// Descriptors with a registered keyboard shortcut surface it in their tooltip alongside the label.
const KEYMAP_ACTION_FOR: Partial<Record<BulkActionDescriptor["id"], string>> = {
	trash: "drive.trash",
	download: "drive.download"
}

// Bottom-anchored floating selection bar (directoryListing.tsx overlays it on the listing container
// while a selection exists) — the toolbar stays put; this replaces nothing.
export function BulkActionBar({ variant, selectedItems, onDialogAction }: BulkActionBarProps) {
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	const flags = aggregateDriveSelectionFlags(selectedItems)
	const descriptors = driveBulkActions(variant, flags)

	// download is checked FIRST, before dialog/favorite — startDownloads' FSA save picker needs
	// this click's own live user gesture (see features/drive/lib/download.ts), so nothing here may yield to the
	// event loop ahead of it. A disabled Button's onClick never fires at all (see the disabled prop
	// below), which today only guards the empty-selection edge case — every dir/multi selection is
	// downloadable too now (the sw zip route).
	function runDescriptor(descriptor: BulkActionDescriptor): void {
		if (descriptor.id === "download") {
			void startDownloads(selectedItems)
			return
		}

		if (descriptor.run === "direct") {
			void runBulkFavorite(selectedItems)
			return
		}

		onDialogAction(descriptor.dialogKind)
	}

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

				return (
					<BulkActionButton
						key={descriptor.id}
						icon={descriptor.icon}
						label={t(descriptor.labelKey)}
						destructive={descriptor.destructive}
						disabled={disabled}
						disabledReason={offlineDisabled ? t("common:offlineActionDisabled") : undefined}
						kbdAction={KEYMAP_ACTION_FOR[descriptor.id]}
						onClick={() => {
							runDescriptor(descriptor)
						}}
					/>
				)
			})}
		</SelectionActionBar>
	)
}
