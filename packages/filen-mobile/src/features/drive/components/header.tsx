import { useNavigation, router } from "expo-router"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "uniwind"
import { Platform } from "react-native"
import { useShallow } from "zustand/shallow"
import { AnyNormalDir } from "@filen/sdk-rs"
import { run } from "@filen/utils"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import { type MenuButton } from "@/components/ui/menu"
import useDrivePath from "@/hooks/useDrivePath"
import useDriveItemsQuery from "@/features/drive/queries/useDriveItems.query"
import { useDriveSortPreference } from "@/features/drive/driveSortPreference"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/features/drive/drive"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { useStringifiedClient } from "@/lib/auth"
import cache from "@/lib/cache"
import offline from "@/features/offline/offline"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import { aggregateDriveSelectionFlags } from "@/features/drive/driveSelectors"
import { resolveDriveHeaderTitle } from "@/features/drive/utils"
import { useDriveUpload } from "@/features/drive/hooks/useDriveUpload"
import { buildSortMenuButton, buildBulkActionMenu } from "@/features/drive/components/headerMenuBuilders"

const Header = ({ setSearchQuery }: { setSearchQuery: React.Dispatch<React.SetStateAction<string>> }) => {
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

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: false
		}
	)

	const driveItems = driveItemsQuery.status === "success" ? driveItemsQuery.data : []

	const parent: AnyNormalDir | null = (() => {
		// If we're at the root of the drive and we have the root uuid in cache, we can return a AnyNormalDir for the root directory
		if (drivePath.type === "drive" && drivePath.uuid === null && cache.rootUuid) {
			return new AnyNormalDir.Root({
				uuid: cache.rootUuid
			})
		}

		// We can check if the parent uuid of the current drive path is in the anyNormalDir cache
		// If it is, it's a directory that belongs to the user (not shared in)
		const fromCache = cache.directoryUuidToAnyNormalDir.get(drivePath.uuid ?? "")

		return fromCache ?? null
	})()

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

		if (driveItems.length > 0) {
			if (selectedDriveItems.length === driveItems.length) {
				menuButtons.push({
					id: "deselectAll",
					title: t("deselect_all"),
					icon: "select",
					onPress: () => {
						useDriveStore.getState().clearSelectedItems()
					}
				})
			} else {
				menuButtons.push({
					id: "selectAll",
					title: t("select_all"),
					icon: "select",
					onPress: () => {
						useDriveStore.getState().selectAllItems(driveItems)
					}
				})
			}
		}

		if (
			parent &&
			(drivePath.type === "drive" ||
				drivePath.type === "links" ||
				drivePath.type === "favorites" ||
				(drivePath.type === "sharedOut" && drivePath.uuid)) &&
			!drivePath.selectOptions &&
			!selectionMode
		) {
			menuButtons.push({
				id: "createFolder",
				title: t("create_folder"),
				icon: "plus",
				requiresOnline: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.input({
							title: t("create_folder"),
							message: t("enter_folder_name"),
							cancelText: t("cancel"),
							okText: t("create"),
							placeholder: t("folder_name")
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

					const folderName = promptResult.data.value.trim()

					if (folderName.length === 0) {
						return
					}

					const result = await runWithLoading(async () => {
						await drive.createDirectory({
							name: folderName,
							parent
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)
					}
				}
			})

			menuButtons.push({
				id: "upload",
				title: t("upload"),
				icon: "upload",
				subButtons: [
					{
						id: "uploadFiles",
						title: t("upload_files"),
						icon: "upload",
						requiresOnline: true,
						onPress: upload.uploadFiles
					},
					{
						id: "uploadPhotosOrVideos",
						requiresOnline: true,
						title: t("upload_photos_or_videos"),
						icon: "image",
						onPress: upload.uploadPhotosOrVideos
					},
					{
						id: "takePhotoOrVideo",
						title: t("take_photo_or_video"),
						icon: "camera",
						onPress: upload.takePhotoOrVideo
					},
					{
						id: "scanDocument",
						requiresOnline: true,
						title: t("scan_document"),
						icon: "scan",
						onPress: upload.scanDocument
					},
					{
						id: "createTextFile",
						title: t("create_text_file"),
						icon: "text",
						onPress: upload.createTextFile
					}
				]
			})
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
					disabled: offlineSyncing,
					onPress: () => {
						offline.sync().catch(console.error)
					}
				})
			}
		}

		if (selectedDriveItems.length > 0) {
			// Cross-reference selected items with the live query list before
			// aggregating flags. Otherwise stale selection entries (e.g. an item
			// that became undecryptable after a key change, or whose favorited
			// state flipped via socket event) would feed outdated booleans into
			// the bulk toolbar.
			const liveItems = selectedDriveItems.map(sel => driveItems.find(live => live.data.uuid === sel.data.uuid) ?? sel)
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
						console.error(promptResult.error)
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
						console.error(result.error)
						alerts.error(result.error)

						return
					}
				}
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
			shadowVisible={Platform.OS === "ios" ? false : undefined}
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
