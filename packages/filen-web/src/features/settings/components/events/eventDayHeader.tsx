import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { eventDayLabel, type EventListRow } from "@/features/settings/lib/eventModel"

export const DAY_HEADER_CLASS = "flex h-8 items-end px-2.5 pb-1 text-xs font-medium text-muted-foreground"

// A timeline day header: "Today", "Yesterday", or the weekday and date. The pinned copy over the list is
// decorative, the in-list one carries the heading.
export function EventDayHeader({ row, now, pinned }: { row: Extract<EventListRow, { type: "day" }>; now: number; pinned: boolean }) {
	const { t } = useTranslation("events")
	const label = eventDayLabel(row, t, now)

	if (pinned) {
		return <span className={cn(DAY_HEADER_CLASS, "bg-card")}>{label}</span>
	}

	return <h2 className={DAY_HEADER_CLASS}>{label}</h2>
}
