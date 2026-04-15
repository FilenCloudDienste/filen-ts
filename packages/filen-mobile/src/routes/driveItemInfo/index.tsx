import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform, ScrollView } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
import { deserialize } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import { DirectoryIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import Header from "@/components/ui/header"
import { Fragment, memo } from "react"
import { useResolveClassNames } from "uniwind"
import { cn, formatBytes } from "@filen/utils"
import useDirectorySizeQuery from "@/queries/useDirectorySize.query"
import useDriveItemStoredOfflineQuery from "@/queries/useDriveItemStoredOffline.query"
import { simpleDate } from "@/lib/time"
import Ionicons from "@expo/vector-icons/Ionicons"
import { getPreviewType } from "@/lib/utils"
import Thumbnail from "@/components/drive/item/thumbnail"
import DismissStack from "@/components/dismissStack"

export const Information = memo(({ item }: { item: DriveItem }) => {
	const textRed500 = useResolveClassNames("text-red-500")
	const textGreen500 = useResolveClassNames("text-green-500")

	const directorySizeQuery = useDirectorySizeQuery(
		{
			uuid: item?.data.uuid ?? "",
			// TODO: Fix type for shared in/out based on sharing role
			type:
				item.type === "sharedDirectory" ||
				item.type === "sharedFile" ||
				item.type === "sharedRootFile" ||
				item.type === "sharedRootDirectory"
					? "sharedOut"
					: "normal"
		},
		{
			enabled: item !== null && (item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory")
		}
	)

	const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery({
		uuid: item?.data.uuid ?? "",
		type: item?.type ?? "file"
	})

	// TODO: extract to function and clean up
	const info: {
		type: string
		title: string
		value: string | React.ReactNode
	}[] = (
		[
			{
				type: "type",
				title: "tbd_type",
				value:
					item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
						? "tbd_directory"
						: "tbd_file"
			},
			...(item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
				? [
						{
							type: "mime",
							title: "tbd_mime",
							value: item.data.decryptedMeta?.mime ?? "application/octet-stream"
						},
						{
							type: "previewType",
							title: "tbd_preview_type",
							value: (() => {
								const previewType = getPreviewType(item.data.decryptedMeta?.name ?? "")

								switch (previewType) {
									case "audio": {
										return "tbd_preview_type_audio"
									}

									case "code": {
										return "tbd_preview_type_code"
									}

									case "docx": {
										return "tbd_preview_type_docx"
									}

									case "pdf": {
										return "tbd_preview_type_pdf"
									}

									case "image": {
										return "tbd_preview_type_image"
									}

									case "text": {
										return "tbd_preview_type_text"
									}

									case "video": {
										return "tbd_preview_type_video"
									}

									case "unknown": {
										return "tbd_preview_type_unknown"
									}
								}
							})()
						}
					]
				: []),
			{
				type: "size",
				title: "tbd_size",
				value: (() => {
					switch (item.type) {
						case "file":
						case "sharedFile":
						case "sharedRootFile": {
							return formatBytes(Number(item.data.size))
						}

						case "directory":
						case "sharedDirectory":
						case "sharedRootDirectory": {
							if (directorySizeQuery.status !== "success") {
								return "..."
							}

							return formatBytes(directorySizeQuery.data.size)
						}
					}
				})()
			},
			...(item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
				? [
						{
							type: "files",
							title: "tbd_files",
							value: directorySizeQuery.status === "success" ? directorySizeQuery.data.files.toString() : "..."
						},
						{
							type: "directories",
							title: "tbd_directories",
							value: directorySizeQuery.status === "success" ? directorySizeQuery.data.dirs.toString() : "..."
						}
					]
				: []),
			{
				type: "created",
				title: "tbd_created",
				value: (() => {
					if (!item.data.decryptedMeta) {
						return null
					}

					switch (item.type) {
						case "file": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "sharedFile":
						case "sharedRootFile": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "directory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "sharedDirectory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.inner.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "sharedRootDirectory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.inner.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}
					}
				})()
			},
			{
				type: "modified",
				title: "tbd_modified",
				value: (() => {
					if (!item.data.decryptedMeta) {
						return null
					}

					switch (item.type) {
						case "file": {
							if (!item.data.decryptedMeta.modified) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.modified))
						}

						case "sharedFile":
						case "sharedRootFile": {
							if (!item.data.decryptedMeta.modified) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.modified))
						}

						case "directory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "sharedDirectory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.inner.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}

						case "sharedRootDirectory": {
							if (!item.data.decryptedMeta.created) {
								return simpleDate(Number(item.data.inner.timestamp))
							}

							return simpleDate(Number(item.data.decryptedMeta.created))
						}
					}
				})()
			},
			{
				type: "uploaded",
				title: "tbd_uploaded",
				value: (() => {
					if (!item.data.decryptedMeta) {
						return null
					}

					switch (item.type) {
						case "file":
						case "sharedFile":
						case "sharedRootFile": {
							return simpleDate(Number(item.data.timestamp))
						}

						case "directory": {
							return simpleDate(Number(item.data.timestamp))
						}

						case "sharedRootDirectory":
						case "sharedDirectory": {
							return simpleDate(Number(item.data.inner.timestamp))
						}
					}
				})()
			},
			{
				type: "offline",
				title: "tbd_offline",
				value: (
					<Ionicons
						name="cloud-download-outline"
						size={16}
						color={
							driveItemStoredOfflineQuery.status === "success" && driveItemStoredOfflineQuery.data
								? textGreen500.color
								: textRed500.color
						}
					/>
				)
			}
		] as const
	).filter(info => info.value !== null)

	return (
		<View className="bg-transparent flex-col gap-2">
			<View className="bg-transparent border-b border-border pb-2 flex-row items-center justify-between gap-4">
				<Text className="text-lg text-muted-foreground font-bold">tbd_information</Text>
			</View>
			{info.map(({ type, value, title }) => (
				<View
					key={type}
					className="bg-transparent border-b border-border pb-2 flex-row items-center justify-between gap-4"
				>
					<Text
						className="text-muted-foreground shrink-0"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{title}
					</Text>
					<View className="bg-transparent flex-1 justify-end items-center flex-row gap-2">
						{typeof value === "string" ? (
							<Text
								className="text-foreground flex-1 text-right"
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{value}
							</Text>
						) : (
							value
						)}
					</View>
				</View>
			))}
		</View>
	)
})

const DriveItemInfo = memo(() => {
	const { item: itemSerialized } = useLocalSearchParams<{
		item?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")

	const item = (() => {
		if (!itemSerialized) {
			return null
		}

		try {
			return deserialize(itemSerialized) as DriveItem
		} catch {
			return null
		}
	})()

	if (!item) {
		return <DismissStack />
	}

	return (
		<Fragment>
			<Header
				title="tbd_info"
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={Platform.select({
					ios: [
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
					],
					default: undefined
				})}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<ScrollView
					contentContainerClassName={cn("bg-transparent px-4 flex-col pb-40 pt-10", Platform.OS === "ios" && "pt-24")}
					showsHorizontalScrollIndicator={true}
					showsVerticalScrollIndicator={false}
				>
					<View className="bg-transparent items-center justify-center flex-col px-4">
						{item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory" ? (
							<DirectoryIcon
								color={item.type === "directory" ? item.data.color : DirColor.Default.new()}
								width={128}
								height={128}
							/>
						) : (
							<Thumbnail
								item={item}
								size={{
									icon: 128,
									thumbnail: 128
								}}
								contentFit="cover"
								className="rounded-3xl"
							/>
						)}
						<Text
							className="text-lg font-bold mt-4"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{item.data.decryptedMeta?.name ?? item.data.uuid}
						</Text>
						<Text className="text-muted-foreground">
							{item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
								? "tbd_directory"
								: "tbd_file"}
						</Text>
					</View>
					<View className="bg-transparent mt-10">
						<Information item={item} />
					</View>
				</ScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default DriveItemInfo
