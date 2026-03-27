import { Fragment, useRef, memo } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
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
import { PressableWithoutFeedback } from "@/components/ui/pressables"
import useDrivePath, { type DrivePath } from "@/hooks/useDrivePath"
import { router } from "expo-router"
import { Buffer } from "react-native-quick-crypto"
import { pack } from "@/lib/msgpack"
import type { AnyDirWithContext } from "@filen/sdk-rs"
import Menu from "@/components/drive/item/menu"
import { useCameraUpload } from "@/lib/cameraUpload"
import Text from "@/components/ui/text"
import Button from "@/components/ui/button"
import { useResolveClassNames } from "uniwind"

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
						<PressableWithoutFeedback
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
						</PressableWithoutFeedback>
					</View>
				</Menu>
			</View>
		)
	}
)

const Photos = memo(() => {
	const viewRef = useRef<RNView>(null)
	const { layout, onLayout } = useViewLayout(viewRef)
	const { config } = useCameraUpload()
	const textForeground = useResolveClassNames("text-foreground")
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

	const renderItem = (info: ListRenderItemInfo<DriveItemFileExtracted>) => {
		return (
			<Photo
				info={info}
				size={size}
				drivePath={drivePath}
			/>
		)
	}

	const keyExtractor = (item: DriveItemFileExtracted) => {
		return item.data.uuid
	}

	const data = driveItemsQuery.data
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
		: []

	const onRefresh = async () => {
		const result = await run(async () => {
			await driveItemsQuery.refetch()
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}

	return (
		<Fragment>
			<Header
				title="tbd_photos"
				transparent={Platform.OS === "ios"}
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
							keyExtractor={keyExtractor}
							data={data as DriveItemFileExtracted[]}
							renderItem={renderItem}
							onRefresh={onRefresh}
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
