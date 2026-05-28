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
import { useDriveSortPreferences, DEFAULT_SORT_PREFERENCES } from "@/lib/driveSortPreference"
import { useStartScreen, START_SCREENS, type StartScreen } from "@/lib/startScreen"
import { actionSheet } from "@/providers/actionSheet.provider"

const START_SCREEN_LABELS: Record<StartScreen, string> = {
	drive: "tbd_drive",
	photos: "tbd_photos",
	notes: "tbd_notes",
	chats: "tbd_chats",
	more: "tbd_more"
}

const Appearance = memo(() => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()
	const [sortPrefs, setSortPrefs] = useDriveSortPreferences()
	const [startScreen, setStartScreen] = useStartScreen()

	const generalButtons: Button[] = [
		{
			icon: "rocket-outline",
			title: "tbd_start_screen",
			subTitle: "tbd_start_screen_description",
			rightItem: {
				type: "text",
				value: START_SCREEN_LABELS[startScreen]
			},
			onPress: () => {
				actionSheet.show({
					buttons: [
						...START_SCREENS.map(option => ({
							title: START_SCREEN_LABELS[option],
							onPress: () => {
								setStartScreen(option)
							}
						})),
						{
							title: "tbd_close",
							cancel: true
						}
					]
				})
			}
		}
	]

	const sortButtons: Button[] = [
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
		},
		{
			icon: "refresh-outline",
			title: "tbd_reset_sort",
			subTitle: "tbd_reset_sort_description",
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: "tbd_reset_sort",
						message: "tbd_reset_sort_confirm",
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
					global: DEFAULT_SORT_PREFERENCES.global,
					perDirectory: {}
				}))
			}
		}
	]

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
						buttons={generalButtons}
					/>
					<Group
						className="bg-background-tertiary"
						buttons={sortButtons}
					/>
				</GestureHandlerScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default Appearance
