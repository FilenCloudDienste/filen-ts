import { useEffect } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { SparklesIcon } from "lucide-react"
import { HideAssistantRow } from "@/features/settings/components/assistant/hideAssistantRow"
import { loadOfficeSettings } from "@/features/office/lib/officeSettings"
import { RetentionRow } from "@/features/settings/components/assistant/retentionRow"
import { SettingsGroup, SettingsPage } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

export const Route = createFileRoute("/_app/settings/assistant")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionAssistant"), i18n.t("common:settings")] }),
	component: AssistantSettingsPage
})

// The on-device assistant's settings: whether it is hidden (synced across devices) and how long conversations are kept
// (this device). Both stored values are read during boot. Reachable while hidden: the switch turns it back on.
function AssistantSettingsPage() {
	const { t } = useTranslation("settings")

	// The synced Hide Assistant switch waits for the office settings' read.
	useEffect(() => {
		void loadOfficeSettings()
	}, [])

	return (
		<SettingsPage
			icon={SparklesIcon}
			title={t("settingsSectionAssistant")}
		>
			<SettingsGroup title={t("settingsGroupGeneral")}>
				<HideAssistantRow />
			</SettingsGroup>
			<SettingsGroup title={t("settingsAssistantGroupConversations")}>
				<RetentionRow />
			</SettingsGroup>
		</SettingsPage>
	)
}
