import { useTranslation } from "react-i18next"
import { TriangleAlertIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { formatRelativeTime } from "@/lib/relativeTime"
import { EVENT_ICONS, EVENT_TONE_CLASS } from "@/features/settings/lib/eventIcons"
import type { EventDescription } from "@/features/settings/lib/eventModel"
import type { EventEntry } from "@/features/settings/lib/eventsPagination"
import { entryTimeKnown, eventSecondaryText, eventTitleSegments } from "@/features/settings/components/events/eventsList.logic"
import { FileTypeIcon } from "@/features/drive/components/itemIcon"
import { Badge } from "@/components/ui/badge"

export interface EventRowProps {
	entry: EventEntry
	description: EventDescription
	newDevice: boolean
	// Every event of the 30-day window is loaded: the new-device badge's claim reaches that far.
	historyComplete: boolean
	// The shared minute tick, read once by the list rather than by every row.
	now: number
	onOpen: (entry: EventEntry) => void
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" })

// One virtualized row: the event's sentence over its second line (location · size · device) and the
// time of day, the day itself being the header above. The whole row opens the detail dialog.
export function EventRow({ entry, description, newDevice, historyComplete, now, onOpen }: EventRowProps) {
	const { t } = useTranslation("events")
	const { t: tCommon } = useTranslation("common")
	const Icon = EVENT_ICONS[description.icon]
	const timestamp = Number(entry.timestamp)
	const date = new Date(timestamp)

	return (
		<button
			type="button"
			onClick={() => {
				onOpen(entry)
			}}
			className="flex h-full w-full items-center gap-3 rounded-xl px-2.5 text-left transition-colors outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
		>
			<span
				className={cn(
					"flex size-9 shrink-0 items-center justify-center rounded-full [&_svg]:size-4",
					EVENT_TONE_CLASS[description.tone]
				)}
			>
				{description.fileIcon !== undefined ? (
					<FileTypeIcon
						iconKey={description.fileIcon}
						className="size-5"
					/>
				) : (
					<Icon aria-hidden="true" />
				)}
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-2">
					<span
						title={description.misleading === true ? `${description.title}\n${t("eventsMisleadingName")}` : description.title}
						className="truncate text-sm"
					>
						{eventTitleSegments(description, t).map((segment, i) =>
							segment.strong ? (
								<strong
									key={i}
									className="font-medium"
								>
									<bdi>{segment.text}</bdi>
								</strong>
							) : (
								segment.text
							)
						)}
					</span>
					{description.misleading === true ? (
						<TriangleAlertIcon
							aria-label={t("eventsMisleadingName")}
							className="size-3.5 shrink-0 text-amber-500"
						/>
					) : null}
					{newDevice ? (
						<Badge
							variant="secondary"
							title={t(historyComplete ? "eventsNewDeviceHintWindow" : "eventsNewDeviceHintWeek")}
						>
							{t("eventsNewDevice")}
						</Badge>
					) : null}
				</span>
				<span className="truncate text-xs text-muted-foreground">{eventSecondaryText(description)}</span>
			</span>
			{entryTimeKnown(entry) ? (
				<time
					dateTime={date.toISOString()}
					title={formatRelativeTime(timestamp, tCommon, now)}
					className="shrink-0 text-xs text-muted-foreground tabular-nums"
				>
					{TIME_FORMAT.format(date)}
				</time>
			) : (
				<span className="shrink-0 text-xs text-muted-foreground">{t("eventsUnknownTime")}</span>
			)}
		</button>
	)
}
