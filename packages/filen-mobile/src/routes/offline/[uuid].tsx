import { Fragment } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader from "@/components/ui/header"
import useDrivePath from "@/hooks/useDrivePath"
import useDriveItemsQuery from "@/queries/useDriveItems.query"
import type { DriveItem } from "@/types"
import { itemSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import cache from "@/lib/cache"
import { useStringifiedClient } from "@/lib/auth"
import Item from "@/components/drive/item"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { memo, useCallback, useMemo } from "@/lib/memo"
import { Platform } from "react-native"
import { useResolveClassNames } from "uniwind"
import { router } from "expo-router"
import offline from "@/lib/offline"

const Header = memo(() => {
	const drivePath = useDrivePath()
	const stringifiedClient = useStringifiedClient()
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")

	const headerTitle = useMemo(() => {
		if (stringifiedClient && (drivePath.uuid ?? "") === stringifiedClient.rootUuid) {
			return "tbd"
		}

		return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_offline"
	}, [drivePath, stringifiedClient])

	return (
		<StackHeader
			title={headerTitle}
			transparent={Platform.OS === "ios"}
			backVisible={true}
			backTitle="tbd_back"
			backgroundColor={Platform.select({
				ios: undefined,
				default: bgBackgroundSecondary.backgroundColor as string
			})}
			leftItems={() => {
				if (drivePath.uuid || Platform.OS === "android") {
					return null
				}

				return [
					{
						type: "button",
						icon: {
							name: "close",
							color: textForeground.color,
							size: 20
						},
						props: {
							onPress: () => {
								router.back()
							}
						}
					}
				]
			}}
			rightItems={[
				{
					type: "menu",
					props: {
						type: "dropdown",
						hitSlop: 20,
						buttons: [
							{
								id: "transfers",
								title: "tbd_transfers",
								onPress: () => {
									router.push("/transfers")
								}
							},
							{
								id: "listofflinedirs",
								title: "listofflinedirstest",
								onPress: async () => {
									console.log("sync")
									console.log(await offline.sync())
									console.log("done")
								}
							}
						]
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
			]}
		/>
	)
})

const Offline = memo(() => {
	const drivePath = useDrivePath()

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null
		}
	)

	const renderItem = useCallback((info: ListRenderItemInfo<DriveItem>) => {
		return (
			<Item
				info={{
					...info,
					item: {
						item: info.item,
						parent: undefined
					}
				}}
				origin="offline"
			/>
		)
	}, [])

	const keyExtractor = useCallback((item: DriveItem) => {
		return item.data.uuid
	}, [])

	const data = useMemo(() => {
		if (driveItemsQuery.status !== "success") {
			return []
		}

		console.log(
			"offline items",
			driveItemsQuery.data.map(i => i.data.decryptedMeta?.name)
		)

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
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					className="flex-1 bg-background-secondary"
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

export default Offline
