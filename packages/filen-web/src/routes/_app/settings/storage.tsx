import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { DatabaseIcon } from "lucide-react"
import { SettingsPage } from "@/features/settings/components/settingsLayout"
import { StorageCaches } from "@/features/settings/components/storage/storageCaches"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

export const Route = createFileRoute("/_app/settings/storage")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionStorage"), i18n.t("common:settings")] }),
	component: StoragePage
})

function StoragePage() {
	const { t } = useTranslation("settings")

	return (
		<SettingsPage
			icon={DatabaseIcon}
			title={t("settingsSectionStorage")}
		>
			<StorageCaches />
		</SettingsPage>
	)
}
