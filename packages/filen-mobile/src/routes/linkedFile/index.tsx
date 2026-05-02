import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform, ScrollView } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
import { deserialize } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import Header from "@/components/ui/header"
import { Fragment, memo } from "react"
import { useResolveClassNames } from "uniwind"
import { cn } from "@filen/utils"
import Thumbnail from "@/components/drive/item/thumbnail"
import DismissStack from "@/components/dismissStack"
import { Information } from "@/routes/driveItemInfo"
import { getPreviewType } from "@/lib/utils"
import type { MenuButton } from "@/components/ui/menu"

const LinkedFile = memo(() => {
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
			return deserialize(itemSerialized) as Extract<
				DriveItem,
				{
					type: "file"
				}
			>
		} catch {
			return null
		}
	})()

	const previewType = item?.data.decryptedMeta?.name ? getPreviewType(item.data.decryptedMeta.name) : null

	if (!item || item.type !== "file") {
		return <DismissStack />
	}

	return (
		<Fragment>
			<Header
				title={item.data.decryptedMeta?.name ?? item.data.uuid}
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
				rightItems={[
					{
						type: "menu",
						props: {
							type: "dropdown",
							hitSlop: 20,
							buttons: [
								{
									id: "download",
									icon: "export",
									title: "tbd_download_to_device",
									onPress: () => {
										// TODO
									}
								},
								...(previewType === "image" || previewType === "video"
									? [
											{
												id: "save_to_photos",
												icon: "export",
												title: "tbd_save_to_photos",
												onPress: () => {
													// TODO
												}
											} satisfies MenuButton
										]
									: []),
								{
									id: "export",
									icon: "export",
									title: "tbd_export",
									onPress: () => {
										// TODO
									}
								},
								{
									id: "import",
									icon: "export",
									title: "tbd_import",
									onPress: () => {
										// TODO
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
						<Thumbnail
							item={item}
							size={{
								icon: 128,
								thumbnail: 128
							}}
							contentFit="cover"
							className="rounded-3xl"
						/>
						<Text
							className="text-lg font-bold mt-4"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{item.data.decryptedMeta?.name ?? item.data.uuid}
						</Text>
						<Text className="text-muted-foreground">tbd_file</Text>
					</View>
					<View className="bg-transparent mt-10">
						<Information
							item={item}
							linked={true}
						/>
					</View>
				</ScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default LinkedFile
