import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Group, type Button } from "@/components/ui/settingsGroup"
import { Fragment } from "react"
import { useNavigation } from "expo-router"
import { run } from "@filen/utils"
import SettingsHeader from "@/components/ui/settingsHeader"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import { useDriveSortPreferences, DEFAULT_SORT_PREFERENCES } from "@/features/drive/driveSortPreference"
import { useDriveViewModePreferences, DEFAULT_VIEW_MODE_PREFERENCES } from "@/features/drive/driveViewModePreference"
import { useStartScreen, START_SCREENS, type StartScreen } from "@/features/settings/startScreen"
import { actionSheet } from "@/providers/actionSheet.provider"
import { useTranslation } from "react-i18next"
import { useLanguage, LANGUAGE_LABELS } from "@/lib/language"
import { SUPPORTED_LANGUAGES } from "@/locales/languages"
import { changeAppLanguage, hasTranslations } from "@/lib/i18n"
import { useThemeSetting, THEME_SETTINGS, changeAppTheme, type ThemeSetting } from "@/lib/theme"
import logger from "@/lib/logger"

function Appearance() {
	const navigation = useNavigation()
	const [sortPrefs, setSortPrefs] = useDriveSortPreferences()
	const [viewModePrefs, setViewModePrefs] = useDriveViewModePreferences()
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
					logger.warn("settings", "reset sort confirmation prompt failed", { error: promptResult.error })
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

	const viewButtons: Button[] = [
		{
			icon: "grid-outline",
			title: t("remember_view_per_directory"),
			subTitle: t("remember_view_per_directory_description"),
			rightItem: {
				type: "switch",
				value: viewModePrefs.mode === "perDirectory",
				onValueChange: value => setViewModePrefs(prev => ({ ...prev, mode: value ? "perDirectory" : "global" }))
			}
		},
		{
			icon: "refresh-outline",
			title: t("reset_view"),
			subTitle: t("reset_view_description"),
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("reset_view"),
						message: t("reset_view_confirm"),
						okText: t("reset"),
						cancelText: t("cancel"),
						destructive: true
					})
				})

				if (!promptResult.success) {
					logger.warn("settings", "reset view confirmation prompt failed", { error: promptResult.error })
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				setViewModePrefs(prev => ({
					...prev,
					global: DEFAULT_VIEW_MODE_PREFERENCES.global,
					perDirectory: {}
				}))
			}
		}
	]

	return (
		<Fragment>
			<SettingsHeader
				title={t("appearance")}
				icon="close"
				onDismiss={() => {
					navigation.getParent()?.goBack()
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<SettingsScrollView>
					<Group
						className="bg-background-tertiary"
						buttons={generalButtons}
					/>
					<Group
						className="bg-background-tertiary"
						buttons={sortButtons}
					/>
					<Group
						className="bg-background-tertiary"
						buttons={viewButtons}
					/>
				</SettingsScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default Appearance
