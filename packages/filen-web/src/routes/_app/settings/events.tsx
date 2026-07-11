import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { HistoryIcon } from "lucide-react"
import { EventsList } from "@/features/settings/components/events/eventsList"

// The audit log: paginated getUserEvents + the 39-case UserEventKind → localized-string switch (mind
// the twoFaEnabled/twoFaDisabled rename — see eventKind.ts). EventsList owns the whole scrollable
// virtualized body; this route only supplies the section header, same split as every other settings
// route.
export const Route = createFileRoute("/_app/settings/events")({ component: EventsPage })

function EventsPage() {
	const { t } = useTranslation("settings")

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 px-4">
				<div className="flex items-center gap-2">
					<HistoryIcon className="size-4 text-muted-foreground" />
					<h1 className="font-heading text-base font-medium tracking-tight">{t("settingsSectionEvents")}</h1>
				</div>
			</header>
			<EventsList />
		</>
	)
}
