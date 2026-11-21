import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { SparklesIcon } from "lucide-react"
import { RetentionRow } from "@/features/settings/components/assistant/retentionRow"
import { SettingsGroup, SettingsPage } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

export const Route = createFileRoute("/_app/settings/assistant")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionAssistant"), i18n.t("common:settings")] }),
	component: AssistantSettingsPage
})

// The on-device assistant's settings, kept on this device. The stored values are read during boot.
function AssistantSettingsPage() {
	const { t } = useTranslation("settings")

	return (
		<SettingsPage
			icon={SparklesIcon}
			title={t("settingsSectionAssistant")}
		>
			<SettingsGroup title={t("settingsAssistantGroupConversations")}>
				<RetentionRow />
			</SettingsGroup>
		</SettingsPage>
	)
}
