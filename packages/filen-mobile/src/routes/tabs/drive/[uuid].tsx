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
import * as DocumentPicker from "expo-document-picker"
import transfers from "@/lib/transfers"
import * as FileSystem from "expo-file-system"
import useTransfersStore from "@/stores/useTransfers.store"
import { FilenSdkError, DirEnum, AnyDirEnumWithShareInfo } from "@filen/sdk-rs"
import { router } from "expo-router"
import offline from "@/lib/offline"

const Header = memo(() => {
	const drivePath = useDrivePath()
	const stringifiedClient = useStringifiedClient()
	const textForeground = useResolveClassNames("text-foreground")

	const headerTitle = useMemo(() => {
		if (stringifiedClient && (drivePath.uuid ?? "") === stringifiedClient.rootUuid) {
			return "tbd"
		}

		return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd"
	}, [drivePath, stringifiedClient])

	return (
		<StackHeader
			title={headerTitle}
			transparent={Platform.OS === "ios"}
			rightItems={[
				{
					type: "menu",
					props: {
						type: "dropdown",
						hitSlop: 20,
						buttons: [
							{
								id: "test",
								title: "uploadtest",
								icon: "exit",
								onPress: async () => {
									if (drivePath.type !== "drive" || !drivePath.uuid) {
										alerts.error("Uploads are only supported in Drive at the moment.")
										return
									}

									const documents = await DocumentPicker.getDocumentAsync({
										type: "*/*",
										multiple: true,
										copyToCacheDirectory: true,
										base64: false
									})

									if (documents.canceled) {
										return
									}

									const first = documents.assets[0]

									if (!first) {
										return
									}

									const file = new FileSystem.File(first.uri)

									if (!file.exists || !file.size) {
										alerts.error("File does not exist or is empty")
										return
									}

									const parent = cache.directoryUuidToDir.get(drivePath.uuid)

									if (!parent) {
										alerts.error("Parent directory not found")
										return
									}

									const id = `upload-${Date.now()}`
									const result = await run(async () => {
										return await transfers.upload({
											id,
											localFileOrDir: file,
											parent: new DirEnum.Dir(parent)
										})
									})

									if (!result.success) {
										if (FilenSdkError.hasInner(result.error)) {
											console.log(FilenSdkError.getInner(result.error).message())
										}

										console.log(useTransfersStore.getState().transfers.find(t => t.id === id)?.errors)

										return
									}

									console.log(result.data)
								}
							},
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
							},
							{
								id: "viewoffline",
								title: "viewoffline",
								onPress: async () => {
									router.push("/offline")
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

export const Drive = memo(() => {
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
					origin="drive"
				/>
			)
		},
		[parent]
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
			<SafeAreaView edges={["left", "right"]}>
				<VirtualList
					className="flex-1"
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
