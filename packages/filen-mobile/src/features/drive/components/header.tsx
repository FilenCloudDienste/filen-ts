import { useNavigation } from "expo-router"
import { router } from "@/lib/router"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "uniwind"
import { Platform } from "react-native"
import { useShallow } from "zustand/shallow"
import { run } from "@filen/utils"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import useDrivePath from "@/hooks/useDrivePath"
import { type DriveSearchStatus } from "@/features/drive/hooks/useDriveSearch"
import { useDriveSortPreference } from "@/features/drive/driveSortPreference"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/features/drive/drive"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { useStringifiedClient } from "@/lib/auth"
import offlineSync from "@/features/offline/offlineSync"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import { aggregateDriveSelectionFlags } from "@/features/drive/driveSelectors"
import { resolveDriveHeaderTitle } from "@/features/drive/utils"
import { useDriveUpload } from "@/features/drive/hooks/useDriveUpload"
import { buildSortMenuButton, buildBulkActionMenu } from "@/features/drive/components/headerMenuBuilders"
import { getDriveParent, canShowDriveCreateMenu, buildDriveCreateMenuButtons } from "@/features/drive/components/driveCreateMenu"
import logger from "@/lib/logger"

const Header = ({
	setSearchQuery,
	listItems,
	searchStatus
}: {
	setSearchQuery: React.Dispatch<React.SetStateAction<string>>
	// The search-filtered, sorted set the list body actually renders. Select-all
	// and the select/deselect-all toggle MUST operate on this same visible set —
	// not the unfiltered query data — or they'd target search-hidden items. It is
	// ALSO the cross-reference set for bulk-action flags, so cross-directory cache
	// search results carry fresh metadata into the bulk toolbar.
	listItems: DriveItem[]
	// Cache-backed search status. Drives the non-blocking header "searching" spinner
	// (warming/background) and gates select-all until the result set has settled.
	searchStatus: DriveSearchStatus
}) => {
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const selectedDriveItems = useDriveStore(useShallow(state => state.selectedItems))
	const drivePath = useDrivePath()
	const stringifiedClient = useStringifiedClient()
	const offlineSyncing = useOfflineStore(state => state.syncing)
	const { t } = useTranslation()
	// Drive is rendered from /tabs/drive (a tab), every modal that delegates to it
	// (trash, recents, favorites, links, sharedIn, sharedOut, offline, driveSelect,
	// linkedDir), AND nested screens within those. The header's left-side button has
	// to differ by context:
	//   - tab root  : no back (swipe between tabs)
	//   - modal root: "close" (X) — dismiss the whole modal
	//   - modal sub : "chevron-back-outline" — pop one level in the modal stack
	//
	// `drivePath.type` is the stable tab-vs-modal discriminator: it's derived from
	// the route Drive is mounted under, NOT the currently focused URL. Crucially
	// `useSegments()` would flip when ANY other modal opens on top (e.g. opening
	// changeDirectoryColor from /tabs/drive briefly painted "close" onto the drive
	// tab header during the open animation). drivePath does not flip.
	//
	// Every Drive-rendered modal folder (trash, recents, favorites, links,
	// sharedIn, sharedOut, offline, driveSelect, linkedDir) has its own
	// `_layout.tsx` so `useNavigation().getState()` is the modal's INTERNAL stack —
	// index 0 reliably means "first screen of this modal", any other value means
	// "the user navigated deeper inside the same modal."
	const navigation = useNavigation()
	const inTabContext = drivePath.type === "drive" && !drivePath.selectOptions
	const isAtStackRoot = (navigation.getState()?.index ?? 0) === 0
	const { sort: currentSort, setSort, sortable } = useDriveSortPreference(drivePath)

	const parent = getDriveParent(drivePath)

	const upload = useDriveUpload({ parent, drivePath, t })

	const rightItems = (() => {
		if (drivePath.selectOptions) {
			return []
		}

		const selectionMode = selectedDriveItems.length > 0
		const items: HeaderItem[] = []
		const menuButtons: MenuButton[] = []

		if (sortable && !selectionMode) {
			menuButtons.push(buildSortMenuButton(currentSort, setSort, t))
		}

		// Select-all / deselect-all must mirror the list body's VISIBLE (search-
		// filtered) set, not the unfiltered query data. With a search active,
		// `listItems` is the narrowed subset the user actually sees; selecting all
		// of the directory listing would silently pick search-hidden items and the
		// toggle label would be wrong. With no search active `listItems === itemsSorted`,
		// so behavior is identical to before.
		//
		// Don't offer select-all on a still-converging cache search (warming/background):
		// the visible set keeps growing as the resync lands, so "all" would be a partial
		// set. Deselect-all stays available so an existing selection can always be cleared.
		const canSelectAll = searchStatus === "idle" || searchStatus === "settled"

		if (listItems.length > 0) {
			if (selectedDriveItems.length === listItems.length) {
				menuButtons.push({
					id: "deselectAll",
					title: t("deselect_all"),
					icon: "select",
					onPress: () => {
						useDriveStore.getState().clearSelectedItems()
					}
				})
			} else if (canSelectAll) {
				menuButtons.push({
					id: "selectAll",
					title: t("select_all"),
					icon: "select",
					onPress: () => {
						useDriveStore.getState().selectAllItems(listItems.filter(i => !i.data.undecryptable))
					}
				})
			}
		}

		if (canShowDriveCreateMenu({ drivePath, parent, selectionMode })) {
			menuButtons.push(...buildDriveCreateMenuButtons({ t, parent, upload }))
		}

		if (!selectionMode) {
			menuButtons.push({
				id: "transfers",
				title: t("transfers"),
				icon: "list",
				onPress: () => {
					router.push("/transfers")
				}
			})

			// Manual offline-cache sync trigger. Auto-sync runs on every offline→online
			// transition (reconnect.ts), but the offline tab is where users go when they
			// expect their cached set to be current — surface a way to nudge it.
			if (drivePath.type === "offline") {
				menuButtons.push({
					id: "syncNow",
					title: offlineSyncing ? t("syncing") : t("sync_now"),
					icon: "restore",
					// offlineSync.sync() silently no-ops when offline; gate the button so
					// the user gets a disabled affordance instead of zero feedback.
					// manual: true — the user-initiated trigger bypasses the auto min-interval.
					requiresOnline: true,
					disabled: offlineSyncing,
					onPress: () => {
						offlineSync.sync({ manual: true }).catch(e => logger.warn("drive", "offline sync failed", { error: e }))
					}
				})
			}
		}

		if (selectedDriveItems.length > 0) {
			// Cross-reference selected items with the VISIBLE list (`listItems`) before
			// aggregating flags. This is the rendered set — the directory listing when
			// browsing, the cache-search result set when searching — so a cross-directory
			// search hit resolves to its fresh metadata here (the current-directory query
			// wouldn't contain it). Falls back to the selection entry itself when absent.
			// Otherwise stale selection entries (e.g. an item that became undecryptable
			// after a key change, or whose favorited state flipped via socket event) would
			// feed outdated booleans into the bulk toolbar.
			const liveItems = selectedDriveItems.map(sel => listItems.find(live => live.data.uuid === sel.data.uuid) ?? sel)
			const driveFlags = aggregateDriveSelectionFlags(liveItems)

			for (const button of buildBulkActionMenu({
				drivePath,
				selectedDriveItems,
				liveItems,
				driveFlags,
				t
			})) {
				menuButtons.push(button)
			}
		}

		if (drivePath.type === "trash" && !selectionMode) {
			menuButtons.push({
				id: "empty",
				title: t("empty_trash"),
				requiresOnline: true,
				destructive: true,
				icon: "delete",
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: t("empty_trash"),
							message: t("are_you_sure_empty_trash"),
							cancelText: t("cancel"),
							okText: t("empty"),
							destructive: true
						})
					})

					if (!promptResult.success) {
						logger.warn("drive", "empty trash prompt failed", { error: promptResult.error })
						alerts.error(promptResult.error)

						return
					}

					if (promptResult.data.cancelled) {
						return
					}

					const result = await runWithLoading(async () => {
						await drive.emptyTrash({
							signal: undefined
						})
					})

					if (!result.success) {
						logger.error("drive", "empty trash failed", { error: result.error })
						alerts.error(result.error)

						return
					}
				}
			})
		}

		// Non-blocking in-flight indicator for the cache-backed search. `warming` is the
		// initial index warm-up (the list body shows its own spinner until the first
		// snapshot); `background` is "results shown, still converging"; `searching-empty` is
		// "no matches yet, still converging" — this top-right spinner is the always-visible
		// signal for all three (the footer can scroll off / the empty state is centered).
		if (searchStatus === "warming" || searchStatus === "background" || searchStatus === "searching-empty") {
			items.push({
				type: "loader"
			})
		}

		if (menuButtons.length > 0) {
			items.push({
				type: "menu",
				props: {
					type: "dropdown",
					hitSlop: 20,
					buttons: menuButtons
				},
				triggerProps: {
					hitSlop: 20
				},
				icon: {
					name: "ellipsis-horizontal",
					size: 24,
					color: textForeground.color
				}
			})
		}

		if (items.length === 0) {
			return []
		}

		return items
	})()

	const leftItems = ((): HeaderItem[] => {
		// Selection mode "X" clears the bulk selection — different semantic from
		// modal-close. Always wins regardless of context.
		if (selectedDriveItems.length > 0) {
			return [
				{
					type: "button",
					icon: {
						name: "close-outline",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							useDriveStore.getState().clearSelectedItems()
						}
					}
				}
			] satisfies HeaderItem[]
		}

		// Tab context (`/tabs/drive[...]`): no explicit back button. iOS uses the
		// swipe-back gesture inside the tab's stack; tab root has nothing to go
		// back to.
		if (inTabContext) {
			return []
		}

		// Modal context. Android shows the OS back affordance; iOS gets the
		// explicit close-vs-chevron based on stack position.
		if (Platform.OS !== "ios") {
			return []
		}

		return [
			{
				type: "button",
				icon: {
					name: isAtStackRoot ? "close" : "chevron-back-outline",
					color: textForeground.color,
					size: 20
				},
				props: {
					onPress: () => {
						router.back()
					}
				}
			}
		] satisfies HeaderItem[]
	})()

	const headerTitle = resolveDriveHeaderTitle({
		drivePath,
		selectedCount: selectedDriveItems.length,
		stringifiedClientRootUuid: stringifiedClient?.rootUuid ?? null,
		t
	})

	return (
		<StackHeader
			title={headerTitle}
			transparent={Platform.OS === "ios"}
			backVisible={leftItems.length === 0 && selectedDriveItems.length === 0}
			shadowVisible={false}
			backgroundColor={
				drivePath.type !== "drive" || drivePath.selectOptions
					? Platform.select({
							ios: undefined,
							default: bgBackgroundSecondary.backgroundColor as string
						})
					: undefined
			}
			leftItems={leftItems}
			rightItems={rightItems}
			searchBarOptions={{
				placement: "integratedButton",
				placeholder: t("search_drive"),
				onChangeText: e => setSearchQuery(e.nativeEvent.text),
				onCancelButtonPress: () => setSearchQuery(""),
				onClose: () => setSearchQuery(""),
				onOpen: () => setSearchQuery(""),
				allowToolbarIntegration: false,
				headerIconColor: textForeground.color,
				textColor: textForeground.color,
				barTintColor: "transparent",
				tintColor: textForeground.color,
				hintTextColor: textMutedForeground.color,
				shouldShowHintSearchIcon: true,
				hideNavigationBar: false,
				hideWhenScrolling: false,
				inputType: "text"
			}}
		/>
	)
}

export default Header
