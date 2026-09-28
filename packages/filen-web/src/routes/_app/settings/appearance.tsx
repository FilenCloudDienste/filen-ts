import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { SunMoonIcon } from "lucide-react"
import { ThemeRow } from "@/features/settings/components/appearance/themeRow"
import { StartScreenRow } from "@/features/settings/components/appearance/startScreenRow"
import { RailOrderRow } from "@/features/settings/components/appearance/railOrderRow"
import { DriveMemoryRows } from "@/features/settings/components/appearance/driveMemoryRows"
import { SettingsGroup, SettingsPage } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

export const Route = createFileRoute("/_app/settings/appearance")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionAppearance"), i18n.t("common:settings")] }),
	component: AppearancePage
})

function AppearancePage() {
	const { t } = useTranslation("settings")

	return (
		<SettingsPage
			icon={SunMoonIcon}
			title={t("settingsSectionAppearance")}
		>
			<SettingsGroup title={t("settingsGroupGeneral")}>
				<ThemeRow />
				<StartScreenRow />
			</SettingsGroup>
			<SettingsGroup
				title={t("settingsRailTitle")}
				description={t("settingsRailDescription")}
			>
				<RailOrderRow />
			</SettingsGroup>
			<SettingsGroup
				title={t("settingsDriveMemoryTitle")}
				description={t("settingsDriveMemoryDescription")}
			>
				<DriveMemoryRows />
			</SettingsGroup>
		</SettingsPage>
	)
}
