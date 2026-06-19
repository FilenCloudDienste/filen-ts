import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform, ScrollView } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { router } from "@/lib/router"
import { deserializeRouteParam } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import Header from "@/components/ui/header"
import { Fragment } from "react"
import { useResolveClassNames } from "uniwind"
import { cn } from "@filen/utils"
import { Information } from "@/features/drive/components/information"
import DismissStack from "@/components/dismissStack"
import CannotDecryptScreen from "@/components/cannotDecryptScreen"
import { useTranslation } from "react-i18next"
import DriveItemHero from "@/components/ui/driveItemHero"
import { isDrivePathType } from "@/hooks/useDrivePath"

const DriveItemInfo = () => {
	const { item: itemSerialized, drivePathType } = useLocalSearchParams<{
		item?: string
		drivePathType?: string
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
					<DriveItemHero item={item} />
					<View className="bg-transparent mt-10">
						<Information
							item={item}
							drivePathType={isDrivePathType(drivePathType) ? drivePathType : undefined}
						/>
					</View>
				</ScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default DriveItemInfo
