import { router } from "expo-router"
import { type TFunction } from "i18next"
import { run } from "@filen/utils"
import { randomUUID } from "expo-crypto"
import * as FileSystem from "expo-file-system"
import * as MediaLibrary from "expo-media-library/legacy"
import { type MenuButton } from "@/components/ui/menu"
import { type SelectOptions, type DrivePath } from "@/hooks/useDrivePath"
import type { DriveItem } from "@/types"
import { type SortByType } from "@/lib/sort"
import alerts from "@/lib/alerts"
import drive from "@/features/drive/drive"
import useDriveStore from "@/features/drive/store/useDrive.store"
import transfers from "@/features/transfers/transfers"
import { newTmpDir } from "@/lib/tmp"
import { getRealDriveItemParent } from "@/lib/sdkUnwrap"
import offline from "@/features/offline/offline"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import { runBulk } from "@/lib/bulkOps"
import { type DriveSelectionFlags } from "@/features/drive/driveSelectors"
import { downloadDriveItemToDevice } from "@/features/drive/driveDownload"
import { serialize } from "@/lib/serializer"
import { selectContacts } from "@/features/contacts/contactsSelect"

export function buildSortMenuButton(current: SortByType, setSort: (next: SortByType) => void, t: TFunction): MenuButton {
	const leaf = (id: string, title: string, value: SortByType): MenuButton => ({
		id,
		title,
		checked: current === value,
		onPress: () => setSort(value)
	})

	return {
		id: "sort",
		title: t("sort_by"),
		icon: "list",
		subButtons: [
			{
				id: "sort.name",
				title: t("sort_name"),
				icon: "text",
				subButtons: [leaf("sort.nameAsc", t("sort_name_asc"), "nameAsc"), leaf("sort.nameDesc", t("sort_name_desc"), "nameDesc")]
			},
			{
				id: "sort.size",
				title: t("sort_size"),
				icon: "size",
				subButtons: [leaf("sort.sizeAsc", t("sort_size_asc"), "sizeAsc"), leaf("sort.sizeDesc", t("sort_size_desc"), "sizeDesc")]
			},
			{
				id: "sort.type",
				title: t("sort_type"),
				icon: "doc",
				subButtons: [leaf("sort.mimeAsc", t("sort_type_asc"), "mimeAsc"), leaf("sort.mimeDesc", t("sort_type_desc"), "mimeDesc")]
			},
			{
				id: "sort.modified",
				title: t("sort_modified"),
				icon: "clock",
				subButtons: [
					leaf("sort.lastModifiedAsc", t("sort_modified_asc"), "lastModifiedAsc"),
					leaf("sort.lastModifiedDesc", t("sort_modified_desc"), "lastModifiedDesc")
				]
			},
			{
				id: "sort.uploaded",
				title: t("sort_uploaded"),
				icon: "upload",
				subButtons: [
					leaf("sort.uploadDateAsc", t("sort_uploaded_asc"), "uploadDateAsc"),
					leaf("sort.uploadDateDesc", t("sort_uploaded_desc"), "uploadDateDesc")
				]
			},
			{
				id: "sort.created",
				title: t("sort_created"),
				icon: "calendar",
				subButtons: [
					leaf("sort.creationAsc", t("sort_created_asc"), "creationAsc"),
					leaf("sort.creationDesc", t("sort_created_desc"), "creationDesc")
				]
			}
		]
	}
}

// Builds the bulk-selection action menu (favorite / move / download / share /
// offline / trash / restore / delete / stop-sharing / remove-share / disable-link)
// keyed off the active drive variant + aggregated selection flags. Mirrors
// `buildSortMenuButton`'s module-level shape. Returns the list of buttons to
// append to the header dropdown.
export function buildBulkActionMenu({
	drivePath,
	selectedDriveItems,
	liveItems,
	driveFlags,
	t
}: {
	drivePath: DrivePath
	selectedDriveItems: DriveItem[]
	liveItems: DriveItem[]
	driveFlags: DriveSelectionFlags
	t: TFunction
}): MenuButton[] {
	const menuButtons: MenuButton[] = []
	const isAtRoot = !drivePath.uuid

	if (drivePath.type === "trash") {
		menuButtons.push({
			id: "restoreSelected",
			title: t("restore_selected"),
			icon: "restore",
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					confirm: {
						title: t("restore_selected"),
						message: t("are_you_sure_restore_selected"),
						okText: t("restore"),
						cancelText: t("cancel")
					},
					op: item => drive.restore({ item, signal: undefined })
				})
			}
		})

		menuButtons.push({
			id: "deleteSelectedPermanently",
			title: t("delete_selected_permanently"),
			destructive: true,
			icon: "delete",
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					confirm: {
						title: t("delete_selected_permanently"),
						message: t("are_you_sure_delete_selected_permanently"),
						okText: t("delete"),
						cancelText: t("cancel"),
						destructive: true
					},
					op: item => drive.deletePermanently({ item, signal: undefined })
				})
			}
		})

		return menuButtons
	}

	// Favorite/Unfavorite first — toggle is the most-tapped bulk
	// action, belongs at the top of the menu.
	if (drivePath.type === "drive" || drivePath.type === "recents" || drivePath.type === "favorites" || drivePath.type === "sharedOut") {
		menuButtons.push({
			id: "bulkFavorite",
			title: driveFlags.includesFavorited ? t("unfavorite_selected") : t("favorite_selected"),
			icon: "heart",
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
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
	}

	// Move — modify (location) comes before output (download/share).
	// driveSelectToolbar already handles `Promise.all` over the items
	// it receives, so the bulk handler just opens the picker with all
	// selected items. useFocusEffect on Drive clears selection when
	// we return.
	if (
		drivePath.type === "drive" ||
		drivePath.type === "favorites" ||
		drivePath.type === "sharedOut" ||
		drivePath.type === "links" ||
		drivePath.type === "recents"
	) {
		menuButtons.push({
			id: "bulkMove",
			title: t("move_selected"),
			icon: "move",
			requiresOnline: true,
			onPress: async () => {
				const driveRootUuidResult = await run(async () => {
					return await drive.getRootUuid()
				})

				if (!driveRootUuidResult.success) {
					console.error(driveRootUuidResult.error)
					alerts.error(driveRootUuidResult.error)

					return
				}

				router.push({
					pathname: "/driveSelect/[uuid]",
					params: {
						uuid: driveRootUuidResult.data,
						selectOptions: serialize({
							type: "single",
							files: false,
							directories: true,
							intention: "move",
							items: selectedDriveItems,
							id: randomUUID()
						} satisfies SelectOptions)
					}
				})
			}
		})
	}

	// Download to device — applies to every read-capable variant.
	if (
		drivePath.type === "drive" ||
		drivePath.type === "recents" ||
		drivePath.type === "favorites" ||
		drivePath.type === "sharedIn" ||
		drivePath.type === "sharedOut" ||
		drivePath.type === "links"
	) {
		menuButtons.push({
			id: "bulkDownload",
			title: t("download_selected"),
			icon: "download",
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
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
	}

	// Save to photos — every selected item must be a file with an
	// image/video preview type (the OS photo library only accepts
	// those). Aggregator flag is computed once via getPreviewType
	// over decryptedMeta.name.
	if (
		driveFlags.everyImageOrVideoFile &&
		(drivePath.type === "drive" || drivePath.type === "recents" || drivePath.type === "favorites")
	) {
		menuButtons.push({
			id: "bulkSaveToPhotos",
			title: t("save_to_photos_selected"),
			icon: "image",
			requiresOnline: true,
			onPress: async () => {
				const permissionsResult = await run(async () => {
					return await hasAllNeededMediaPermissions({ shouldRequest: true })
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
					items: selectedDriveItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					op: async item => {
						const decryptedMeta = item.data.decryptedMeta

						if (!decryptedMeta) {
							return
						}

						const result = await run(async defer => {
							const destination = new FileSystem.File(FileSystem.Paths.join(newTmpDir().uri, decryptedMeta.name))

							defer(() => {
								if (destination.parentDirectory.exists) {
									destination.parentDirectory.delete()
								}
							})

							if (!destination.parentDirectory.exists) {
								destination.parentDirectory.create({
									intermediates: true,
									idempotent: true
								})
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

						if (!result.success) {
							throw result.error
						}
					}
				})
			}
		})
	}

	// Share with Filen user — re-encrypts each item under each
	// recipient's public key (SDK shareDir / shareFile). Grouped with
	// the other "output" actions (download / save-to-photos). The
	// picker is the confirmation gesture; no extra confirm dialog.
	if (drivePath.type === "drive" || drivePath.type === "recents" || drivePath.type === "favorites" || drivePath.type === "sharedOut") {
		menuButtons.push({
			id: "bulkShareFilenUser",
			title: t("share_filen_user_selected"),
			icon: "users",
			requiresOnline: true,
			onPress: async () => {
				const pickResult = await run(async () => {
					return await selectContacts({
						multiple: true,
						userIdsToExclude: []
					})
				})

				if (!pickResult.success) {
					console.error(pickResult.error)
					alerts.error(pickResult.error)

					return
				}

				if (pickResult.data.cancelled || pickResult.data.selectedContacts.length === 0) {
					return
				}

				const contacts = pickResult.data.selectedContacts

				await runBulk({
					items: selectedDriveItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					op: async item => {
						await Promise.all(contacts.map(contact => drive.shareWithFilenUser({ item, contact })))
					}
				})
			}
		})
	}

	// Make offline / Remove offline — keep them as two separate buttons
	// instead of a single toggle. Toggling would need per-item offline
	// status (via N useDriveItemStoredOfflineQuery calls or a query
	// helper) and the user's intent for a mixed selection is
	// ambiguous anyway. The lib's idempotent semantics make
	// already-offline / already-online items no-ops, so showing both
	// is safe.
	//
	// Discoverability gate: per-item Make-offline hides when the item is
	// already stored. Mirror that in bulk by hiding bulkMakeOffline when
	// every selected item is known to be stored offline. Falls back to
	// "show" when the per-item cache hasn't been populated yet.
	const everySelectedKnownStoredOffline = liveItems.every(it => offline.isItemStoredSync(it) === true)

	if ((drivePath.type === "drive" || drivePath.type === "favorites") && !everySelectedKnownStoredOffline) {
		menuButtons.push({
			id: "bulkMakeOffline",
			title: t("make_available_offline_selected"),
			icon: "archive",
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					op: async item => {
						const parent = getRealDriveItemParent({ item, drivePath })

						if (!parent) {
							return
						}

						if (item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") {
							await offline.storeFile({ file: item, parent })
						} else {
							await offline.storeDirectory({ directory: item, parent })
						}
					}
				})
			}
		})
	}

	// Remove offline — mirror the per-item rule: only show when at least
	// one selected item is a TOP-LEVEL stored offline entry. Nested
	// children of stored directories register as "stored" via the
	// flattened index, but `removeItem` only operates on top-level
	// entries, so showing the button for them would silently no-op.
	//
	//   - /offline (virtual root): everything shown IS top-level by
	//     construction, so no per-item check needed.
	//   - /drive, /favorites: must verify at least one selected item is
	//     a known top-level stored entry. /offline nested + /linked +
	//     other views never show this action.
	const anySelectedTopLevelOffline = liveItems.some(it => offline.isItemTopLevelStoredSync(it) === true)

	if (
		(drivePath.type === "offline" && !drivePath.uuid) ||
		((drivePath.type === "drive" || drivePath.type === "favorites") && anySelectedTopLevelOffline)
	) {
		menuButtons.push({
			id: "bulkRemoveOffline",
			title: t("remove_offline_selected"),
			icon: "trash",
			destructive: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					confirm: {
						title: t("remove_offline_selected"),
						message: t("confirm_remove_offline_selected"),
						okText: t("remove_offline"),
						cancelText: t("cancel"),
						destructive: true
					},
					op: item => offline.removeItem(item)
				})
			}
		})
	}

	// Trash — owned content the user can move to trash (excludes sharedIn / offline)
	if (
		drivePath.type === "drive" ||
		drivePath.type === "favorites" ||
		drivePath.type === "sharedOut" ||
		drivePath.type === "links" ||
		drivePath.type === "recents"
	) {
		menuButtons.push({
			id: "bulkTrash",
			title: t("trash_selected"),
			icon: "trash",
			destructive: true,
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					confirm: {
						title: t("trash_selected"),
						message: t("are_you_sure_trash_selected"),
						okText: t("trash"),
						cancelText: t("cancel"),
						destructive: true
					},
					op: item => drive.trash({ item, signal: undefined })
				})
			}
		})
	}

	// Stop-sharing — sharedOut at root only
	if (drivePath.type === "sharedOut" && isAtRoot) {
		menuButtons.push({
			id: "bulkStopSharing",
			title: t("stop_sharing_selected"),
			icon: "delete",
			destructive: true,
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					confirm: {
						title: t("stop_sharing_selected"),
						message: t("are_you_sure_stop_sharing_selected"),
						okText: t("stop_sharing"),
						cancelText: t("cancel"),
						destructive: true
					},
					op: item => drive.removeShare({ item, signal: undefined })
				})
			}
		})
	}

	// Remove-share — sharedIn at root only (declines a share invite for selected items)
	if (drivePath.type === "sharedIn" && isAtRoot) {
		menuButtons.push({
			id: "bulkRemoveShare",
			title: t("remove_share_selected"),
			icon: "delete",
			destructive: true,
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					confirm: {
						title: t("remove_share_selected"),
						message: t("are_you_sure_remove_share_selected"),
						okText: t("remove"),
						cancelText: t("cancel"),
						destructive: true
					},
					op: item => drive.removeShare({ item, signal: undefined })
				})
			}
		})
	}

	// Disable public link — links variant root only
	if (drivePath.type === "links" && isAtRoot) {
		menuButtons.push({
			id: "bulkDisablePublicLink",
			title: t("disable_public_link_selected"),
			icon: "delete",
			destructive: true,
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
					clearSelection: () => useDriveStore.getState().clearSelectedItems(),
					confirm: {
						title: t("disable_public_link_selected"),
						message: t("are_you_sure_disable_public_link_selected"),
						okText: t("disable"),
						cancelText: t("cancel"),
						destructive: true
					},
					op: item => drive.disablePublicLink({ item, signal: undefined })
				})
			}
		})
	}

	return menuButtons
}
