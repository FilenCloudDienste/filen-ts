import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { type MenuButton } from "@/components/ui/menu"
import { selectAllMenuButton } from "@/components/ui/selectAllMenuButton"
import { type DriveItemFileExtracted } from "@/types"
import { type DrivePath } from "@/hooks/useDrivePath"
import useDriveStore, { clearDriveSelection } from "@/features/drive/store/useDrive.store"
import { aggregateDriveSelectionFlags, isFileItem } from "@/features/drive/driveSelectors"
import { runBulk } from "@/lib/bulkOps"
import { downloadDriveItemToDevice, ensureSaveToPhotosPermission, saveDriveItemToPhotos } from "@/features/drive/driveDownload"
import drive from "@/features/drive/drive"
import offline from "@/features/offline/offline"
import { getRealDriveItemParent } from "@/lib/sdkUnwrap"
import { buildCopyMenuButton } from "@/features/drive/components/item/menuActionsCopy"

/**
 * Builds the bulk-action menu buttons (favorite / copy / save-to-device / download /
 * make-offline / trash + select-all) shown in the photos header while in
 * selection mode. Subscribes to the drive selection store itself so the
 * returned buttons stay in sync with the current selection.
 */
export function usePhotoBulkActions({ items, drivePath }: { items: DriveItemFileExtracted[]; drivePath: DrivePath }): MenuButton[] {
	const { t } = useTranslation()
	const selectedItems = useDriveStore(useShallow(state => state.selectedItems))
	const driveFlags = aggregateDriveSelectionFlags(selectedItems)

	const bulkButtons: MenuButton[] = []

	bulkButtons.push(
		selectAllMenuButton({
			t,
			allSelected: selectedItems.length === items.length,
			onClear: clearDriveSelection,
			onSelectAll: () => useDriveStore.getState().selectAllItems(items)
		})
	)

	bulkButtons.push({
		id: "bulkFavorite",
		title: driveFlags.includesFavorited ? t("unfavorite_selected") : t("favorite_selected"),
		icon: "heart",
		requiresOnline: true,
		onPress: async () => {
			await runBulk({
				items: selectedItems,
				clearSelection: clearDriveSelection,
				op: item =>
					drive.favorite({
						item,
						favorited: !driveFlags.includesFavorited
					})
			})
		}
	})

	// Copy and "Copy to…" only: Photos has no Move, so no Cut, and no directory to paste into.
	if (!driveFlags.includesUndecryptable) {
		bulkButtons.push(
			buildCopyMenuButton({
				items: selectedItems,
				withCut: false,
				bulk: true,
				onDone: clearDriveSelection,
				t
			})
		)
	}

	if (driveFlags.everyImageOrVideoFile) {
		bulkButtons.push({
			id: "bulkSaveToPhotos",
			title: t("save_to_device_photos_selected"),
			icon: "image",
			requiresOnline: true,
			onPress: async () => {
				if (!(await ensureSaveToPhotosPermission(t))) {
					return
				}

				await runBulk({
					items: selectedItems,
					background: true,
					clearSelection: clearDriveSelection,
					op: saveDriveItemToPhotos
				})
			}
		})
	}

	bulkButtons.push({
		id: "bulkDownload",
		title: t("download_selected"),
		icon: "download",
		requiresOnline: true,
		onPress: async () => {
			await runBulk({
				items: selectedItems,
				background: true,
				clearSelection: clearDriveSelection,
				op: async item => {
					const result = await downloadDriveItemToDevice({ item })

					if (!result.success) {
						throw result.error
					}
				}
			})
		}
	})

	bulkButtons.push({
		id: "bulkMakeOffline",
		title: t("make_available_offline_selected"),
		icon: "archive",
		requiresOnline: true,
		onPress: async () => {
			await runBulk({
				items: selectedItems,
				background: true,
				clearSelection: clearDriveSelection,
				op: async item => {
					const parent = getRealDriveItemParent({ item, drivePath })

					// A null parent means the photo's containing directory was never
					// cached (e.g. album subdir not yet listed). Silently returning here
					// reported success while making nothing available offline — surface a
					// visible failure so runBulk shows an error instead.
					if (!parent) {
						throw new Error(t("directory_not_found"))
					}

					if (isFileItem(item)) {
						await offline.storeFile({ file: item, parent })
					}
				}
			})
		}
	})

	bulkButtons.push({
		id: "bulkTrash",
		title: t("trash_selected"),
		icon: "trash",
		destructive: true,
		requiresOnline: true,
		onPress: async () => {
			await runBulk({
				items: selectedItems,
				clearSelection: clearDriveSelection,
				confirm: {
					title: t("trash_selected"),
					message: t("are_you_sure_trash_selected_photos"),
					okText: t("trash"),
					cancelText: t("cancel"),
					destructive: true
				},
				op: item => drive.trash({ item })
			})
		}
	})

	return bulkButtons
}

export default usePhotoBulkActions
