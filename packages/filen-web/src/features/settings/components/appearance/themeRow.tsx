import { useTranslation } from "react-i18next"
import { useTheme, type Theme } from "@/providers/themeProvider"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

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
		<SettingsRow
			label={t("settingsThemeTitle")}
			description={t("settingsThemeDescription")}
			htmlFor="theme-select"
		>
			<Select
				items={THEME_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) }))}
				value={theme}
				onValueChange={value => {
					if (value !== null) {
						setTheme(value)
					}
				}}
			>
				<SelectTrigger
					id="theme-select"
					className="min-w-36"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{THEME_OPTIONS.map(option => (
							<SelectItem
								key={option.value}
								value={option.value}
							>
								{t(option.labelKey)}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</SettingsRow>
	)
}

export { ThemeRow }
