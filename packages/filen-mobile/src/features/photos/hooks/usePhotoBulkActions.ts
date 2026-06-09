import { run } from "@filen/utils"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import * as FileSystem from "expo-file-system"
import * as MediaLibrary from "expo-media-library/legacy"
import { type MenuButton } from "@/components/ui/menu"
import { type DriveItemFileExtracted } from "@/types"
import { type DrivePath } from "@/hooks/useDrivePath"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { aggregateDriveSelectionFlags } from "@/features/drive/driveSelectors"
import { runBulk } from "@/lib/bulkOps"
import { downloadDriveItemToDevice } from "@/features/drive/driveDownload"
import drive from "@/features/drive/drive"
import offline from "@/features/offline/offline"
import transfers from "@/features/transfers/transfers"
import { newTmpDir } from "@/lib/tmp"
import { getRealDriveItemParent } from "@/lib/sdkUnwrap"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import alerts from "@/lib/alerts"

/**
 * Builds the bulk-action menu buttons (favorite / save-to-device / download /
 * make-offline / trash + select-all) shown in the photos header while in
 * selection mode. Subscribes to the drive selection store itself so the
 * returned buttons stay in sync with the current selection.
 */
export function usePhotoBulkActions({ items, drivePath }: { items: DriveItemFileExtracted[]; drivePath: DrivePath }): MenuButton[] {
	const { t } = useTranslation()
	const selectedItems = useDriveStore(useShallow(state => state.selectedItems))
	const driveFlags = aggregateDriveSelectionFlags(selectedItems)

	const bulkButtons: MenuButton[] = []

	bulkButtons.push({
		id: "selectAll",
		title: selectedItems.length === items.length ? t("deselect_all") : t("select_all"),
		icon: "select",
		onPress: () => {
			if (selectedItems.length === items.length) {
				useDriveStore.getState().clearSelectedItems()

				return
			}

			useDriveStore.getState().selectAllItems(items)
		}
	})

	bulkButtons.push({
		id: "bulkFavorite",
		title: driveFlags.includesFavorited ? t("unfavorite_selected") : t("favorite_selected"),
		icon: "heart",
		requiresOnline: true,
		onPress: async () => {
			await runBulk({
				items: selectedItems,
				clearSelection: () => useDriveStore.getState().clearSelectedItems(),
				op: item =>
					drive.favorite({
						item,
						favorited: !driveFlags.includesFavorited,
						signal: undefined
					})
			})
		}
	})

	if (driveFlags.everyImageOrVideoFile) {
		bulkButtons.push({
			id: "bulkSaveToPhotos",
			title: t("save_to_device_photos_selected"),
			icon: "archive",
			requiresOnline: true,
			onPress: async () => {
				const permissionsResult = await run(async () => {
					return await hasAllNeededMediaPermissions({ shouldRequest: true, library: "any", needCamera: false })
				})

				if (!permissionsResult.success) {
					console.error(permissionsResult.error)
					alerts.error(permissionsResult.error)

					return
				}

				if (!permissionsResult.data) {
					alerts.error(t("no_permissions_enable_manually"))

					return
				}

				await runBulk({
					items: selectedItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					op: async item => {
						const meta = item.data.decryptedMeta

						if (!meta) {
							return
						}

						const saveResult = await run(async defer => {
							const destination = new FileSystem.File(FileSystem.Paths.join(newTmpDir().uri, meta.name))

							defer(() => {
								if (destination.parentDirectory.exists) {
									destination.parentDirectory.delete()
								}
							})

							if (!destination.parentDirectory.exists) {
								destination.parentDirectory.create({ intermediates: true, idempotent: true })
							}

							if (destination.exists) {
								destination.delete()
							}

							const downloadResult = await transfers.download({ item, destination })

							if (!downloadResult) {
								return
							}

							await MediaLibrary.saveToLibraryAsync(destination.uri)
						})

						if (!saveResult.success) {
							throw saveResult.error
						}
					}
				})
			}
		})
	}

	bulkButtons.push({
		id: "bulkDownload",
		title: t("download_selected"),
		icon: "archive",
		requiresOnline: true,
		onPress: async () => {
			await runBulk({
				items: selectedItems,
				clearSelection: () => useDriveStore.getState().clearSelectedItems(),
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
				clearSelection: () => useDriveStore.getState().clearSelectedItems(),
				op: async item => {
					const parent = getRealDriveItemParent({ item, drivePath })

					// A null parent means the photo's containing directory was never
					// cached (e.g. album subdir not yet listed). Silently returning here
					// reported success while making nothing available offline — surface a
					// visible failure so runBulk shows an error instead.
					if (!parent) {
						throw new Error(t("directory_not_found"))
					}

					if (item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") {
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
				clearSelection: () => useDriveStore.getState().clearSelectedItems(),
				confirm: {
					title: t("trash_selected"),
					message: t("are_you_sure_trash_selected_photos"),
					okText: t("trash"),
					cancelText: t("cancel"),
					destructive: true
				},
				op: item => drive.trash({ item, signal: undefined })
			})
		}
	})

	return bulkButtons
}

export default usePhotoBulkActions
