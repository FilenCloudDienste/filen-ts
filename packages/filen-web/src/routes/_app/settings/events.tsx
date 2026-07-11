import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { HistoryIcon } from "lucide-react"
import { SettingsPlaceholder } from "@/features/settings/components/settingsPlaceholder"

// Audit-log placeholder — the real Events section (paginated getUserEvents + the ~40-case
// UserEventKind → localized-string switch, mind the twoFaEnabled/twoFaDisabled rename) ships in a
// later wave. The worker seam (getUserEvents/getUserEvent) is already wired.
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
			<div className="flex flex-1 flex-col overflow-y-auto p-6">
				<SettingsPlaceholder
					icon={HistoryIcon}
					title={t("settingsSectionEvents")}
				/>
			</div>
		</>
	)
}
