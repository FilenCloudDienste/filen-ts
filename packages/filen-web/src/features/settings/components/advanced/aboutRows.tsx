import { useTranslation } from "react-i18next"
import { FILEN_PRIVACY_URL, FILEN_TERMS_URL } from "@/lib/externalUrls"
import { SettingsLinkRow } from "@/features/settings/components/settingsLayout"

// External links only — same target="_blank" + rel="noopener noreferrer" convention as the Billing
// page's "Manage on filen.io" link. In the desktop app the shell's window-open handler sends them to the
// OS browser, so no bridge call is needed.
function AboutRows() {
	const { t } = useTranslation("common")

	return (
		<>
			<SettingsLinkRow
				href={FILEN_TERMS_URL}
				label={t("legalTerms")}
			/>
			<SettingsLinkRow
				href={FILEN_PRIVACY_URL}
				label={t("legalPrivacy")}
			/>
		</>
	)
}

export { AboutRows }
