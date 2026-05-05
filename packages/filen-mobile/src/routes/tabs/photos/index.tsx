import { Fragment, useRef, memo } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader from "@/components/ui/header"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import useDriveItemsQuery from "@/queries/useDriveItems.query"
import type { DriveItemFileExtracted } from "@/types"
import { itemSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import { type View as RNView, Platform, type ViewStyle } from "react-native"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import useViewLayout from "@/hooks/useViewLayout"
import { getPreviewType } from "@/lib/utils"
import Thumbnail from "@/components/drive/item/thumbnail"
import Ionicons from "@expo/vector-icons/Ionicons"
import useDriveItemStoredOfflineQuery from "@/queries/useDriveItemStoredOffline.query"
import { PressableOpacity } from "@/components/ui/pressables"
import useDrivePath, { type DrivePath } from "@/hooks/useDrivePath"
import { router } from "expo-router"
import Menu from "@/components/drive/item/menu"
import cameraUpload, { useCameraUpload } from "@/lib/cameraUpload"
import Text from "@/components/ui/text"
import Button from "@/components/ui/button"
import { useResolveClassNames } from "uniwind"
import useCameraUploadStore from "@/stores/useCameraUpload.store"
import { useShallow } from "zustand/shallow"
import usePhotosStore from "@/stores/usePhotos.store"
import { simpleDateNoTime } from "@/lib/time"
import { useHeaderHeight } from "@react-navigation/elements"
import { useSecureStore } from "@/lib/secureStore"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS } from "@/constants"
import * as FileSystem from "expo-file-system"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"

const Photo = memo(
	({
		info,
		size,
		drivePath,
		getListItems
	}: {
		info: ListRenderItemInfo<DriveItemFileExtracted>
		size: number
		drivePath: DrivePath
		getListItems: () => DriveItemFileExtracted[]
	}) => {
		const previewType = getPreviewType(info.item.data.decryptedMeta?.name ?? "")

		const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery({
			uuid: info.item.data.uuid,
			type: info.item.type
		})

		const viewStyle: ViewStyle = {
			width: size,
			height: size
		}

		return (
			<View
				style={viewStyle}
				className="p-px"
			>
				<Menu
					style={viewStyle}
					type="context"
					isAnchoredToRight={true}
					item={info.item}
					drivePath={drivePath}
					isStoredOffline={driveItemStoredOfflineQuery.status === "success" ? driveItemStoredOfflineQuery.data : false}
				>
					<View style={viewStyle}>
						<PressableOpacity
							className="items-center justify-center flex-1 overflow-hidden"
							onPress={() => {
								useDrivePreviewStore.getState().open({
									initialItem: {
										type: "drive",
										data: {
											item: info.item,
											drivePath
										}
									},
									items: getListItems().map(item => ({
										type: "drive",
										data: item
									}))
								})
							}}
							style={viewStyle}
						>
							{previewType === "video" && (
								<View className="size-4 absolute bottom-0.5 right-0.5 z-10 flex-row items-center justify-center bg-white rounded-full p-px">
									<Ionicons
										name="play"
										size={13}
										color="black"
									/>
								</View>
							)}
							{info.item.type === "file" && info.item.data.favorited && (
								<View className="size-4 absolute bottom-0.5 left-0.5 z-10 flex-row items-center justify-center bg-red-500 rounded-full p-px">
									<Ionicons
										name="heart"
										size={13}
										color="white"
									/>
								</View>
							)}
							{driveItemStoredOfflineQuery.status === "success" && driveItemStoredOfflineQuery.data && (
								<View className="size-4 absolute top-0.5 right-0.5 z-10 flex-row items-center justify-center bg-green-500 rounded-full p-px">
									<Ionicons
										name="checkmark-done"
										size={13}
										color="white"
									/>
								</View>
							)}
							<Thumbnail
								item={info.item}
								target={info.target}
								contentFit="cover"
								size={{
									icon: size - 2,
									thumbnail: size - 2
								}}
							/>
						</PressableOpacity>
					</View>
				</Menu>
			</View>
		)
	}
)

const Header = memo(() => {
	const textForeground = useResolveClassNames("text-foreground")
	const syncing = useCameraUploadStore(useShallow(state => state.syncing))
	const hasErrors = useCameraUploadStore(useShallow(state => state.errors.length > 0))
	const textRed500 = useResolveClassNames("text-red-500")
	const [photosGridTiles, setPhotosGridTiles] = useSecureStore<number>("photosGridTiles", 4)

	return (
		<StackHeader
			title="tbd_photos"
			transparent={Platform.OS === "ios"}
			leftItems={() => {
				if (hasErrors) {
					return [
						{
							type: "button",
							icon: {
								name: "warning-outline",
								color: textRed500.color,
								size: 20
							},
							props: {
								onPress: () => {
									router.push("/cameraUploadErrors")
								}
							}
						}
					]
				}

				if (syncing) {
					return [
						{
							type: "loader",
							props: {
								color: textForeground.color,
								size: "small"
							}
						}
					]
				}

				return undefined
			}}
			rightItems={[
				{
					type: "menu",
					props: {
						type: "dropdown",
						hitSlop: 20,
						buttons: [
							{
								id: "settings",
								title: "tbd_settings",
								onPress: () => router.push("/cameraUpload"),
								icon: "edit"
							},
							{
								id: "gridTiles",
								title: `${photosGridTiles} ${photosGridTiles === 1 ? "tbd_photo_per_row" : "tbd_photos_per_row"}`,
								subButtons: [
									{
										id: "gridTiles1",
										title: "1",
										checked: photosGridTiles === 1,
										onPress: () => setPhotosGridTiles(1)
									},
									{
										id: "gridTiles2",
										title: "2",
										checked: photosGridTiles === 2,
										onPress: () => setPhotosGridTiles(2)
									},
									{
										id: "gridTiles3",
										title: "3",
										checked: photosGridTiles === 3,
										onPress: () => setPhotosGridTiles(3)
									},
									{
										id: "gridTiles4",
										title: "4",
										checked: photosGridTiles === 4,
										onPress: () => setPhotosGridTiles(4)
									},
									{
										id: "gridTiles5",
										title: "5",
										checked: photosGridTiles === 5,
										onPress: () => setPhotosGridTiles(5)
									}
								]
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

const DateRange = memo(() => {
	const visibleDateRange = usePhotosStore(useShallow(state => state.visibleDateRange))
	const headerHeight = useHeaderHeight()

	if (!visibleDateRange) {
		return null
	}

	const startDate = visibleDateRange.start ? new Date(visibleDateRange.start) : null
	const endDate = visibleDateRange.end ? new Date(visibleDateRange.end) : null

	if (!startDate || !endDate) {
		return null
	}

	return (
		<View
			className="absolute bg-transparent"
			style={{
				top:
					Platform.select({
						ios: headerHeight,
						default: 0
					}) + 8,
				right: 8,
				zIndex: 100
			}}
		>
			<CrossGlassContainerView className="p-2 items-center justify-center">
				<Text className="text-sm">{simpleDateNoTime(startDate)}</Text>
			</CrossGlassContainerView>
		</View>
	)
})

const Photos = memo(() => {
	const viewRef = useRef<RNView>(null)
	const { layout, onLayout } = useViewLayout(viewRef)
	const { config } = useCameraUpload()
	const drivePath = useDrivePath()
	const [photosGridTiles] = useSecureStore<number>("photosGridTiles", 4)

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null && config.enabled && config.remoteDir !== null
		}
	)

	const size = !layout ? 0 : layout.width / Math.min(Math.max(1, photosGridTiles), 5)

	const items = (
		driveItemsQuery.data
			? itemSorter.sortItems(
					driveItemsQuery.data.filter(item => {
						if (
							!item.data.decryptedMeta ||
							(item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile")
						) {
							return false
						}

						const previewType = getPreviewType(item.data.decryptedMeta.name)

						return (
							(previewType === "image" || previewType === "video") &&
							(previewType === "image"
								? EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(FileSystem.Paths.extname(item.data.decryptedMeta.name))
								: true)
						)
					}),
					"creationDesc"
				)
			: []
	) as DriveItemFileExtracted[]

	return (
		<Fragment>
			<Header />
			<SafeAreaView edges={["left", "right"]}>
				<View
					ref={viewRef}
					onLayout={onLayout}
					className="flex-1"
				>
					{config.enabled && config.remoteDir && <DateRange />}
					{config.enabled && config.remoteDir ? (
						<VirtualList
							className="flex-1"
							contentInsetAdjustmentBehavior="automatic"
							contentContainerClassName="pb-40"
							itemHeight={size}
							grid={true}
							itemWidth={size}
							keyExtractor={item => item.data.uuid}
							viewabilityConfig={{
								itemVisiblePercentThreshold: 99
							}}
							onViewableItemsChanged={info => {
								const items = info.viewableItems

								if (items.length === 0) {
									return
								}

								const firstItem = items[0]
								const lastItem = items[items.length - 1]

								usePhotosStore.getState().setVisibleDateRange({
									start: firstItem?.item.data.decryptedMeta?.created
										? Number(firstItem.item.data.decryptedMeta.created)
										: Number(firstItem?.item.data.timestamp),
									end: lastItem?.item.data.decryptedMeta?.created
										? Number(lastItem.item.data.decryptedMeta.created)
										: Number(lastItem?.item.data.timestamp)
								})
							}}
							data={items}
							renderItem={info => {
								return (
									<Photo
										info={info}
										size={size}
										drivePath={drivePath}
										getListItems={() => items}
									/>
								)
							}}
							onRefresh={async () => {
								const result = await run(async () => {
									await driveItemsQuery.refetch()
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)
								}

								cameraUpload.sync().catch(console.error)
							}}
							loading={driveItemsQuery.status !== "success"}
						/>
					) : (
						<View className="flex-1 items-center justify-center">
							<Ionicons
								name="camera"
								size={64}
								color="gray"
							/>
							<Text className="mt-2">tbd_camera_upload_disabled</Text>
							<Text className="text-xs text-muted-foreground mt-0.5">tbd_camera_upload_disabled_description</Text>
							<View className="mt-4">
								<Button onPress={() => router.push("/cameraUpload")}>tbd_enable_camera_upload</Button>
							</View>
						</View>
					)}
				</View>
			</SafeAreaView>
		</Fragment>
	)
})

export default Photos
