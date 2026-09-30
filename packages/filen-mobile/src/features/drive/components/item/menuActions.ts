import { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import { router } from "@/lib/router"
import drive from "@/features/drive/drive"
import alerts from "@/lib/alerts"
import {
	buildDeletePermanentlyButton,
	buildRestoreButton,
	buildTrashButton,
	confirmedDriveAction,
	offersTrash
} from "@/features/drive/components/item/menuActionsShared"
import { notifyIfNameIsHidden } from "@/features/drive/components/hiddenNameNotice"
import { buildUndecryptableMenuButtons } from "@/features/drive/components/item/menuActionsUndecryptable"
import { buildDownloadSubButtons, buildExportButton, buildOpenWithButton } from "@/features/drive/components/item/menuActionsDownload"
import { buildCopyMenuButton, offersCopy } from "@/features/drive/components/item/menuActionsCopy"
import { buildPasteIntoMenuButton, offersPasteInto } from "@/features/drive/components/clipboardMenu"
import { type DriveClipboardEntry } from "@/features/drive/store/useDriveClipboard.store"
import { buildSaveToCloudDriveButton, linkAllowsDownload } from "@/features/drive/linkedSave"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { inputPrompt } from "@/lib/promptFlow"
import { run } from "@filen/shared"
import { randomUUID } from "expo-crypto"
import offline from "@/features/offline/offline"
import { getRealDriveItemParent, normalParentUuidOf } from "@/lib/sdkUnwrap"
import * as Clipboard from "expo-clipboard"
import { fetchData as fetchPublicLinkStatus, publicLinkUrlFromStatus } from "@/features/drive/queries/useDriveItemPublicLinkStatus.query"
import { getPreviewType } from "@/lib/previewType"
import type { DrivePath } from "@/hooks/useDrivePath"
import { openDriveSelect } from "@/features/drive/driveSelectSession"
import { serialize } from "@/lib/serializer"
import { selectContacts } from "@/features/contacts/contactsSelect"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { type TFunction } from "i18next"
import {
	canNavigateIntoDirectory,
	hiddenFilterAppliesTo,
	isFileItem,
	isOwnEditableView,
	isOwnItemView,
	offersItemInfo,
	resolveDriveContainingDirectoryTarget,
	resolveDriveNavigationTarget
} from "@/features/drive/driveSelectors"
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
	isPreview,
	clipboard,
	linkSaveable,
	t
}: {
	item: DriveItem
	drivePath: DrivePath
	isStoredOffline: boolean
	// True when the menu is rendered inside the full-screen preview (gallery) — so
	// destructive actions that remove the previewed item pop the preview on success.
	// List-row menus leave this false (they must NOT pop the underlying list).
	isPreview?: boolean
	// The drive clipboard, for "Paste into" on directory rows; callers without one offer no paste.
	clipboard?: DriveClipboardEntry | null
	// A link view whose link may be saved (useLinkSaveable): not the account's own, downloads allowed.
	linkSaveable?: boolean
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

	const offersMove = (item.type === "file" || item.type === "directory") && isOwnEditableView(drivePath)

	// Bulk-selection entry: the row's Menu owns iOS long-press (contextmenu),
	// so we can't add an onLongPress to the inner Pressable. The Menu's
	// "Select" item is the entry point — matches the pattern in notes / chats
	// / file versions / contacts. Suppress in picker mode (driveSelect uses a
	// different store) and in the preview (nothing to select there).
	if (!isPreview && !drivePath.selectOptions) {
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

	// Resolved on press: the target serializes route params only a tap needs.
	if (canNavigateIntoDirectory({ item, drivePath })) {
		menuButtons.push({
			id: "open",
			title: t("open"),
			icon: "folder",
			onPress: () => {
				const openTarget = resolveDriveNavigationTarget({ item, drivePath })

				if (openTarget) {
					router.push(openTarget)
				}
			}
		})
	}

	{
		// Search matches the whole subtree, so a hit can sit anywhere below the searched
		// directory — this jumps to the directory holding it. Resolves to null everywhere else
		// (including every row of a normal listing, whose parent IS the open directory).
		//
		// Suppressed inside the preview. The gallery is a modal on the ROOT stack while this
		// pushes into the drive TAB's stack, so expo-router diverges at the root and appends a
		// SECOND tabs route — a duplicate tab bar sliding in over the still-open preview. Every
		// other push in this menu targets a root-level modal, which stacks legitimately. The
		// action is available on the row the preview was opened from.
		const containingTarget = isPreview
			? null
			: resolveDriveContainingDirectoryTarget({
					item,
					parentUuid: normalParentUuidOf(item),
					rootUuid: cache.rootUuid,
					drivePath
				})

		if (containingTarget) {
			menuButtons.push({
				id: "openContainingDirectory",
				title: t("open_containing_directory"),
				icon: "containingFolder",
				onPress: () => {
					router.push(containingTarget)
				}
			})
		}
	}

	// A link that disables downloads offers no way to take its content (see linkAllowsDownload).
	const downloadSubButtons = linkAllowsDownload(drivePath, item)
		? buildDownloadSubButtons({
				item,
				isStoredOffline,
				parentForOfflineStorage,
				previewType,
				t
			})
		: []

	// download + share moved further down (after rename/move) so the menu
	// reads: meta (favorite/info/versions/color) → modify (rename/move) →
	// output (download/share) → destructive. Matches iOS Files conventions.

	if ((item.type === "file" || item.type === "directory") && isOwnItemView(drivePath)) {
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

	if (offersItemInfo(drivePath)) {
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

	if (item.type === "directory" && isOwnEditableView(drivePath)) {
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

	if ((item.type === "file" || item.type === "directory") && isOwnItemView(drivePath)) {
		menuButtons.push({
			id: "rename",
			requiresOnline: true,
			title: t("rename"),
			icon: "edit",
			onPress: async () => {
				const newName = await inputPrompt(
					{
						title: t("rename"),
						message: t("enter_new_name"),
						defaultValue: item.data.decryptedMeta?.name ?? "",
						cancelText: t("cancel"),
						okText: t("rename")
					},
					{ tag: "drive", message: "rename prompt failed" },
					{ trim: true }
				)

				if (newName === null) {
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

				// Same predicate the listing filters by, so the notice can never claim "not listed"
				// about a context that does not filter (the photos timeline, a picker, a share).
				await notifyIfNameIsHidden({
					name: newName,
					action: "renamed",
					appliesHere: hiddenFilterAppliesTo(drivePath),
					t
				})
			}
		})

		if (offersMove) {
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

					openDriveSelect({
						rootUuid: driveRootUuidResult.data,
						options: {
							type: "single",
							files: false,
							directories: true,
							intention: "move",
							items: [item],
							id: randomUUID()
						}
					})
				}
			})
		}
	}

	if (offersCopy(drivePath)) {
		menuButtons.push(
			buildCopyMenuButton({
				items: [item],
				withCut: offersMove,
				bulk: false,
				t
			})
		)
	}

	if (drivePath.type === "linked" && linkSaveable) {
		const saveButton = buildSaveToCloudDriveButton({ id: "saveToCloudDrive", title: t("save_to_cloud_drive"), items: [item] })

		if (saveButton) {
			menuButtons.push(saveButton)
		}
	}

	if (offersPasteInto(drivePath, item)) {
		const pasteInto = buildPasteIntoMenuButton({
			entry: clipboard ?? null,
			targetDir: cache.directoryUuidToAnyNormalDir.get(item.data.uuid),
			// A cut is a move, which only exists within the own drive.
			allowCut: drivePath.type === "drive",
			t
		})

		if (pasteInto) {
			menuButtons.push(pasteInto)
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

	if ((item.type === "file" || item.type === "directory") && isOwnItemView(drivePath)) {
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
							return await selectContacts()
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
				promptTitle: t("remove_share"),
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
				promptTitle: t("stop_sharing"),
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
					const data = await fetchPublicLinkStatus({ uuid: item.data.uuid, item })

					if (!data) {
						throw new Error(t("error_generic"))
					}

					const url = publicLinkUrlFromStatus(item, data)

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
	// (the index read backing `isStoredOffline`) returns true for nested children too —
	// but `removeItem` only operates on top-level entries, so showing the button
	// there is a silent no-op. The sync top-level check fixes that. Cold-cache
	// falls back to undefined → hidden until the next index rebuild fills the caches.
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
				promptTitle: t("remove_offline"),
				promptMessage: t("confirm_remove_offline"),
				promptOkText: t("remove_offline"),
				action: () => offline.removeItem(item),
				dismissOnSuccess: false
			})
		})
	}

	if (offersTrash(drivePath)) {
		menuButtons.push(buildTrashButton({ item, t }))
	}

	if ((item.type === "file" || item.type === "directory") && drivePath.type === "trash") {
		menuButtons.push(buildRestoreButton({ item, t }), buildDeletePermanentlyButton({ item, t }))
	}

	return menuButtons
}
