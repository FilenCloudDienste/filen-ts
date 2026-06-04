import SafeAreaView from "@/components/ui/safeAreaView"
import { Group, type Button } from "@/components/ui/settingsGroup"
import { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment } from "react"
import { useNavigation } from "expo-router"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import { useDriveSortPreferences, DEFAULT_SORT_PREFERENCES } from "@/lib/driveSortPreference"
import { useStartScreen, START_SCREENS, type StartScreen } from "@/features/settings/startScreen"
import { actionSheet } from "@/providers/actionSheet.provider"
import { useTranslation } from "react-i18next"
import { useLanguage, LANGUAGE_LABELS } from "@/lib/language"
import { SUPPORTED_LANGUAGES } from "@/locales/languages"
import { changeAppLanguage, hasTranslations } from "@/lib/i18n"
import { useThemeSetting, THEME_SETTINGS, changeAppTheme, type ThemeSetting } from "@/lib/theme"

function Appearance() {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()
	const [sortPrefs, setSortPrefs] = useDriveSortPreferences()
	const [startScreen, setStartScreen] = useStartScreen()
	const { t } = useTranslation()
	const [language, setLanguage] = useLanguage()
	const [themeSetting, setThemeSetting] = useThemeSetting()

	const startScreenLabels: Record<StartScreen, string> = {
		drive: t("start_screen_drive"),
		photos: t("start_screen_photos"),
		notes: t("start_screen_notes"),
		chats: t("start_screen_chats"),
		more: t("start_screen_more")
	}

	const themeLabels: Record<ThemeSetting, string> = {
		system: t("theme_system"),
		light: t("theme_light"),
		dark: t("theme_dark")
	}

	const generalButtons: Button[] = [
		{
			icon: "contrast-outline",
			title: t("theme"),
			subTitle: t("theme_description"),
			rightItem: {
				type: "text",
				value: themeLabels[themeSetting]
			},
			onPress: () => {
				actionSheet.show({
					buttons: [
						...THEME_SETTINGS.map(option => ({
							title: themeLabels[option],
							onPress: () => {
								setThemeSetting(option)
								changeAppTheme(option)
							}
						})),
						{
							title: t("close"),
							cancel: true
						}
					]
				})
			}
		},
		{
			icon: "rocket-outline",
			title: t("start_screen"),
			subTitle: t("start_screen_description"),
			rightItem: {
				type: "text",
				value: startScreenLabels[startScreen]
			},
			onPress: () => {
				actionSheet.show({
					buttons: [
						...START_SCREENS.map(option => ({
							title: startScreenLabels[option],
							onPress: () => {
								setStartScreen(option)
							}
						})),
						{
							title: t("close"),
							cancel: true
						}
					]
				})
			}
		},
		{
			icon: "language-outline",
			title: t("language"),
			subTitle: t("language_description"),
			rightItem: {
				type: "text",
				value: LANGUAGE_LABELS[language]
			},
			onPress: () => {
				// Only offer languages that actually ship translations (English always; another
				// language only once its catalog has ≥1 key). The empty stub catalogs must not
				// surface a fake option that would just fall back to English. Keep the current
				// selection visible even in the unlikely case its catalog became empty.
				const offeredLanguages = SUPPORTED_LANGUAGES.filter(option => hasTranslations(option) || option === language)

				actionSheet.show({
					buttons: [
						...offeredLanguages.map(option => ({
							title: LANGUAGE_LABELS[option],
							onPress: () => {
								setLanguage(option)
								changeAppLanguage(option)
							}
						})),
						{
							title: t("close"),
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
			title: t("remember_sort_per_directory"),
			subTitle: t("remember_sort_per_directory_description"),
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
			title: t("reset_sort"),
			subTitle: t("reset_sort_description"),
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("reset_sort"),
						message: t("reset_sort_confirm"),
						okText: t("reset"),
						cancelText: t("cancel"),
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
				title={t("appearance")}
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
}

export default Appearance
