import { useEffect } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { FilePenLineIcon } from "lucide-react"
import { loadOfficeSettings } from "@/features/office/lib/officeSettings"
import { OfficeGeneralRows } from "@/features/settings/components/office/generalRows"
import { OfficeProofingRows } from "@/features/settings/components/office/proofingRows"
import { OfficeRegionalRows } from "@/features/settings/components/office/regionalRows"
import { OfficeLayoutRows, OfficeWordRows } from "@/features/settings/components/office/deviceRows"
import { SettingsGroup, SettingsPage } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

export const Route = createFileRoute("/_app/settings/office")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionOffice"), i18n.t("common:settings")] }),
	component: OfficePage
})

// How documents, spreadsheets and presentations are edited: the synced settings (features/office/lib/
// officeSettings.ts, read once as the page opens) and this device's view settings.
function OfficePage() {
	const { t } = useTranslation("settings")

	useEffect(() => {
		void loadOfficeSettings()
	}, [])

	return (
		<SettingsPage
			icon={FilePenLineIcon}
			title={t("settingsSectionOffice")}
		>
			<SettingsGroup
				title={t("settingsGroupGeneral")}
				description={t("settingsOfficeGeneralDescription")}
			>
				<OfficeGeneralRows />
			</SettingsGroup>
			<SettingsGroup
				title={t("settingsOfficeProofingTitle")}
				description={t("settingsOfficeProofingDescription")}
			>
				<OfficeProofingRows />
			</SettingsGroup>
			<SettingsGroup
				title={t("settingsOfficeRegionalTitle")}
				description={t("settingsOfficeRegionalDescription")}
			>
				<OfficeRegionalRows />
			</SettingsGroup>
			<SettingsGroup
				title={t("settingsOfficeWordTitle")}
				description={t("settingsOfficeWordDescription")}
			>
				<OfficeWordRows />
			</SettingsGroup>
			<SettingsGroup
				title={t("settingsOfficeLayoutTitle")}
				description={t("settingsOfficeLayoutDescription")}
			>
				<OfficeLayoutRows />
			</SettingsGroup>
		</SettingsPage>
	)
}
