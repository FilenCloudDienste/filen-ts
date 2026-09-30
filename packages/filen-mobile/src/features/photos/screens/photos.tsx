import { Fragment, useCallback } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import View from "@/components/ui/view"
import useDriveItemsQuery from "@/features/drive/queries/useDriveItems.query"
import { itemSorter, captureTimestamp } from "@/lib/sort"
import VirtualList from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { run } from "@filen/shared"
import alerts from "@/lib/alerts"
import useViewLayout from "@/hooks/useViewLayout"
import useDrivePath from "@/hooks/useDrivePath"
import { useFocusEffect } from "expo-router"
import { router } from "@/lib/router"
import cameraUpload, { useCameraUploadConfig } from "@/features/cameraUpload/cameraUpload"
import { remoteListingPosition } from "@/features/cameraUpload/remoteListing"
import { useCameraUploadDestination } from "@/features/cameraUpload/queries/useCameraUploadDestination.query"
import Button from "@/components/ui/button"
import usePhotosStore from "@/features/photos/store/usePhotos.store"
import { usePhotosGridTiles, clampPhotosGridTiles } from "@/features/photos/photosGridTiles"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { useTranslation } from "react-i18next"
import Header from "@/features/photos/components/photosHeader"
import Photo from "@/features/photos/components/photoItem"
import DateRange from "@/features/photos/components/dateRange"
import { isPhotoGridItem } from "@/features/photos/utils"
import { LazyWrapper } from "@/components/lazyWrapper"
import logger from "@/lib/logger"

const Photos = () => {
	const { t } = useTranslation()
	const { layout, onLayout } = useViewLayout()
	const { config } = useCameraUploadConfig()
	const drivePath = useDrivePath()
	const [photosGridTiles] = usePhotosGridTiles()
	const destination = useCameraUploadDestination(config.remoteDir)

	useFocusEffect(
		useCallback(() => {
			useDriveStore.getState().clearSelectedItems()
			usePhotosStore.getState().setVisibleDate(null)

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

	const size = !layout ? 0 : layout.width / clampPhotosGridTiles(photosGridTiles)

	// Configured (enabled + a destination set) but the destination dir is gone/trashed on the
	// server. Hold the empty state until the lookup settles (loading) so it does not flash on first
	// mount before the destination has been resolved.
	const destinationUnavailable = config.enabled && config.remoteDir !== null && !destination.loading && !destination.usable

	const items = driveItemsQuery.data
		? itemSorter.sortItems(
				driveItemsQuery.data.filter(isPhotoGridItem),
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
								contentContainerClassName="pb-40"
								itemWidth={size}
								keyExtractor={item => item.data.uuid}
								viewabilityConfig={{
									itemVisiblePercentThreshold: 99
								}}
								onViewableItemsChanged={info => {
									const firstItem = info.viewableItems[0]

									if (!firstItem) {
										return
									}

									// Same best-effort capture timestamp the grid is SORTED by (#43) —
									// labeling rows with the raw `created` resurfaced the exact garbage
									// dates (upload-stamped, epoch-zero) the capture key clamps away.
									usePhotosStore.getState().setVisibleDate(captureTimestamp(firstItem.item))
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
								requiresOnline={true}
								onRefresh={async () => {
									const listingPosition = remoteListingPosition()
									const result = await run(async () => {
										await driveItemsQuery.refetch()
									})

									if (!result.success) {
										logger.error("photos", "photos list refetch failed", { error: result.error })
										alerts.error(result.error)
									}

									// The sync takes over the remote walk the refetch just made instead of repeating it.
									cameraUpload
										.sync({ manual: true, remoteListingSince: listingPosition })
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
