import { Fragment, useRef, memo } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader from "@/components/ui/header"
import View from "@/components/ui/view"
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
import { Buffer } from "react-native-quick-crypto"
import { pack } from "@/lib/msgpack"
import type { AnyDirWithContext } from "@filen/sdk-rs"
import Menu from "@/components/drive/item/menu"
import cameraUpload, { useCameraUpload } from "@/lib/cameraUpload"
import Text from "@/components/ui/text"
import Button from "@/components/ui/button"
import { useResolveClassNames } from "uniwind"
import useCameraUploadStore from "@/stores/useCameraUpload.store"
import { useShallow } from "zustand/shallow"

const Photo = memo(
	({
		info,
		size,
		drivePath,
		parent
	}: {
		info: ListRenderItemInfo<DriveItemFileExtracted>
		size: number
		drivePath: DrivePath
		parent?: AnyDirWithContext
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

		const thumbnailSize: React.ComponentProps<typeof Thumbnail>["size"] = {
			icon: size - 2,
			thumbnail: size - 2
		}

		const onPress = () => {
			router.push({
				pathname: "/drivePreview",
				params: {
					item: Buffer.from(pack(info.item)).toString("base64"),
					drivePath: Buffer.from(pack(drivePath)).toString("base64"),
					parent: parent ? Buffer.from(pack(parent)).toString("base64") : undefined
				}
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
					parent={parent}
					origin="photos"
					drivePath={drivePath}
					isStoredOffline={driveItemStoredOfflineQuery.status === "success" ? driveItemStoredOfflineQuery.data : false}
				>
					<View style={viewStyle}>
						<PressableOpacity
							className="items-center justify-center flex-1 overflow-hidden"
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
							<Thumbnail
								item={info.item}
								contentFit="cover"
								size={thumbnailSize}
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

const Photos = memo(() => {
	const viewRef = useRef<RNView>(null)
	const { layout, onLayout } = useViewLayout(viewRef)
	const { config } = useCameraUpload()
	const drivePath = useDrivePath()

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null && config.enabled && config.remoteDir !== null
		}
	)

	const size = !layout ? 0 : layout.width / 4

	return (
		<Fragment>
			<Header />
			<SafeAreaView edges={["left", "right"]}>
				<View
					ref={viewRef}
					onLayout={onLayout}
					className="flex-1"
				>
					{config.enabled && config.remoteDir ? (
						<VirtualList
							className="flex-1"
							contentInsetAdjustmentBehavior="automatic"
							contentContainerClassName="pb-40"
							itemHeight={size}
							grid={true}
							itemWidth={size}
							keyExtractor={item => item.data.uuid}
							data={
								(driveItemsQuery.data
									? itemSorter.sortItems(
											driveItemsQuery.data.filter(item => {
												if (!item.data.decryptedMeta || (item.type !== "file" && item.type !== "sharedFile")) {
													return false
												}

												const previewType = getPreviewType(item.data.decryptedMeta.name)

												return previewType === "image" || previewType === "video"
											}),
											"creationDesc"
										)
									: []) as DriveItemFileExtracted[]
							}
							renderItem={info => {
								return (
									<Photo
										info={info}
										size={size}
										drivePath={drivePath}
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
