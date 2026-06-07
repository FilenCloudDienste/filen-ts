import { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import { router } from "expo-router"
import drive from "@/features/drive/drive"
import alerts from "@/lib/alerts"
import { confirmedDriveAction } from "@/features/drive/components/item/menuActionsShared"
import { buildUndecryptableMenuButtons } from "@/features/drive/components/item/menuActionsUndecryptable"
import { buildDownloadSubButtons } from "@/features/drive/components/item/menuActionsDownload"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import { randomUUID } from "expo-crypto"
import offline from "@/features/offline/offline"
import { getRealDriveItemParent } from "@/lib/sdkUnwrap"
import { getPreviewType } from "@/lib/previewType"
import type { DrivePath, SelectOptions } from "@/hooks/useDrivePath"
import { serialize } from "@/lib/serializer"
import { selectContacts } from "@/features/contacts/contactsSelect"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { type TFunction } from "i18next"
import { isFileItem, isDirectoryItem } from "@/features/drive/driveSelectors"

export function createMenuButtons({
	item,
	drivePath,
	isStoredOffline,
	showSelectToggle,
	t
}: {
	item: DriveItem
	drivePath: DrivePath
	isStoredOffline: boolean
	showSelectToggle?: boolean
	t: TFunction
}): MenuButton[] {
	if (item.data.undecryptable) {
		return buildUndecryptableMenuButtons({ item, drivePath, t })
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

	if (
		isDirectoryItem(item) &&
		(drivePath.type === "drive" ||
			drivePath.type === "sharedIn" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "favorites" ||
			drivePath.type === "links" ||
			drivePath.type === "offline" ||
			drivePath.type === "linked")
	) {
		menuButtons.push({
			id: "open",
			title: t("open"),
			icon: "folder",
			onPress: () => {
				router.push({
					pathname: drivePath.selectOptions
						? "/driveSelect/[uuid]"
						: drivePath.type === "offline"
							? "/offline/[uuid]"
							: drivePath.type === "links"
								? "/links/[uuid]"
								: drivePath.type === "drive"
									? "/tabs/drive/[uuid]"
									: drivePath.type === "sharedIn"
										? "/sharedIn/[uuid]"
										: drivePath.type === "linked"
											? "/linkedDir/[uuid]"
											: drivePath.type === "sharedOut"
												? "/sharedOut/[uuid]"
												: "",
					params: {
						uuid: item.data.uuid,
						selectOptions: drivePath.selectOptions ? serialize(drivePath.selectOptions) : undefined,
						linked: drivePath.linked ? serialize(drivePath.linked) : undefined
					}
				})
			}
		})
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
					console.error(result.error)
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
				title: t("versions"),
				icon: "versions",
				onPress: () => {
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
			title: t("color"),
			icon: "color",
			onPress: () => {
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
					console.error(promptResult.error)
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
					console.error(result.error)
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
							console.error(pickResult.error)
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
							console.error(result.error)
							alerts.error(result.error)
						}
					}
				}
			]
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

	if (drivePath.type === "sharedIn" && !drivePath.uuid) {
		menuButtons.push({
			id: "removeShare",
			requiresOnline: true,
			title: t("remove_share"),
			icon: "delete",
			destructive: true,
			// TODO: if we are in a preview, close the preview after removing the share
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
				dismissOnSuccess: false
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
			// TODO: if we are in a preview, close the preview after stopping sharing the item
			onPress: confirmedDriveAction({
				item,
				promptTitle: t("stop_sharing_item"),
				promptMessage: t("confirm_stop_sharing"),
				promptOkText: t("stop_sharing"),
				action: () => drive.removeShare({ item }),
				dismissOnSuccess: false
			})
		})
	}

	if (drivePath.type === "links" && (item.type === "file" || item.type === "directory") && !drivePath.uuid) {
		menuButtons.push({
			id: "disablePublicLink",
			requiresOnline: true,
			title: t("disable_public_link"),
			icon: "delete",
			destructive: true,
			// TODO: if we are in a preview, close the preview after
			onPress: confirmedDriveAction({
				item,
				promptTitle: t("disable_public_link"),
				promptMessage: t("confirm_disable_public_link"),
				promptOkText: t("disable"),
				action: () => drive.disablePublicLink({ item }),
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
			// TODO: if we are in a preview, close the preview after trashing the item
			//
			// Note: this is the one destructive action whose confirm alert is NOT styled
			// destructive (no `destructive: true` on the prompt) — preserved via promptDestructive: false.
			onPress: confirmedDriveAction({
				item,
				promptTitle: t("trash_item"),
				promptMessage: t("confirm_trash"),
				promptOkText: t("trash"),
				promptDestructive: false,
				action: () => drive.trash({ item }),
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
					console.error(result.error)
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
				dismissOnSuccess: true
			})
		})
	}

	return menuButtons
}
