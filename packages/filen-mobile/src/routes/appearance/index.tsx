import SafeAreaView from "@/components/ui/safeAreaView"
import { Group, type Button } from "@/routes/tabs/more"
import { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, memo } from "react"
import { useNavigation } from "expo-router"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import { useDriveSortPreferences } from "@/lib/driveSortPreference"

const Appearance = memo(() => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()
	const [sortPrefs, setSortPrefs] = useDriveSortPreferences()

	const hasPerDirectoryEntries = Object.keys(sortPrefs.perDirectory).length > 0

	const buttons: Button[] = [
		{
			icon: "swap-vertical-outline",
			title: "tbd_remember_sort_per_directory",
			subTitle: "tbd_remember_sort_per_directory_description",
			rightItem: {
				type: "switch",
				value: sortPrefs.mode === "perDirectory",
				onValueChange: value =>
					setSortPrefs(prev => ({
						...prev,
						mode: value ? "perDirectory" : "global"
					}))
			}
		}
	]

	if (hasPerDirectoryEntries) {
		buttons.push({
			icon: "refresh-outline",
			title: "tbd_reset_per_directory_sort",
			subTitle: "tbd_reset_per_directory_sort_description",
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: "tbd_reset_per_directory_sort",
						message: "tbd_reset_per_directory_sort_confirm",
						okText: "tbd_reset",
						cancelText: "tbd_cancel",
						destructive: true
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				setSortPrefs(prev => ({
					...prev,
					perDirectory: {}
				}))
			}
		})
	}

	return (
		<Fragment>
			<Header
				title="tbd_appearance"
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={() => {
					if (Platform.OS === "android") {
						return null
					}

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
									navigation.getParent()?.goBack()
								}
							}
						}
					]
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<GestureHandlerScrollView
					className="bg-transparent flex-1"
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName="px-4 gap-4"
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
				>
					<Group
						className="bg-background-tertiary"
						buttons={buttons}
					/>
				</GestureHandlerScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default Appearance
