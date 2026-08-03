import { useTranslation } from "react-i18next"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ShortcutsList } from "@/lib/keymap/shortcutsList"

// The settings half of the shortcuts surface. Same <ShortcutsList /> the ? overlay renders — this
// card is only the settings shell around it, never a second list or a second data path.
function ShortcutsCard() {
	const { t } = useTranslation("common")

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("shortcutsTitle")}</CardTitle>
				<CardDescription>{t("shortcutsDescription")}</CardDescription>
			</CardHeader>
			<CardContent>
				<ShortcutsList />
			</CardContent>
		</Card>
	)
}

export { ShortcutsCard }
