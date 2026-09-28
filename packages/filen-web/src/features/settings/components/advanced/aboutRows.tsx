import { useTranslation } from "react-i18next"
import { FILEN_PRIVACY_URL, FILEN_TERMS_URL } from "@/lib/externalUrls"
import { SettingsLinkRow } from "@/features/settings/components/settingsLayout"

// External links only — same target="_blank" + rel="noopener noreferrer" convention as the Billing
// page's "Manage on filen.io" link. Electron: window.desktop carries no "open external URL" bridge
// method, and a plain `<a target="_blank">` inside an Electron BrowserWindow already opens the OS
// default browser (Electron's default `window.open` handler for a target the app hasn't otherwise
// intercepted), so no bridge call is needed here either.
function AboutRows() {
	const { t } = useTranslation("settings")

	return (
		<>
			<SettingsLinkRow
				href={FILEN_TERMS_URL}
				label={t("settingsAboutTermsOfService")}
			/>
			<SettingsLinkRow
				href={FILEN_PRIVACY_URL}
				label={t("settingsAboutPrivacyPolicy")}
			/>
		</>
	)
}

export { AboutRows }
