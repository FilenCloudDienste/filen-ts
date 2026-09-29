import { useTranslation } from "react-i18next"
import { useTheme, type Theme } from "@/providers/themeProvider"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"

const THEME_OPTIONS: { value: Theme; labelKey: "settingsThemeLight" | "settingsThemeDark" | "settingsThemeSystem" }[] = [
	{ value: "light", labelKey: "settingsThemeLight" },
	{ value: "dark", labelKey: "settingsThemeDark" },
	{ value: "system", labelKey: "settingsThemeSystem" }
]

// One implementation of the three-way theme choice: `useTheme()` (themeProvider.tsx) is the SAME
// state the account menu's quick toggle and the "d" keymap action already drive — this row is
// just a second, fuller-choice surface over that one piece of state, never a duplicate store.
function ThemeRow() {
	const { t } = useTranslation("settings")
	const { theme, setTheme } = useTheme()

	return (
		<SettingsSelectRow
			label={t("settingsThemeTitle")}
			description={t("settingsThemeDescription")}
			id="theme-select"
			options={THEME_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) }))}
			value={theme}
			disabled={false}
			onChange={setTheme}
		/>
	)
}

export { ThemeRow }
