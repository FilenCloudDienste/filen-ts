import { Fragment } from "react"
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
import { router } from "expo-router"
import useNetInfo from "@/hooks/useNetInfo"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/lib/drive"
import useDriveStore from "@/stores/useDrive.store"
import { useShallow } from "zustand/shallow"
import type { MenuButton } from "@/components/ui/menu"
import { useStringifiedClient } from "@/lib/auth"
import cache from "@/lib/cache"
import { AnyDirEnumWithShareInfo } from "@filen/sdk-rs"

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

		if (menuButtons.length === 0) {
			return []
		}

		return [
			{
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
			}
		] satisfies HeaderItem[]
	}, [selectedDriveItems, netInfo.hasInternet, textForeground.color, driveItems, drivePath.type])

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
			backTitle={drivePath.uuid ? undefined : "tbd_back"}
			backgroundColor={
				drivePath.type !== "drive"
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

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null
		}
	)

	const parent = useMemo((): AnyDirEnumWithShareInfo | undefined => {
		if (drivePath.type === "drive" && stringifiedClient && (!drivePath.uuid || (drivePath.uuid ?? "") === stringifiedClient.rootUuid)) {
			return new AnyDirEnumWithShareInfo.Root({
				uuid: stringifiedClient.rootUuid
			})
		}

		const fromCache = cache.directoryUuidToAnyDirWithShareInfo.get(drivePath.uuid ?? "")

		if (fromCache) {
			return fromCache
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

	const data = useMemo(() => {
		if (driveItemsQuery.status !== "success") {
			return []
		}

		return itemSorter.sortItems(driveItemsQuery.data, "nameAsc")
	}, [driveItemsQuery.data, driveItemsQuery.status])

	const onRefresh = useCallback(async () => {
		const result = await run(async () => {
			return await driveItemsQuery.refetch()
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}, [driveItemsQuery])

	return (
		<Fragment>
			<Header />
			<SafeAreaView
				className={cn("flex-1", drivePath.type === "drive" ? "bg-background" : "bg-background-secondary")}
				edges={["left", "right"]}
			>
				<VirtualList
					className={cn("flex-1", drivePath.type === "drive" ? "bg-background" : "bg-background-secondary")}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName="pb-40"
					keyExtractor={keyExtractor}
					data={data}
					renderItem={renderItem}
					onRefresh={onRefresh}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default Drive
