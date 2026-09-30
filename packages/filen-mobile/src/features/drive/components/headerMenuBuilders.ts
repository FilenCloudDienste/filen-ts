import { type TFunction } from "i18next"
import { run } from "@filen/shared"
import { type DriveViewMode } from "@/features/drive/driveViewModePreference"
import { randomUUID } from "expo-crypto"
import { type MenuButton } from "@/components/ui/menu"
import { type Icons } from "@/components/ui/menuIcons"
import { buildSortFieldButton, type SortDirectionOption } from "@/components/ui/sortFieldMenu"
import { type DrivePath } from "@/hooks/useDrivePath"
import { openDriveSelect } from "@/features/drive/driveSelectSession"
import type { DriveItem } from "@/types"
import { type SortByType } from "@/lib/sort"
import alerts from "@/lib/alerts"
import drive from "@/features/drive/drive"
import { clearDriveSelection } from "@/features/drive/store/useDrive.store"
import { getRealDriveItemParent } from "@/lib/sdkUnwrap"
import offline from "@/features/offline/offline"
import { storeItemOffline } from "@/features/offline/storeItem"
import { runBulk } from "@/lib/bulkOps"
import { type DriveSelectionFlags } from "@/features/drive/driveSelectors"
import { downloadDriveItemToDevice, ensureSaveToPhotosPermission, saveDriveItemToPhotos } from "@/features/drive/driveDownload"
import { selectContacts } from "@/features/contacts/contactsSelect"
import { buildCopyMenuButton, offersCopy } from "@/features/drive/components/item/menuActionsCopy"
import { buildSaveToCloudDriveButton } from "@/features/drive/linkedSave"
import logger from "@/lib/logger"

export function buildSortMenuButton(current: SortByType, setSort: (next: SortByType) => void, t: TFunction): MenuButton {
	// Each field's two directions live one level deeper. buildSortFieldButton keeps them as a nested
	// submenu on iOS and collapses them into a direction ActionSheet on Android (which cannot render a
	// 3rd menu level — see components/ui/sortFieldMenu).
	const field = (
		id: string,
		title: string,
		icon: Icons,
		asc: SortDirectionOption<SortByType>,
		desc: SortDirectionOption<SortByType>
	): MenuButton => buildSortFieldButton({ id, title, icon, options: [asc, desc], current, setSort, t })

	return {
		id: "sort",
		title: t("sort_by"),
		icon: "list",
		subButtons: [
			field(
				"sort.name",
				t("sort_name"),
				"text",
				{ id: "sort.nameAsc", title: t("sort_name_asc"), value: "nameAsc" },
				{ id: "sort.nameDesc", title: t("sort_name_desc"), value: "nameDesc" }
			),
			field(
				"sort.size",
				t("sort_size"),
				"size",
				{ id: "sort.sizeAsc", title: t("sort_size_asc"), value: "sizeAsc" },
				{ id: "sort.sizeDesc", title: t("sort_size_desc"), value: "sizeDesc" }
			),
			field(
				"sort.type",
				t("sort_type"),
				"doc",
				{ id: "sort.mimeAsc", title: t("sort_type_asc"), value: "mimeAsc" },
				{ id: "sort.mimeDesc", title: t("sort_type_desc"), value: "mimeDesc" }
			),
			field(
				"sort.modified",
				t("sort_modified"),
				"clock",
				{ id: "sort.lastModifiedAsc", title: t("sort_modified_asc"), value: "lastModifiedAsc" },
				{ id: "sort.lastModifiedDesc", title: t("sort_modified_desc"), value: "lastModifiedDesc" }
			),
			field(
				"sort.uploaded",
				t("sort_uploaded"),
				"upload",
				{ id: "sort.uploadDateAsc", title: t("sort_uploaded_asc"), value: "uploadDateAsc" },
				{ id: "sort.uploadDateDesc", title: t("sort_uploaded_desc"), value: "uploadDateDesc" }
			),
			field(
				"sort.created",
				t("sort_created"),
				"calendar",
				{ id: "sort.creationAsc", title: t("sort_created_asc"), value: "creationAsc" },
				{ id: "sort.creationDesc", title: t("sort_created_desc"), value: "creationDesc" }
			)
		]
	}
}

// Builds the view-mode toggle submenu (a depth-2 "View" submenu with List/Grid
// radio leaves). Android-safe: @react-native-menu/menu supports one level of
// nesting (submenu inside a root button), matching the notes viewMode menu shape.
export function buildViewModeMenuButton(current: DriveViewMode, setViewMode: (next: DriveViewMode) => void, t: TFunction): MenuButton {
	return {
		id: "viewMode",
		title: t("view"),
		icon: current === "grid" ? "grid" : "list",
		subButtons: [
			{
				id: "viewMode.list",
				title: t("view_list"),
				icon: "list",
				checked: current === "list",
				onPress: () => setViewMode("list")
			},
			{
				id: "viewMode.grid",
				title: t("view_grid"),
				icon: "grid",
				checked: current === "grid",
				onPress: () => setViewMode("grid")
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
	linkSaveable,
	t
}: {
	drivePath: DrivePath
	selectedDriveItems: DriveItem[]
	liveItems: DriveItem[]
	driveFlags: DriveSelectionFlags
	// A link view whose link may be saved (useLinkSaveable).
	linkSaveable?: boolean
	t: TFunction
}): MenuButton[] {
	const menuButtons: MenuButton[] = []
	const isAtRoot = !drivePath.uuid

	const hasUndecryptable = driveFlags.includesUndecryptable

	// Confirm title reuses the button title.
	const confirmBulkButton = ({
		id,
		title,
		icon,
		message,
		okText,
		destructive,
		requiresOnline,
		op
	}: {
		id: string
		title: string
		icon: Icons
		message: string
		okText: string
		destructive?: boolean
		requiresOnline?: boolean
		op: (item: DriveItem) => Promise<unknown>
	}): MenuButton => ({
		id,
		title,
		icon,
		destructive,
		requiresOnline,
		onPress: async () => {
			await runBulk({
				items: selectedDriveItems,
				clearSelection: clearDriveSelection,
				confirm: {
					title,
					message,
					okText,
					cancelText: t("cancel"),
					destructive
				},
				op
			})
		}
	})

	if (drivePath.type === "trash") {
		menuButtons.push(
			confirmBulkButton({
				id: "restoreSelected",
				title: t("restore_selected"),
				icon: "restore",
				message: t("are_you_sure_restore_selected"),
				okText: t("restore"),
				requiresOnline: true,
				op: item => drive.restore({ item })
			})
		)

		menuButtons.push(
			confirmBulkButton({
				id: "deleteSelectedPermanently",
				title: t("delete_selected_permanently"),
				icon: "delete",
				message: t("are_you_sure_delete_selected_permanently"),
				okText: t("delete"),
				destructive: true,
				requiresOnline: true,
				op: item => drive.deletePermanently({ item })
			})
		)

		return menuButtons
	}

	// Favorite/Unfavorite first — toggle is the most-tapped bulk
	// action, belongs at the top of the menu.
	if (
		!hasUndecryptable &&
		driveFlags.everyNormalItem &&
		(drivePath.type === "drive" || drivePath.type === "recents" || drivePath.type === "favorites" || drivePath.type === "sharedOut")
	) {
		menuButtons.push({
			id: "bulkFavorite",
			title: driveFlags.includesFavorited ? t("unfavorite_selected") : t("favorite_selected"),
			icon: "heart",
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
					clearSelection: clearDriveSelection,
					op: item =>
						drive.favorite({
							item,
							favorited: !driveFlags.includesFavorited
						})
				})
			}
		})
	}

	const offersMove =
		!hasUndecryptable &&
		driveFlags.everyNormalItem &&
		(drivePath.type === "drive" ||
			drivePath.type === "favorites" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "links" ||
			drivePath.type === "recents")

	// Move — modify (location) comes before output (download/share).
	// driveSelectToolbar already handles `Promise.all` over the items
	// it receives, so the bulk handler just opens the picker with all
	// selected items. useFocusEffect on Drive clears selection when
	// we return.
	if (offersMove) {
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
					logger.error("drive", "bulk move: failed to get root uuid", { error: driveRootUuidResult.error })
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
						items: selectedDriveItems,
						id: randomUUID()
					}
				})
			}
		})
	}

	if (drivePath.type === "linked" && linkSaveable && !hasUndecryptable) {
		const saveButton = buildSaveToCloudDriveButton({
			id: "bulkSaveToCloudDrive",
			title: t("save_selected_to_cloud_drive"),
			items: selectedDriveItems,
			onDone: clearDriveSelection
		})

		if (saveButton) {
			menuButtons.push(saveButton)
		}
	}

	if (!hasUndecryptable && offersCopy(drivePath)) {
		menuButtons.push(
			buildCopyMenuButton({
				items: selectedDriveItems,
				withCut: offersMove,
				bulk: true,
				onDone: clearDriveSelection,
				t
			})
		)
	}

	// Download to device — applies to every read-capable variant.
	if (
		!hasUndecryptable &&
		(drivePath.type === "drive" ||
			drivePath.type === "recents" ||
			drivePath.type === "favorites" ||
			drivePath.type === "sharedIn" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "links")
	) {
		menuButtons.push({
			id: "bulkDownload",
			title: t("download_selected"),
			icon: "download",
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
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
	}

	// Save to photos — every selected item must be a file with an
	// image/video preview type (the OS photo library only accepts
	// those). Aggregator flag is computed once via getPreviewType
	// over decryptedMeta.name.
	if (
		!hasUndecryptable &&
		driveFlags.everyImageOrVideoFile &&
		(drivePath.type === "drive" || drivePath.type === "recents" || drivePath.type === "favorites")
	) {
		menuButtons.push({
			id: "bulkSaveToPhotos",
			title: t("save_to_photos"),
			icon: "image",
			requiresOnline: true,
			onPress: async () => {
				if (!(await ensureSaveToPhotosPermission(t))) {
					return
				}

				await runBulk({
					items: selectedDriveItems,
					background: true,
					clearSelection: clearDriveSelection,
					op: saveDriveItemToPhotos
				})
			}
		})
	}

	// Share with Filen user — re-encrypts each item under each
	// recipient's public key (SDK shareDir / shareFile). Grouped with
	// the other "output" actions (download / save-to-photos). The
	// picker is the confirmation gesture; no extra confirm dialog.
	if (
		!hasUndecryptable &&
		(drivePath.type === "drive" || drivePath.type === "recents" || drivePath.type === "favorites" || drivePath.type === "sharedOut")
	) {
		menuButtons.push({
			id: "bulkShareFilenUser",
			title: t("share_filen_user"),
			icon: "users",
			requiresOnline: true,
			onPress: async () => {
				const pickResult = await run(async () => {
					return await selectContacts()
				})

				if (!pickResult.success) {
					logger.warn("drive", "bulk share: contact picker failed", { error: pickResult.error })
					alerts.error(pickResult.error)

					return
				}

				if (pickResult.data.cancelled || pickResult.data.selectedContacts.length === 0) {
					return
				}

				const contacts = pickResult.data.selectedContacts

				await runBulk({
					items: selectedDriveItems,
					clearSelection: clearDriveSelection,
					op: async item => {
						await Promise.all(contacts.map(contact => drive.shareWithFilenUser({ item, contact })))
					}
				})
			}
		})
	}

	// Make offline / Remove offline — keep them as two separate buttons
	// instead of a single toggle. Toggling would need per-item offline
	// status (read from the in-memory offline index) and the user's intent for a mixed selection is
	// ambiguous anyway. The lib's idempotent semantics make
	// already-offline / already-online items no-ops, so showing both
	// is safe.
	//
	// Discoverability gate: per-item Make-offline hides when the item is
	// already stored. Mirror that in bulk by hiding bulkMakeOffline when
	// every selected item is known to be stored offline. Falls back to
	// "show" when the per-item cache hasn't been populated yet.
	const everySelectedKnownStoredOffline = liveItems.every(it => offline.isItemStoredSync(it) === true)

	// Offline storage needs each item's PARENT directory resolved from cache
	// (getRealDriveItemParent). A cache-search result from a never-browsed directory has an
	// uncached parent → unresolvable. Mirror the single-item Make-offline contract (which
	// HIDES its button when the parent is null, menuActionsDownload.ts) by hiding the bulk
	// action unless EVERY selected item's parent resolves — otherwise the op below would
	// silently skip those items while runBulk reports success (clearing the selection).
	const everySelectedParentResolvable = liveItems.every(it => getRealDriveItemParent({ item: it, drivePath }) !== null)

	if (
		!hasUndecryptable &&
		// Read-capable variants (mirrors bulkDownload). Single-item Make-offline is not variant-gated
		// either — it shows wherever the parent resolves — so bulk must match: the parent-resolvability
		// + not-already-stored guards below cover the edge cases (e.g. a nested sharedIn item whose
		// containing folder wasn't browsed → parent unresolvable → button hidden, like the single-item
		// contract). The offline lib fully supports shared items (offlineSync's listing-based flows).
		(drivePath.type === "drive" ||
			drivePath.type === "recents" ||
			drivePath.type === "favorites" ||
			drivePath.type === "sharedIn" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "links") &&
		!everySelectedKnownStoredOffline &&
		everySelectedParentResolvable
	) {
		menuButtons.push({
			id: "bulkMakeOffline",
			title: t("make_available_offline"),
			icon: "archive",
			requiresOnline: true,
			onPress: async () => {
				await runBulk({
					items: selectedDriveItems,
					background: true,
					clearSelection: clearDriveSelection,
					op: async item => {
						const parent = getRealDriveItemParent({ item, drivePath })

						if (!parent) {
							// Defense-in-depth: the visibility gate above hides this action when any
							// parent is unresolvable, so this shouldn't be reached. If it is, THROW
							// (not silent return) so runBulk surfaces an error + keeps the selection,
							// instead of reporting a false success that stored nothing.
							throw new Error(t("offline_location_unavailable"))
						}

						await storeItemOffline({ item, parent })
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
		menuButtons.push(
			confirmBulkButton({
				id: "bulkRemoveOffline",
				title: t("remove_offline"),
				icon: "trash",
				message: t("confirm_remove_offline_selected"),
				okText: t("remove_offline"),
				destructive: true,
				op: item => offline.removeItem(item)
			})
		)
	}

	// Trash — owned content the user can move to trash (excludes sharedIn / offline)
	if (
		drivePath.type === "drive" ||
		drivePath.type === "favorites" ||
		drivePath.type === "sharedOut" ||
		drivePath.type === "links" ||
		drivePath.type === "recents"
	) {
		menuButtons.push(
			confirmBulkButton({
				id: "bulkTrash",
				title: t("trash_selected"),
				icon: "trash",
				message: t("are_you_sure_trash_selected"),
				okText: t("trash"),
				destructive: true,
				requiresOnline: true,
				op: item => drive.trash({ item })
			})
		)
	}

	// Stop-sharing — sharedOut at root only
	if (drivePath.type === "sharedOut" && isAtRoot) {
		menuButtons.push(
			confirmBulkButton({
				id: "bulkStopSharing",
				title: t("stop_sharing_selected"),
				icon: "delete",
				message: t("are_you_sure_stop_sharing_selected"),
				okText: t("stop_sharing"),
				destructive: true,
				requiresOnline: true,
				op: item => drive.removeShare({ item })
			})
		)
	}

	// Remove-share — sharedIn at root only (declines a share invite for selected items)
	if (drivePath.type === "sharedIn" && isAtRoot) {
		menuButtons.push(
			confirmBulkButton({
				id: "bulkRemoveShare",
				title: t("remove_share_selected"),
				icon: "delete",
				message: t("are_you_sure_remove_share_selected"),
				okText: t("remove"),
				destructive: true,
				requiresOnline: true,
				op: item => drive.removeShare({ item })
			})
		)
	}

	// Disable public link — links variant root only
	if (drivePath.type === "links" && isAtRoot) {
		menuButtons.push(
			confirmBulkButton({
				id: "bulkDisablePublicLink",
				title: t("disable_public_link_selected"),
				icon: "delete",
				message: t("are_you_sure_disable_public_link_selected"),
				okText: t("disable"),
				destructive: true,
				requiresOnline: true,
				op: item => drive.disablePublicLink({ item })
			})
		)
	}

	return menuButtons
}
