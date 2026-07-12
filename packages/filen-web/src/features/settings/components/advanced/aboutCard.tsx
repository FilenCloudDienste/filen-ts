import { useTranslation } from "react-i18next"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

// External links only — same target="_blank" + rel="noopener noreferrer" convention as
// currentPlanCard's "Manage on filen.io" link. Electron: window.desktop carries no "open external
// URL" bridge method, and a plain `<a target="_blank">` inside an Electron BrowserWindow already
// opens the OS default browser (Electron's default `window.open` handler for a target the app
// hasn't otherwise intercepted), so no bridge call is needed here either.
function AboutCard() {
	const { t } = useTranslation("settings")

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsAboutTitle")}</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					size="sm"
					render={
						<a
							href="https://filen.io/terms"
							target="_blank"
							rel="noopener noreferrer"
						/>
					}
				>
					{t("settingsAboutTermsOfService")}
				</Button>
				<Button
					variant="outline"
					size="sm"
					render={
						<a
							href="https://filen.io/privacy"
							target="_blank"
							rel="noopener noreferrer"
						/>
					}
				>
					{t("settingsAboutPrivacyPolicy")}
				</Button>
			</CardContent>
		</Card>
	)
}

export { AboutCard }
