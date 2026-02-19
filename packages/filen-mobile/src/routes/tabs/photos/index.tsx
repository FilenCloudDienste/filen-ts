import { Fragment, useRef } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import useDriveItemsQuery from "@/queries/useDriveItems.query"
import type { DriveItem } from "@/types"
import { itemSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import type { View as RNView } from "react-native"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import useViewLayout from "@/hooks/useViewLayout"
import { memo, useCallback, useMemo } from "@/lib/memo"

const drivePath = {
	type: "drive",
	uuid: "6fc3d024-083f-41ba-906e-638a12a13a71"
} as const

export const Photos = memo(() => {
	const viewRef = useRef<RNView>(null)
	const { layout, onLayout } = useViewLayout(viewRef)

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null
		}
	)

	const size = useMemo(() => {
		if (!layout) {
			return 0
		}

		return layout.width / 5
	}, [layout])

	const renderItem = useCallback(
		(info: ListRenderItemInfo<DriveItem>) => {
			return (
				<View
					style={{
						width: size,
						height: size
					}}
					className="p-px"
				>
					<View className="bg-secondary items-center justify-center flex-1">
						<Text>{info.index}</Text>
						<Text>{info.item.data.decryptedMeta?.name}</Text>
					</View>
				</View>
			)
		},
		[size]
	)

	const keyExtractor = useCallback((item: DriveItem) => {
		return item.data.uuid
	}, [])

	const data = useMemo(() => {
		return driveItemsQuery.data
			? itemSorter.sortItems(
					driveItemsQuery.data.filter(item => item.type === "file" || item.type === "sharedFile"),
					"creationDesc"
				)
			: []
	}, [driveItemsQuery.data])

	const onRefresh = useCallback(async () => {
		const result = await run(async () => {
			await driveItemsQuery.refetch()
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}, [driveItemsQuery])

	return (
		<Fragment>
			<Header title="tbd" />
			<SafeAreaView edges={["left", "right"]}>
				<View
					ref={viewRef}
					onLayout={onLayout}
					className="flex-1"
				>
					<VirtualList
						className="flex-1"
						contentInsetAdjustmentBehavior="automatic"
						contentContainerClassName="pb-40"
						itemHeight={size}
						grid={true}
						itemWidth={size}
						keyExtractor={keyExtractor}
						data={data}
						renderItem={renderItem}
						onRefresh={onRefresh}
						loading={driveItemsQuery.status !== "success"}
					/>
				</View>
			</SafeAreaView>
		</Fragment>
	)
})

export default Photos
