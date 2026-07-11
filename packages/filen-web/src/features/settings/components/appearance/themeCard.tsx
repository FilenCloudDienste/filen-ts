import { useTranslation } from "react-i18next"
import { useTheme, type Theme } from "@/providers/themeProvider"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Field, FieldContent, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const THEME_OPTIONS: { value: Theme; labelKey: "settingsThemeLight" | "settingsThemeDark" | "settingsThemeSystem" }[] = [
	{ value: "light", labelKey: "settingsThemeLight" },
	{ value: "dark", labelKey: "settingsThemeDark" },
	{ value: "system", labelKey: "settingsThemeSystem" }
]

// One implementation of the three-way theme choice: `useTheme()` (themeProvider.tsx) is the SAME
// state the account menu's quick toggle and the "d" keymap action already drive — this card is
// just a second, fuller-choice surface over that one piece of state, never a duplicate store.
function ThemeCard() {
	const { t } = useTranslation("settings")
	const { theme, setTheme } = useTheme()

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsThemeTitle")}</CardTitle>
				<CardDescription>{t("settingsThemeDescription")}</CardDescription>
			</CardHeader>
			<CardContent>
				<Field orientation="horizontal">
					<FieldContent>
						<FieldLabel htmlFor="theme-select">{t("settingsThemeTitle")}</FieldLabel>
					</FieldContent>
					<Select
						items={THEME_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) }))}
						value={theme}
						onValueChange={value => {
							if (value !== null) {
								setTheme(value)
							}
						}}
					>
						<SelectTrigger id="theme-select">
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
				</Field>
			</CardContent>
		</Card>
	)
}

export { ThemeCard }
