import DriveItemHero from "@/components/ui/driveItemHero"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform, ScrollView } from "react-native"
import { useLocalSearchParams, useNavigation } from "expo-router"
import { deserializeRouteParam } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import Header from "@/components/ui/header"
import { Fragment } from "react"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "uniwind"
import { cn } from "@filen/utils"
import DismissStack from "@/components/dismissStack"
import { Information } from "@/features/drive/components/information"
import useHttpStore from "@/stores/useHttp.store"
import { useShallow } from "zustand/shallow"
import { createMenuButtons } from "@/features/drive/components/item/menuActions"
import { driveItemDisplayName } from "@/lib/decryption"
import CannotDecryptScreen from "@/components/cannotDecryptScreen"

const LinkedFile = () => {
	const { t } = useTranslation()
	const { item: itemSerialized } = useLocalSearchParams<{
		item?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const getFileUrl = useHttpStore(useShallow(state => state.getFileUrl))
	const navigation = useNavigation()

	const item = deserializeRouteParam<Extract<DriveItem, { type: "file" }>>(itemSerialized)

	if (!item || item.type !== "file") {
		return <DismissStack />
	}

	if (item.data.undecryptable) {
		return (
			<CannotDecryptScreen
				uuid={item.data.uuid}
				surface="linkedFile"
			/>
		)
	}

	return (
		<Fragment>
			<Header
				title={driveItemDisplayName(item)}
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
									navigation.getParent()?.goBack()
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
							buttons: getFileUrl
								? createMenuButtons({
										item,
										drivePath: {
											type: "linked",
											uuid: null
										},
										isStoredOffline: false,
										t
									})
								: []
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
					<DriveItemHero item={item} />
					<View className="bg-transparent mt-10">
						<Information
							item={item}
							linked={true}
							drivePathType="linked"
						/>
					</View>
				</ScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default LinkedFile
