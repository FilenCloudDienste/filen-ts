import { useRef } from "react"
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { HistoryIcon } from "lucide-react"
import { validateUuid } from "@filen/shared"
import { EventsList } from "@/features/settings/components/events/eventsList"
import { SettingsPageHeader } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// The open event's detail dialog is the `event` search param, so a reload or a shared link reopens it
// and Back closes it.
interface EventsSearch {
	event?: string
}

function validateSearch(search: Record<string, unknown>): EventsSearch {
	const raw = search["event"]

	return typeof raw === "string" && validateUuid(raw) ? { event: raw } : {}
}

// The audit log: paginated getUserEvents read through the event model (eventModel.ts). EventsList owns
// the whole body, its virtualized panel being its own scroll element; this route only supplies the header.
export const Route = createFileRoute("/_app/settings/events")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionEvents"), i18n.t("common:settings")] }),
	validateSearch,
	component: EventsPage
})

function EventsPage() {
	const { t } = useTranslation("settings")
	const { event } = Route.useSearch()
	const navigate = useNavigate()
	const router = useRouter()
	// The event this page pushed a history entry for: closing it goes back over that entry, while a
	// dialog the URL opened by itself (a reload, a shared link) drops the param in place.
	const pushedRef = useRef<string | null>(null)

	return (
		<>
			<SettingsPageHeader
				icon={HistoryIcon}
				title={t("settingsSectionEvents")}
			/>
			<EventsList
				eventUuid={event ?? null}
				onOpenEvent={uuid => {
					pushedRef.current = uuid
					void navigate({ to: "/settings/events", search: { event: uuid }, resetScroll: false })
				}}
				onCloseEvent={() => {
					if (event !== undefined && pushedRef.current === event) {
						pushedRef.current = null
						router.history.back()

						return
					}

					void navigate({ to: "/settings/events", search: {}, replace: true, resetScroll: false })
				}}
			/>
		</>
	)
}
