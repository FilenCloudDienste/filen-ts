import { Fragment, useRef, useCallback } from "react"
import { onlineManager } from "@tanstack/react-query"
import SafeAreaView from "@/components/ui/safeAreaView"
import View from "@/components/ui/view"
import useDriveItemsQuery from "@/features/drive/queries/useDriveItems.query"
import { itemSorter } from "@/lib/sort"
import VirtualList from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { type View as RNView } from "react-native"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import useViewLayout from "@/hooks/useViewLayout"
import { resolveCreatedOrTimestamp } from "@/lib/sdkUnwrap"
import { getPreviewType } from "@/lib/previewType"
import Ionicons from "@expo/vector-icons/Ionicons"
import useDrivePath from "@/hooks/useDrivePath"
import { router, useFocusEffect } from "expo-router"
import cameraUpload, { useCameraUpload } from "@/features/cameraUpload/cameraUpload"
import Text from "@/components/ui/text"
import Button from "@/components/ui/button"
import usePhotosStore from "@/features/photos/store/usePhotos.store"
import { useSecureStore } from "@/lib/secureStore"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS } from "@/constants"
import * as FileSystem from "expo-file-system"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { useTranslation } from "react-i18next"
import Header from "@/features/photos/components/photosHeader"
import Photo from "@/features/photos/components/photoItem"
import DateRange from "@/features/photos/components/dateRange"
import { filterPhotoGridItems } from "@/features/photos/utils"

const Photos = () => {
	const { t } = useTranslation()
	const viewRef = useRef<RNView>(null)
	const { layout, onLayout } = useViewLayout(viewRef)
	const { config } = useCameraUpload()
	const drivePath = useDrivePath()
	const [photosGridTiles] = useSecureStore<number>("photosGridTiles", 4)

	useFocusEffect(
		useCallback(() => {
			useDriveStore.getState().clearSelectedItems()

			return () => {
				useDriveStore.getState().clearSelectedItems()
			}
		}, [])
	)

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null && config.enabled && config.remoteDir !== null
		}
	)

	const size = !layout ? 0 : layout.width / Math.min(Math.max(1, photosGridTiles), 5)

	const items = driveItemsQuery.data
		? itemSorter.sortItems(
				filterPhotoGridItems({
					items: driveItemsQuery.data,
					getPreviewType,
					supportedImageExtensions: EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS,
					extname: name => FileSystem.Paths.extname(name)
				}),
				"creationDesc"
			)
		: []

	return (
		<Fragment>
			<Header
				items={items}
				drivePath={drivePath}
			/>
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

								if (!firstItem || !lastItem) {
									return
								}

								usePhotosStore.getState().setVisibleDateRange({
									start: resolveCreatedOrTimestamp({
										created: firstItem.item.data.decryptedMeta?.created,
										timestamp: firstItem.item.data.timestamp
									}),
									end: resolveCreatedOrTimestamp({
										created: lastItem.item.data.decryptedMeta?.created,
										timestamp: lastItem.item.data.timestamp
									})
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
								if (!onlineManager.isOnline()) {
									return
								}

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
							emptyComponent={() => (
								<ListEmpty
									icon="images-outline"
									title={t("no_photos")}
								/>
							)}
						/>
					) : (
						<View className="flex-1 items-center justify-center">
							<Ionicons
								name="camera"
								size={64}
								color="gray"
							/>
							<Text className="mt-2">{t("camera_upload_disabled")}</Text>
							<Text className="text-xs text-muted-foreground mt-0.5">{t("camera_upload_disabled_description")}</Text>
							<View className="mt-4">
								<Button onPress={() => router.push("/cameraUpload")}>{t("enable_camera_upload")}</Button>
							</View>
						</View>
					)}
				</View>
			</SafeAreaView>
		</Fragment>
	)
}

export default Photos
