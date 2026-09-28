import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { HistoryIcon } from "lucide-react"
import { EventsList } from "@/features/settings/components/events/eventsList"
import { SettingsPageHeader } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// The audit log: paginated getUserEvents + the 39-case UserEventKind → localized-string switch (mind
// the twoFaEnabled/twoFaDisabled rename — see eventKind.ts). EventsList owns the whole body, its
// virtualized panel being its own scroll element; this route only supplies the section header.
export const Route = createFileRoute("/_app/settings/events")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionEvents"), i18n.t("common:settings")] }),
	component: EventsPage
})

function EventsPage() {
	const { t } = useTranslation("settings")

	return (
		<>
			<SettingsPageHeader
				icon={HistoryIcon}
				title={t("settingsSectionEvents")}
			/>
			<EventsList />
		</>
	)
}
