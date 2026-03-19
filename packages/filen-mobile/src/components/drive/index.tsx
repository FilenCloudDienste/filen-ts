import { Fragment, useState, useEffect } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import useDrivePath from "@/hooks/useDrivePath"
import useDriveItemsQuery from "@/queries/useDriveItems.query"
import type { DriveItem } from "@/types"
import { itemSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import Item from "@/components/drive/item"
import { run, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import { memo, useCallback, useMemo } from "@/lib/memo"
import { Platform } from "react-native"
import { useResolveClassNames } from "uniwind"
import { router, useFocusEffect } from "expo-router"
import useNetInfo from "@/hooks/useNetInfo"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/lib/drive"
import useDriveStore from "@/stores/useDrive.store"
import { useShallow } from "zustand/shallow"
import type { MenuButton } from "@/components/ui/menu"
import { useStringifiedClient } from "@/lib/auth"
import cache from "@/lib/cache"
import { AnyDirWithContext, AnyNormalDir } from "@filen/sdk-rs"
import { debounce } from "es-toolkit/function"

const Header = memo(() => {
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const netInfo = useNetInfo()
	const selectedDriveItems = useDriveStore(useShallow(state => state.selectedItems))
	const drivePath = useDrivePath()
	const stringifiedClient = useStringifiedClient()

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: false
		}
	)

	const driveItems = useMemo(() => {
		if (driveItemsQuery.status !== "success") {
			return []
		}

		return driveItemsQuery.data
	}, [driveItemsQuery.data, driveItemsQuery.status])

	const rightItems = useMemo(() => {
		if (drivePath.selectOptions) {
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
							if (router.canGoBack()) {
								router.back()
							}
						}
					}
				}
			] satisfies HeaderItem[]
		}

		const items: HeaderItem[] = []
		const menuButtons: MenuButton[] = []

		if (driveItems.length > 0) {
			if (selectedDriveItems.length === driveItems.length) {
				menuButtons.push({
					id: "deselectAll",
					title: "tbd_deselect_all",
					onPress: () => {
						useDriveStore.getState().setSelectedItems([])
					}
				})
			} else {
				menuButtons.push({
					id: "selectAll",
					title: "tbd_select_all",
					onPress: () => {
						useDriveStore.getState().setSelectedItems(driveItems)
					}
				})
			}
		}

		if (selectedDriveItems.length > 0 && drivePath.type === "trash") {
			menuButtons.push({
				id: "restoreSelected",
				title: "tbd_restore_selected",
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: "tbd_restore_selected",
							message: "tbd_are_you_sure_restore_selected",
							cancelText: "tbd_cancel",
							okText: "tbd_restore"
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
						await Promise.all(
							selectedDriveItems.map(item => {
								return drive.restore({
									item,
									signal: undefined
								})
							})
						)
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)
					}
				}
			})

			menuButtons.push({
				id: "deleteSelectedPermanently",
				title: "tbd_delete_selected_permanently",
				destructive: true,
				icon: "delete",
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: "tbd_delete_selected_permanently",
							message: "tbd_are_you_sure_delete_selected_permanently",
							cancelText: "tbd_cancel",
							okText: "tbd_delete"
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
						await Promise.all(
							selectedDriveItems.map(item => {
								return drive.deletePermanently({
									item,
									signal: undefined
								})
							})
						)
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)
					}
				}
			})
		}

		if (netInfo.hasInternet && drivePath.type === "trash") {
			menuButtons.push({
				id: "empty",
				title: "tbd_empty_trash",
				destructive: true,
				icon: "delete",
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: "tbd_empty_trash",
							message: "tbd_are_you_sure_empty_trash",
							cancelText: "tbd_cancel",
							okText: "tbd_empty"
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
	}, [selectedDriveItems, netInfo.hasInternet, textForeground.color, driveItems, drivePath.type, drivePath.selectOptions])

	const leftItems = useMemo((): HeaderItem[] => {
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
							useDriveStore.getState().setSelectedItems([])
						}
					}
				}
			] satisfies HeaderItem[]
		}

		if (
			(drivePath.type === "drive" ||
				drivePath.type === "offline" ||
				drivePath.type === "sharedIn" ||
				drivePath.type === "sharedOut" ||
				drivePath.type === "favorites") &&
			drivePath.uuid
		) {
			return []
		}

		if (Platform.OS === "ios") {
			if (drivePath.type === "drive" && !drivePath.uuid) {
				return []
			}

			return [
				{
					type: "button",
					icon: {
						name: "chevron-back-outline",
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
		}

		return []
	}, [selectedDriveItems.length, textForeground.color, drivePath])

	const headerTitle = useMemo(() => {
		if (drivePath.selectOptions) {
			switch (drivePath.selectOptions.intention) {
				case "move": {
					return "tbd_select_destination"
				}

				case "select": {
					return drivePath.selectOptions.directories && drivePath.selectOptions.files
						? drivePath.selectOptions.type === "single"
							? "tbd_select_item"
							: "tbd_select_items"
						: drivePath.selectOptions.directories
							? drivePath.selectOptions.type === "single"
								? "tbd_select_directory"
								: "tbd_select_directories"
							: drivePath.selectOptions.type === "single"
								? "tbd_select_file"
								: "tbd_select_files"
				}
			}
		}

		switch (drivePath.type) {
			case "drive": {
				if (stringifiedClient && (drivePath.uuid ?? "") === stringifiedClient.rootUuid) {
					return "tbd_drive"
				}

				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_drive"
			}

			case "offline": {
				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_offline"
			}

			case "sharedIn": {
				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_shared_with_me"
			}

			case "sharedOut": {
				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_shared_with_others"
			}

			case "links": {
				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_links"
			}

			case "favorites": {
				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_favorites"
			}

			case "trash": {
				return "tbd_trash"
			}

			case "recents": {
				return "tbd_recents"
			}

			default: {
				return ""
			}
		}
	}, [drivePath, stringifiedClient])

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
		/>
	)
})

const Drive = memo(() => {
	const drivePath = useDrivePath()
	const stringifiedClient = useStringifiedClient()
	const [searchQuery, setSearchQuery] = useState<string>("")
	const [globalSearchResult, setGlobalSearchResult] = useState<DriveItem[]>([])
	const [queryingGlobalSearch, setQueryingGlobalSearch] = useState<boolean>(false)

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null
		}
	)

	const parent = useMemo((): AnyDirWithContext | undefined => {
		if (drivePath.type === "drive" && stringifiedClient && (!drivePath.uuid || (drivePath.uuid ?? "") === stringifiedClient.rootUuid)) {
			return new AnyDirWithContext.Normal(
				new AnyNormalDir.Root({
					uuid: stringifiedClient.rootUuid
				})
			)
		}

		switch (drivePath.type) {
			case "drive":
			case "favorites":
			case "recents":
			case "trash": {
				const fromCache = cache.directoryUuidToAnyDirWithContext.get(drivePath.uuid ?? "")

				if (fromCache) {
					return fromCache
				}

				break
			}

			case "sharedIn":
			case "sharedOut": {
				const fromCache = cache.directoryUuidToAnyDirWithContext.get(drivePath.uuid ?? "")

				if (fromCache) {
					return fromCache
				}

				break
			}

			case "links": {
				const fromCache = cache.directoryUuidToAnyDirWithContext.get(drivePath.uuid ?? "")

				if (fromCache) {
					return fromCache
				}

				break
			}

			case "offline": {
				const fromCache = cache.directoryUuidToAnyDirWithContext.get(drivePath.uuid ?? "")

				if (fromCache) {
					return fromCache
				}

				break
			}

			default: {
				return undefined
			}
		}

		return undefined
	}, [drivePath.uuid, stringifiedClient, drivePath.type])

	const renderItem = useCallback(
		(info: ListRenderItemInfo<DriveItem>) => {
			return (
				<Item
					info={{
						...info,
						item: {
							item: info.item,
							parent
						}
					}}
					origin={drivePath.type ?? "drive"}
					drivePath={drivePath}
				/>
			)
		},
		[drivePath, parent]
	)

	const keyExtractor = useCallback((item: DriveItem) => {
		return item.data.uuid
	}, [])

	const itemsSorted = useMemo(() => {
		if (driveItemsQuery.status !== "success") {
			return []
		}

		return itemSorter.sortItems([...driveItemsQuery.data, ...globalSearchResult], "nameAsc")
	}, [driveItemsQuery.data, driveItemsQuery.status, globalSearchResult])

	const items = useMemo(() => {
		if (driveItemsQuery.status !== "success") {
			return []
		}

		if (searchQuery.length > 0) {
			const searchQueryNormalized = searchQuery.trim().toLowerCase()

			return itemsSorted.filter(item => {
				if (item.data.decryptedMeta?.name && item.data.decryptedMeta?.name.toLowerCase().includes(searchQueryNormalized)) {
					return true
				}

				return false
			})
		}

		return itemsSorted
	}, [driveItemsQuery.status, searchQuery, itemsSorted])

	const onRefresh = useCallback(async () => {
		const result = await run(async () => {
			return await driveItemsQuery.refetch()
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}, [driveItemsQuery])

	const debouncedSearch = useMemo(() => {
		return debounce(async (value: string) => {
			const normalized = value.trim().toLowerCase()

			if (normalized.length === 0) {
				setGlobalSearchResult([])
				setQueryingGlobalSearch(false)

				return
			}

			setQueryingGlobalSearch(true)
			setGlobalSearchResult([])

			const result = await run(async defer => {
				defer(() => {
					setQueryingGlobalSearch(false)
				})

				return await drive.findItemMatchesForName({
					name: normalized
				})
			})

			setQueryingGlobalSearch(false)

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				setGlobalSearchResult([])

				return
			}

			setGlobalSearchResult(result.data.map(({ item }) => item))
		}, 1000)
	}, [])

	useEffect(() => {
		if (drivePath.type !== "drive" || drivePath.selectOptions) {
			return
		}

		debouncedSearch(searchQuery)
	}, [searchQuery, debouncedSearch, drivePath.type, drivePath.selectOptions])

	useEffect(() => {
		return () => {
			debouncedSearch.cancel()
		}
	}, [debouncedSearch])

	useFocusEffect(
		useCallback(() => {
			useDriveStore.getState().setSelectedItems([])

			return () => {
				useDriveStore.getState().setSelectedItems([])
			}
		}, [])
	)

	const searchBarProps = useMemo(
		() => ({
			placeholder: "tbd_search_drive",
			onChangeText: setSearchQuery
		}),
		[setSearchQuery]
	)

	return (
		<Fragment>
			<Header />
			<SafeAreaView
				className={cn(
					"flex-1",
					drivePath.type === "drive" && !drivePath.selectOptions ? "bg-background" : "bg-background-secondary"
				)}
				edges={["left", "right"]}
			>
				<VirtualList
					className={cn(
						"flex-1",
						drivePath.type === "drive" && !drivePath.selectOptions ? "bg-background" : "bg-background-secondary"
					)}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName={cn("pb-40", Platform.OS === "android" && "pb-96")}
					keyExtractor={keyExtractor}
					data={items}
					renderItem={renderItem}
					onRefresh={onRefresh}
					loading={driveItemsQuery.status !== "success" || queryingGlobalSearch}
					searchBar={searchBarProps}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default Drive
