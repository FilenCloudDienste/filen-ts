import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform, ScrollView } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
import { deserializeRouteParam } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import { DirectoryIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import Header from "@/components/ui/header"
import { Fragment, memo } from "react"
import { useResolveClassNames } from "uniwind"
import { cn } from "@filen/utils"
import { driveItemDisplayName } from "@/lib/decryption"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import { Information } from "@/features/drive/components/information"
import DismissStack from "@/components/dismissStack"
import CannotDecryptScreen from "@/components/cannotDecryptScreen"
import { useTranslation } from "react-i18next"

const DriveItemInfo = memo(() => {
	const { item: itemSerialized } = useLocalSearchParams<{
		item?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const { t } = useTranslation()

	const item = deserializeRouteParam<DriveItem>(itemSerialized)

	if (!item) {
		return <DismissStack />
	}

	// Deep-link defensive guard: if the user opens info for an undecryptable
	// item, show the cannot-decrypt screen instead of an info sheet that would
	// surface uuid-only fallbacks for every metadata row.
	if (item.data.undecryptable) {
		return (
			<CannotDecryptScreen
				uuid={item.data.uuid}
				surface="driveInfo"
			/>
		)
	}

	return (
		<Fragment>
			<Header
				title={t("item_info")}
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
							{driveItemDisplayName(item)}
						</Text>
						<Text className="text-muted-foreground">
							{item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
								? t("directory")
								: t("file")}
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
