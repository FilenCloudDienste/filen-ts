import { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import { router } from "@/lib/router"
import drive from "@/features/drive/drive"
import alerts from "@/lib/alerts"
import { confirmedDriveAction } from "@/features/drive/components/item/menuActionsShared"
import { buildUndecryptableMenuButtons } from "@/features/drive/components/item/menuActionsUndecryptable"
import { buildDownloadSubButtons, buildExportButton, buildOpenWithButton } from "@/features/drive/components/item/menuActionsDownload"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import { randomUUID } from "expo-crypto"
import offline from "@/features/offline/offline"
import { getRealDriveItemParent, makeDriveItemPublicLink } from "@/lib/sdkUnwrap"
import * as Clipboard from "expo-clipboard"
import auth from "@/lib/auth"
import { getPreviewType } from "@/lib/previewType"
import type { DrivePath, SelectOptions } from "@/hooks/useDrivePath"
import { serialize } from "@/lib/serializer"
import { selectContacts } from "@/features/contacts/contactsSelect"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { type TFunction } from "i18next"
import { isFileItem, resolveDriveNavigationTarget } from "@/features/drive/driveSelectors"
import cache from "@/lib/cache"
import logger from "@/lib/logger"

// Warm the global uuid-keyed cache for the tapped item BEFORE navigating to a metadata
// screen. A cache-search result from a directory the user never browsed is not yet in the
// cache, but the pushed screens (info / versions / color / publicLink) run their own
// uuid-keyed lookups (directory-size query, public-link gate, version list), which would
// miss without this. No-op for shared-variant items (they arrive via their own listings).
function warmMetadataCache(item: DriveItem): void {
	if (item.type === "file") {
		cache.cacheNewFile(item.data, item)
	} else if (item.type === "directory") {
		cache.cacheNewNormalDir(item.data, item)
	}
}

export function createMenuButtons({
	item,
	drivePath,
	isStoredOffline,
	showSelectToggle,
	isPreview,
	t
}: {
	item: DriveItem
	drivePath: DrivePath
	isStoredOffline: boolean
	showSelectToggle?: boolean
	// True when the menu is rendered inside the full-screen preview (gallery) — so
	// destructive actions that remove the previewed item pop the preview on success.
	// List-row menus leave this false (they must NOT pop the underlying list).
	isPreview?: boolean
	t: TFunction
}): MenuButton[] {
	if (item.data.undecryptable) {
		return buildUndecryptableMenuButtons({ item, drivePath, isPreview, t })
	}

	const menuButtons: MenuButton[] = []
	const previewType = isFileItem(item) ? getPreviewType(item.data.decryptedMeta?.name ?? "") : null

	const parentForOfflineStorage = getRealDriveItemParent({
		item,
		drivePath
	})

	const isOwner = !(drivePath.type === "sharedIn")

	// Bulk-selection entry: the row's Menu owns iOS long-press (contextmenu),
	// so we can't add an onLongPress to the inner Pressable. The Menu's
	// "Select" item is the entry point — matches the pattern in notes / chats
	// / file versions / contacts. Suppress in picker mode (driveSelect uses a
	// different store) and when the caller explicitly opts out (drive preview).
	if (showSelectToggle !== false && !drivePath.selectOptions) {
		const isSelected = useDriveStore.getState().selectedItems.some(i => i.data.uuid === item.data.uuid)

		menuButtons.push({
			id: isSelected ? "deselect" : "select",
			title: isSelected ? t("deselect") : t("select"),
			icon: "select",
			checked: isSelected,
			onPress: () => {
				useDriveStore.getState().toggleSelectedItem(item)
			}
		})
	}

	{
		const openTarget = resolveDriveNavigationTarget({ item, drivePath })

		if (openTarget) {
			menuButtons.push({
				id: "open",
				title: t("open"),
				icon: "folder",
				onPress: () => {
					router.push(openTarget)
				}
			})
		}
	}

	const downloadSubButtons = buildDownloadSubButtons({
		item,
		drivePath,
		isStoredOffline,
		parentForOfflineStorage,
		previewType,
		isOwner,
		t
	})

	// download + share moved further down (after rename/move) so the menu
	// reads: meta (favorite/info/versions/color) → modify (rename/move) →
	// output (download/share) → destructive. Matches iOS Files conventions.

	if (
		(item.type === "file" || item.type === "directory") &&
		(drivePath.type === "drive" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "favorites" ||
			drivePath.type === "links" ||
			drivePath.type === "recents" ||
			drivePath.type === "photos")
	) {
		menuButtons.push({
			id: "favorite",
			requiresOnline: true,
			title: item.data.favorited ? t("unfavorite") : t("favorite"),
			icon: "heart",
			checked: item.data.favorited,
			onPress: async () => {
				const result = await runWithLoading(async () => {
					return await drive.favorite({
						item,
						favorited: !item.data.favorited
					})
				})

				if (!result.success) {
					logger.error("drive", "favorite toggle failed", { error: result.error, uuid: item.data.uuid })
					alerts.error(result.error)

					return
				}
			}
		})
	}

	if (
		drivePath.type === "drive" ||
		drivePath.type === "sharedOut" ||
		drivePath.type === "favorites" ||
		drivePath.type === "links" ||
		drivePath.type === "recents" ||
		drivePath.type === "offline" ||
		drivePath.type === "photos"
	) {
		menuButtons.push({
			id: "info",
			title: t("info"),
			icon: "info",
			onPress: () => {
				warmMetadataCache(item)

				router.push({
					pathname: "/driveItemInfo",
					params: {
						item: serialize(item),
						// Carry the originating variant so the info sheet derives the
						// directory-size query mode (sharedIn/out, offline, …) correctly.
						drivePathType: drivePath.type ?? undefined
					}
				})
			}
		})

		if (item.type === "file" && drivePath.type !== "offline") {
			menuButtons.push({
				id: "versions",
				requiresOnline: true,
				title: t("versions"),
				icon: "versions",
				onPress: () => {
					warmMetadataCache(item)

					router.push({
						pathname: "/fileVersions",
						params: {
							item: serialize(item)
						}
					})
				}
			})
		}
	}

	if (
		item.type === "directory" &&
		(drivePath.type === "drive" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "favorites" ||
			drivePath.type === "links" ||
			drivePath.type === "recents")
	) {
		menuButtons.push({
			id: "color",
			requiresOnline: true,
			title: t("color"),
			icon: "color",
			onPress: () => {
				warmMetadataCache(item)

				router.push({
					pathname: "/changeDirectoryColor",
					params: {
						item: serialize(item),
						// Carry the originating variant so the embedded info rows derive the
						// directory-size query mode (sharedOut, …) correctly.
						drivePathType: drivePath.type ?? undefined
					}
				})
			}
		})
	}

	if (
		(item.type === "file" || item.type === "directory") &&
		(drivePath.type === "drive" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "favorites" ||
			drivePath.type === "links" ||
			drivePath.type === "recents" ||
			drivePath.type === "photos")
	) {
		menuButtons.push({
			id: "rename",
			requiresOnline: true,
			title: t("rename"),
			icon: "edit",
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.input({
						title: t("rename_item"),
						message: t("enter_new_name"),
						defaultValue: item.data.decryptedMeta?.name ?? "",
						cancelText: t("cancel"),
						okText: t("rename")
					})
				})

				if (!promptResult.success) {
					logger.warn("drive", "rename prompt failed", { error: promptResult.error })
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled || promptResult.data.type !== "string") {
					return
				}

				const newName = promptResult.data.value.trim()

				if (newName.length === 0) {
					return
				}

				const result = await runWithLoading(async () => {
					await drive.rename({
						item,
						newName
					})
				})

				if (!result.success) {
					logger.error("drive", "rename failed", { error: result.error, uuid: item.data.uuid })
					alerts.error(result.error)

					return
				}
			}
		})

		if (drivePath.type !== "photos") {
			menuButtons.push({
				id: "move",
				requiresOnline: true,
				title: t("move"),
				icon: "move",
				onPress: async () => {
					const driveRootUuidResult = await run(async () => {
						return await drive.getRootUuid()
					})

					if (!driveRootUuidResult.success) {
						logger.error("drive", "move: failed to get root uuid", { error: driveRootUuidResult.error })
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
								items: [item],
								id: randomUUID()
							} satisfies SelectOptions)
						}
					})
				}
			})
		}
	}

	if (
		downloadSubButtons.length > 0 &&
		drivePath.type !== "offline" &&
		(isFileItem(item) ? (item.data.decryptedMeta?.size ?? 0) > 0 : true)
	) {
		menuButtons.push({
			id: "download",
			title: t("download"),
			icon: "download",
			subButtons: downloadSubButtons
		})
	}

	if (
		(item.type === "file" || item.type === "directory") &&
		(drivePath.type === "drive" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "favorites" ||
			drivePath.type === "links" ||
			drivePath.type === "recents" ||
			drivePath.type === "photos")
	) {
		// Export (download → OS share sheet) belongs here too, not only under Download — exporting
		// to another app IS a form of sharing. File-only, so null (omitted) for shared directories.
		const shareExportButton = buildExportButton({ item, id: "shareExport", t })
		// Open with (download → native app chooser) is likewise a share-adjacent action; Android-only,
		// file-only (null otherwise). Mirrors the Download-submenu entry with a distinct id.
		const shareOpenWithButton = buildOpenWithButton({ item, id: "shareOpenWith", t })

		menuButtons.push({
			id: "share",
			title: t("share"),
			icon: "share",
			subButtons: [
				{
					id: "sharePublicLink",
					requiresOnline: true,
					title: t("share_public_link"),
					icon: "link",
					onPress: () => {
						warmMetadataCache(item)

						router.push({
							pathname: "/publicLink",
							params: {
								item: serialize(item)
							}
						})
					}
				},
				{
					id: "shareFilenUser",
					requiresOnline: true,
					title: t("share_filen_user"),
					icon: "users",
					onPress: async () => {
						const pickResult = await run(async () => {
							return await selectContacts({
								multiple: true,
								userIdsToExclude: []
							})
						})

						if (!pickResult.success) {
							logger.warn("drive", "share: contact picker failed", { error: pickResult.error })
							alerts.error(pickResult.error)

							return
						}

						if (pickResult.data.cancelled || pickResult.data.selectedContacts.length === 0) {
							return
						}

						const contacts = pickResult.data.selectedContacts

						const result = await runWithLoading(async () => {
							await Promise.all(contacts.map(contact => drive.shareWithFilenUser({ item, contact })))
						})

						if (!result.success) {
							logger.error("drive", "share with Filen user failed", { error: result.error, uuid: item.data.uuid })
							alerts.error(result.error)
						}
					}
				},
				...(shareExportButton ? [shareExportButton] : []),
				...(shareOpenWithButton ? [shareOpenWithButton] : [])
			]
		})
	}

	if (drivePath.type === "sharedIn" && !drivePath.uuid) {
		menuButtons.push({
			id: "removeShare",
			requiresOnline: true,
			title: t("remove_share"),
			icon: "delete",
			destructive: true,
			onPress: confirmedDriveAction({
				item,
				promptTitle: t("remove_share_item"),
				promptMessage: t("confirm_remove_share"),
				promptOkText: t("remove_share"),
				action: () =>
					drive.removeShare({
						item,
						parentUuid: drivePath.uuid ?? undefined
					}),
				// Close the preview when removing the share from inside it.
				dismissOnSuccess: isPreview === true
			})
		})
	}

	if (drivePath.type === "sharedOut" && !drivePath.uuid) {
		menuButtons.push({
			id: "stopSharing",
			requiresOnline: true,
			title: t("stop_sharing"),
			icon: "delete",
			destructive: true,
			onPress: confirmedDriveAction({
				item,
				promptTitle: t("stop_sharing_item"),
				promptMessage: t("confirm_stop_sharing"),
				promptOkText: t("stop_sharing"),
				action: () => drive.removeShare({ item }),
				// Close the preview when stopping sharing from inside it.
				dismissOnSuccess: isPreview === true
			})
		})
	}

	if (drivePath.type === "links" && (item.type === "file" || item.type === "directory") && !drivePath.uuid) {
		menuButtons.push({
			id: "editPublicLink",
			requiresOnline: true,
			title: t("edit_public_link"),
			icon: "link",
			onPress: () => {
				warmMetadataCache(item)

				router.push({
					pathname: "/publicLink",
					params: {
						item: serialize(item)
					}
				})
			}
		})

		menuButtons.push({
			id: "copyLink",
			requiresOnline: true,
			title: t("copy_link"),
			icon: "copy",
			onPress: async () => {
				const result = await runWithLoading(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					let linkUuid: string
					let linkKey: string | undefined

					if (item.type === "file") {
						const status = await authedSdkClient.getFileLinkStatus(item.data)

						if (!status) {
							throw new Error("No public link found for this file")
						}

						linkUuid = status.linkUuid
						linkKey = undefined
					} else {
						const status = await authedSdkClient.getDirLinkStatus(item.data)

						if (!status) {
							throw new Error("No public link found for this directory")
						}

						linkUuid = status.linkUuid
						linkKey = status.linkKey ?? undefined
					}

					const url = makeDriveItemPublicLink({ item, linkUuid, linkKey })

					if (!url) {
						throw new Error("Could not generate public link URL")
					}

					await Clipboard.setStringAsync(url)
				})

				if (!result.success) {
					logger.error("drive", "copy public link failed", { error: result.error, uuid: item.data.uuid })
					alerts.error(result.error)

					return
				}

				alerts.normal(t("copied_to_clipboard"))
			}
		})

		menuButtons.push({
			id: "disablePublicLink",
			requiresOnline: true,
			title: t("disable_public_link"),
			icon: "delete",
			destructive: true,
			onPress: confirmedDriveAction({
				item,
				promptTitle: t("disable_public_link"),
				promptMessage: t("confirm_disable_public_link"),
				promptOkText: t("disable"),
				action: () => drive.disablePublicLink({ item }),
				// Close the preview when disabling the link from inside it.
				dismissOnSuccess: isPreview === true
			})
		})
	}

	// Removing offline only makes sense on items that are TOP-LEVEL stored entries.
	// `updateIndex()` flattens every nested child of a stored directory into
	// `index.files` / `index.directories`, so a plain "is stored offline" check
	// (the query backing `isStoredOffline`) returns true for nested children too —
	// but `removeItem` only operates on top-level entries, so showing the button
	// there is a silent no-op. The sync top-level check fixes that. Cold-cache
	// falls back to undefined → hidden, which is acceptable: the per-row query
	// (`useDriveItemStoredOfflineQuery`) warms the caches on first read.
	//
	//   - At /offline (virtual root) we know every item shown IS top-level, so
	//     skip the per-item check.
	//   - Anywhere else (/drive, /favorites, etc.), only show on items that are
	//     known top-level stored. /offline nested view and /linked never show.
	if (
		(drivePath.type === "offline" && !drivePath.uuid) ||
		(offline.isItemTopLevelStoredSync(item) === true && drivePath.type !== "offline" && drivePath.type !== "linked")
	) {
		menuButtons.push({
			id: "removeOffline",
			title: t("remove_offline"),
			icon: "trash",
			destructive: true,
			onPress: confirmedDriveAction({
				item,
				promptTitle: t("remove_offline_item"),
				promptMessage: t("confirm_remove_offline"),
				promptOkText: t("remove_offline"),
				action: () => offline.removeItem(item),
				dismissOnSuccess: false
			})
		})
	}

	if (drivePath.type !== "trash" && drivePath.type !== "sharedIn" && drivePath.type !== "offline" && drivePath.type !== "linked") {
		menuButtons.push({
			id: "trash",
			requiresOnline: true,
			title: t("trash"),
			icon: "trash",
			destructive: true,
			// Note: this is the one destructive action whose confirm alert is NOT styled
			// destructive (no `destructive: true` on the prompt) — preserved via promptDestructive: false.
			onPress: confirmedDriveAction({
				item,
				promptTitle: t("trash_item"),
				promptMessage: t("confirm_trash"),
				promptOkText: t("trash"),
				promptDestructive: false,
				action: () => drive.trash({ item }),
				// trash emits driveItemRemoved, which the gallery's own subscriber acts on —
				// moving to a neighbour, or popping (once) when it was the last previewed item.
				// So DON'T also self-pop here: in a single-item preview both pops fired (the
				// gallery's navigateBack + confirmedAction's router.back) and double-popped past
				// the gallery; in a multi-item gallery it closed instead of advancing.
				dismissOnSuccess: false
			})
		})
	}

	if ((item.type === "file" || item.type === "directory") && drivePath.type === "trash") {
		menuButtons.push({
			id: "restore",
			requiresOnline: true,
			title: t("restore"),
			icon: "restore",
			onPress: async () => {
				const result = await runWithLoading(async () => {
					await drive.restore({
						item
					})
				})

				if (!result.success) {
					logger.error("drive", "restore failed", { error: result.error, uuid: item.data.uuid })
					alerts.error(result.error)

					return
				}
			}
		})
	}

	if ((item.type === "file" || item.type === "directory") && drivePath.type === "trash") {
		menuButtons.push({
			id: "deletePermanently",
			requiresOnline: true,
			title: t("delete_permanently"),
			icon: "delete",
			destructive: true,
			onPress: confirmedDriveAction({
				item,
				promptTitle: t("delete_permanently_item"),
				promptMessage: t("confirm_delete_permanently"),
				promptOkText: t("delete_permanently"),
				action: () => drive.deletePermanently({ item }),
				// deletePermanently emits driveItemRemoved → the gallery's subscriber owns the
				// navigation (neighbour, or a single pop when it was the last previewed item).
				// Don't also self-pop (would double-pop a single-item preview / close a
				// multi-item gallery instead of advancing). From the trash LIST this is a no-op
				// either way (isPreview was false there).
				dismissOnSuccess: false
			})
		})
	}

	return menuButtons
}
