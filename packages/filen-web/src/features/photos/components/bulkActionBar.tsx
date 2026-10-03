import { useTranslation } from "react-i18next"
import {
	driveBulkActions,
	isBulkActionOfflineDisabled,
	isBulkDownloadEnabled,
	type BulkActionDescriptor,
	type BulkDialogActionKind
} from "@/features/drive/components/bulkActionBar.logic"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { startDownloads } from "@/features/drive/lib/download"
import { setFavoritedPhotos } from "@/features/photos/lib/actions"
import { driveActivity, favoriteKeys } from "@/features/drive/lib/activity"
import { runBulkActivity } from "@/lib/activity/activity"
import { prunePhotoSelection, usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { PHOTOS_HIDDEN_BULK_ACTION_IDS } from "@/features/photos/lib/itemActions"
import { useIsOnline } from "@/lib/useIsOnline"
import { BulkActionButton, SelectionActionBar } from "@/components/selectionActionBar"

export interface PhotosBulkActionBarProps {
	rootUuid: string
	selectedItems: PhotoItem[]
	onDialogAction: (kind: BulkDialogActionKind) => void
}

// Descriptors with a registered keyboard shortcut surface it in their tooltip alongside the label —
// mirrors drive's own bulk bar.
const KEYMAP_ACTION_FOR: Partial<Record<BulkActionDescriptor["id"], string>> = {
	trash: "photos.trash"
}

// Floating selection bar for the photos grid — drive's own descriptors and gates, against the
// photos-scoped selection store + cache-patching action wrappers instead of drive's own.
export function PhotosBulkActionBar({ rootUuid, selectedItems, onDialogAction }: PhotosBulkActionBarProps) {
	const { t } = useTranslation(["drive", "photos", "common"])
	const isOnline = useIsOnline()
	const flags = aggregateDriveSelectionFlags(selectedItems)
	// A photos selection is always owned, decryptable, non-shared-root files, so the drive variant yields
	// exactly the photos set once the hidden ids are dropped (PHOTOS_HIDDEN_BULK_ACTION_IDS).
	const descriptors = driveBulkActions("drive", flags).filter(descriptor => !PHOTOS_HIDDEN_BULK_ACTION_IDS.has(descriptor.id))

	async function handleBulkFavorite(): Promise<void> {
		const favorited = !flags.includesFavorited

		await runBulkActivity(
			driveActivity(
				selectedItems,
				favoriteKeys(favorited),
				(targets, onSettled) => setFavoritedPhotos(rootUuid, targets, favorited, onSettled),
				{ prune: prunePhotoSelection }
			)
		)
	}

	// download is checked first — startDownloads' FSA save picker needs this click's own live user
	// gesture (mirrors drive's identical ordering rationale), so nothing here may yield ahead of it.
	function runDescriptor(descriptor: BulkActionDescriptor): void {
		if (descriptor.id === "download") {
			void startDownloads(selectedItems)
			return
		}

		if (descriptor.run === "direct") {
			void handleBulkFavorite()
			return
		}

		onDialogAction(descriptor.dialogKind)
	}

	return (
		<SelectionActionBar
			count={selectedItems.length}
			clearKbdAction="photos.clearSelection"
			onClear={() => {
				usePhotosStore.getState().clearSelectedItems()
			}}
		>
			{descriptors.map(descriptor => {
				const offlineDisabled = isBulkActionOfflineDisabled(descriptor.id, isOnline)

				return (
					<BulkActionButton
						key={descriptor.id}
						icon={descriptor.icon}
						label={t(descriptor.labelKey)}
						destructive={descriptor.destructive}
						disabled={(descriptor.id === "download" && !isBulkDownloadEnabled(selectedItems)) || offlineDisabled}
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
