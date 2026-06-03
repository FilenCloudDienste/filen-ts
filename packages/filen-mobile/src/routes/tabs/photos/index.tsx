import { Fragment, useRef, memo, useCallback } from "react"
import { onlineManager } from "@tanstack/react-query"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import useDriveItemsQuery from "@/queries/useDriveItems.query"
import type { DriveItem, DriveItemFileExtracted } from "@/types"
import { itemSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { type View as RNView, Platform, type ViewStyle } from "react-native"
import { run, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import useViewLayout from "@/hooks/useViewLayout"
import { getPreviewType, getRealDriveItemParent } from "@/lib/utils"
import { driveItemDisplayName } from "@/lib/decryption"
import Thumbnail from "@/components/drive/item/thumbnail"
import Ionicons from "@expo/vector-icons/Ionicons"
import useDriveItemStoredOfflineQuery from "@/queries/useDriveItemStoredOffline.query"
import { PressableOpacity } from "@/components/ui/pressables"
import useDrivePath, { type DrivePath } from "@/hooks/useDrivePath"
import { router, useFocusEffect } from "expo-router"
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
import useDriveStore from "@/stores/useDrive.store"
import { runBulk } from "@/lib/bulkOps"
import { aggregateDriveSelectionFlags } from "@/lib/driveSelectors"
import { downloadDriveItemToDevice } from "@/lib/driveDownload"
import drive from "@/lib/drive"
import offline from "@/lib/offline"
import transfers from "@/lib/transfers"
import { newTmpDir } from "@/lib/tmp"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import * as MediaLibrary from "expo-media-library"
import { useTranslation } from "react-i18next"
import type { MenuButton } from "@/components/ui/menu"

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
		const previewType = getPreviewType(driveItemDisplayName(info.item))
		const isSelected = useDriveStore(useShallow(state => state.selectedItems.some(i => i.data.uuid === info.item.data.uuid)))
		const arePhotosSelected = useDriveStore(useShallow(state => state.selectedItems.length > 0))

		const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery({
			uuid: info.item.data.uuid,
			type: info.item.type
		})

		const viewStyle: ViewStyle = {
			width: size,
			height: size
		}

		const onPress = () => {
			// In selection mode, tap toggles. Else open the preview.
			if (arePhotosSelected) {
				useDriveStore.getState().toggleSelectedItem(info.item)

				return
			}

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
							className={cn("items-center justify-center flex-1 overflow-hidden", isSelected && "opacity-60")}
							onPress={onPress}
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
							{arePhotosSelected && (
								<View
									className={cn(
										"size-5 absolute top-0.5 left-0.5 z-10 flex-row items-center justify-center rounded-full",
										isSelected ? "bg-blue-500" : "bg-black/40 border border-white"
									)}
								>
									{isSelected && (
										<Ionicons
											name="checkmark"
											size={14}
											color="white"
										/>
									)}
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

const Header = memo(({ items, drivePath }: { items: DriveItemFileExtracted[]; drivePath: DrivePath }) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const syncing = useCameraUploadStore(useShallow(state => state.syncing))
	const hasErrors = useCameraUploadStore(useShallow(state => state.errors.length > 0))
	const textRed500 = useResolveClassNames("text-red-500")
	const [photosGridTiles, setPhotosGridTiles] = useSecureStore<number>("photosGridTiles", 4)
	const selectedItems = useDriveStore(useShallow(state => state.selectedItems))
	const inSelectionMode = selectedItems.length > 0
	const driveFlags = aggregateDriveSelectionFlags(selectedItems)

	const leftItems = ((): HeaderItem[] | undefined => {
		if (inSelectionMode) {
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
			]
		}

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
	})()

	const rightItems = ((): HeaderItem[] => {
		if (inSelectionMode) {
			const bulkButtons: MenuButton[] = []

			bulkButtons.push({
				id: "selectAll",
				title: selectedItems.length === items.length ? t("deselect_all") : t("select_all"),
				icon: "select",
				onPress: () => {
					if (selectedItems.length === items.length) {
						useDriveStore.getState().clearSelectedItems()

						return
					}

					useDriveStore.getState().selectAllItems(items as unknown as DriveItem[])
				}
			})

			bulkButtons.push({
				id: "bulkFavorite",
				title: driveFlags.includesFavorited ? t("unfavorite_selected") : t("favorite_selected"),
				icon: "heart",
				requiresOnline: true,
				onPress: async () => {
					await runBulk({
						items: selectedItems,
						clearSelection: () => useDriveStore.getState().clearSelectedItems(),
						op: item =>
							drive.favorite({
								item,
								favorited: !driveFlags.includesFavorited,
								signal: undefined
							})
					})
				}
			})

			if (driveFlags.everyImageOrVideoFile) {
				bulkButtons.push({
					id: "bulkSaveToPhotos",
					title: t("save_to_device_photos_selected"),
					icon: "archive",
					requiresOnline: true,
					onPress: async () => {
						const permissionsResult = await run(async () => {
							return await hasAllNeededMediaPermissions({ shouldRequest: true })
						})

						if (!permissionsResult.success) {
							console.error(permissionsResult.error)
							alerts.error(permissionsResult.error)

							return
						}

						if (!permissionsResult.data) {
							alerts.error(t("no_permissions_enable_manually"))

							return
						}

						await runBulk({
							items: selectedItems,
							clearSelection: () => useDriveStore.getState().clearSelectedItems(),
							op: async item => {
								if (!item.data.decryptedMeta) {
									return
								}

								const saveResult = await run(async defer => {
									const destination = new FileSystem.File(
										FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta!.name)
									)

									defer(() => {
										if (destination.parentDirectory.exists) {
											destination.parentDirectory.delete()
										}
									})

									if (!destination.parentDirectory.exists) {
										destination.parentDirectory.create({ intermediates: true, idempotent: true })
									}

									if (destination.exists) {
										destination.delete()
									}

									const downloadResult = await transfers.download({ item, destination })

									if (!downloadResult) {
										return
									}

									await MediaLibrary.saveToLibraryAsync(destination.uri)
								})

								if (!saveResult.success) {
									throw saveResult.error
								}
							}
						})
					}
				})
			}

			bulkButtons.push({
				id: "bulkDownload",
				title: t("download_selected"),
				icon: "archive",
				requiresOnline: true,
				onPress: async () => {
					await runBulk({
						items: selectedItems,
						clearSelection: () => useDriveStore.getState().clearSelectedItems(),
						op: async item => {
							const result = await downloadDriveItemToDevice({ item })

							if (!result.success) {
								throw result.error
							}
						}
					})
				}
			})

			bulkButtons.push({
				id: "bulkMakeOffline",
				title: t("make_available_offline_selected"),
				icon: "archive",
				requiresOnline: true,
				onPress: async () => {
					await runBulk({
						items: selectedItems,
						clearSelection: () => useDriveStore.getState().clearSelectedItems(),
						op: async item => {
							const parent = getRealDriveItemParent({ item, drivePath })

							if (!parent) {
								return
							}

							if (item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") {
								await offline.storeFile({ file: item, parent })
							}
						}
					})
				}
			})

			bulkButtons.push({
				id: "bulkTrash",
				title: t("trash_selected"),
				icon: "trash",
				destructive: true,
				requiresOnline: true,
				onPress: async () => {
					await runBulk({
						items: selectedItems,
						clearSelection: () => useDriveStore.getState().clearSelectedItems(),
						confirm: {
							title: t("trash_selected"),
							message: t("are_you_sure_trash_selected_photos"),
							okText: t("trash"),
							cancelText: t("cancel"),
							destructive: true
						},
						op: item => drive.trash({ item, signal: undefined })
					})
				}
			})

			return [
				{
					type: "menu",
					props: {
						type: "dropdown",
						hitSlop: 20,
						buttons: bulkButtons
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
			]
		}

		return [
			{
				type: "menu",
				props: {
					type: "dropdown",
					hitSlop: 20,
					buttons: [
						{
							id: "settings",
							title: t("settings"),
							onPress: () => router.push("/cameraUpload"),
							icon: "gear"
						},
						{
							id: "gridTiles",
							title: t("photos_per_row", { count: photosGridTiles }),
							icon: "grid",
							subButtons: [
								{
									id: "gridTiles1",
									title: "1",
									icon: "grid",
									checked: photosGridTiles === 1,
									onPress: () => setPhotosGridTiles(1)
								},
								{
									id: "gridTiles2",
									title: "2",
									icon: "grid",
									checked: photosGridTiles === 2,
									onPress: () => setPhotosGridTiles(2)
								},
								{
									id: "gridTiles3",
									title: "3",
									icon: "grid",
									checked: photosGridTiles === 3,
									onPress: () => setPhotosGridTiles(3)
								},
								{
									id: "gridTiles4",
									title: "4",
									icon: "grid",
									checked: photosGridTiles === 4,
									onPress: () => setPhotosGridTiles(4)
								},
								{
									id: "gridTiles5",
									title: "5",
									icon: "grid",
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
		]
	})()

	return (
		<StackHeader
			title={inSelectionMode ? t("selected", { count: selectedItems.length }) : t("photos")}
			transparent={Platform.OS === "ios"}
			leftItems={leftItems}
			rightItems={rightItems}
		/>
	)
})

const DateRange = memo(() => {
	const visibleDateRange = usePhotosStore(useShallow(state => state.visibleDateRange))
	const headerHeight = useHeaderHeight()

	if (!visibleDateRange) {
		return null
	}

	const startDate = visibleDateRange.start !== null ? new Date(visibleDateRange.start) : null
	const endDate = visibleDateRange.end !== null ? new Date(visibleDateRange.end) : null

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

								usePhotosStore.getState().setVisibleDateRange({
									start: firstItem?.item.data.decryptedMeta?.created !== undefined
										? Number(firstItem.item.data.decryptedMeta.created)
										: Number(firstItem?.item.data.timestamp),
									end: lastItem?.item.data.decryptedMeta?.created !== undefined
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
})

export default Photos
