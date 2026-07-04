import { Fragment, useRef, useCallback } from "react"
import { onlineManager } from "@tanstack/react-query"
import SafeAreaView from "@/components/ui/safeAreaView"
import View from "@/components/ui/view"
import useDriveItemsQuery from "@/features/drive/queries/useDriveItems.query"
import { itemSorter, captureTimestamp } from "@/lib/sort"
import VirtualList from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { type View as RNView } from "react-native"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import useViewLayout from "@/hooks/useViewLayout"
import { getPreviewType } from "@/lib/previewType"
import useDrivePath from "@/hooks/useDrivePath"
import { useFocusEffect } from "expo-router"
import { router } from "@/lib/router"
import cameraUpload, { DEFAULT_CONFIG, type Config } from "@/features/cameraUpload/cameraUpload"
import { useCameraUploadDestination } from "@/features/cameraUpload/queries/useCameraUploadDestination.query"
import Button from "@/components/ui/button"
import usePhotosStore from "@/features/photos/store/usePhotos.store"
import { useSecureStore } from "@/lib/secureStore"
import { EXPO_IMAGE_SUPPORTED_EXTENSIONS } from "@/constants"
import * as FileSystem from "expo-file-system"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { useTranslation } from "react-i18next"
import Header from "@/features/photos/components/photosHeader"
import Photo from "@/features/photos/components/photoItem"
import DateRange from "@/features/photos/components/dateRange"
import { filterPhotoGridItems } from "@/features/photos/utils"
import { LazyWrapper } from "@/components/lazyWrapper"
import logger from "@/lib/logger"

const Photos = () => {
	const { t } = useTranslation()
	const viewRef = useRef<RNView>(null)
	const { layout, onLayout } = useViewLayout(viewRef)
	const [config] = useSecureStore<Config>(cameraUpload.secureStoreKey, DEFAULT_CONFIG)
	const drivePath = useDrivePath()
	const [photosGridTiles] = useSecureStore<number>("photosGridTiles", 4)
	const destination = useCameraUploadDestination(config.remoteDir)

	useFocusEffect(
		useCallback(() => {
			useDriveStore.getState().clearSelectedItems()
			usePhotosStore.getState().setVisibleDateRange(null)

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
			enabled: drivePath.type !== null && config.enabled && config.remoteDir !== null && destination.usable
		}
	)

	const size = !layout ? 0 : layout.width / Math.min(Math.max(1, photosGridTiles), 5)

	// Configured (enabled + a destination set) but the destination dir is gone/trashed on the
	// server. Hold the empty state until the lookup settles (loading) so it does not flash on first
	// mount before the destination has been resolved.
	const destinationUnavailable = config.enabled && config.remoteDir !== null && !destination.loading && !destination.usable

	const items = driveItemsQuery.data
		? itemSorter.sortItems(
				filterPhotoGridItems({
					items: driveItemsQuery.data,
					getPreviewType,
					supportedImageExtensions: EXPO_IMAGE_SUPPORTED_EXTENSIONS,
					extname: name => FileSystem.Paths.extname(name)
				}),
				"captureDesc"
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
					<LazyWrapper>
						{config.enabled && config.remoteDir && !destinationUnavailable && <DateRange />}
						{config.enabled && config.remoteDir && destinationUnavailable ? (
							<ListEmpty
								icon="cloud-offline-outline"
								title={t("camera_upload_destination_unavailable")}
								description={t("camera_upload_destination_unavailable_description")}
								action={<Button onPress={() => router.push("/cameraUpload")}>{t("choose_new_directory")}</Button>}
							/>
						) : config.enabled && config.remoteDir ? (
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

									// Same best-effort capture timestamp the grid is SORTED by (#43) —
									// labeling rows with the raw `created` resurfaced the exact garbage
									// dates (upload-stamped, epoch-zero) the capture key clamps away.
									usePhotosStore.getState().setVisibleDateRange({
										start: captureTimestamp(firstItem.item),
										end: captureTimestamp(lastItem.item)
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
										logger.error("photos", "photos list refetch failed", { error: result.error })
										alerts.error(result.error)
									}

									cameraUpload
										.sync({ manual: true })
										.catch(e => logger.warn("photos", "cameraUpload.sync failed on pull-to-refresh", { error: e }))
								}}
								loading={driveItemsQuery.status === "pending"}
								emptyComponent={() => (
									<ListEmpty
										icon="images-outline"
										title={t("no_photos")}
										description={t("no_photos_description")}
									/>
								)}
							/>
						) : (
							<ListEmpty
								icon="camera"
								title={t("camera_upload_disabled")}
								description={t("camera_upload_disabled_description")}
								action={<Button onPress={() => router.push("/cameraUpload")}>{t("enable_camera_upload")}</Button>}
							/>
						)}
					</LazyWrapper>
				</View>
			</SafeAreaView>
		</Fragment>
	)
}

export default Photos
