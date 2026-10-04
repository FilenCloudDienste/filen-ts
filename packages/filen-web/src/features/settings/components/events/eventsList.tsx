import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { HistoryIcon, SearchXIcon } from "lucide-react"
import { toast } from "sonner"
import { useEventsQuery, loadOlderEvents, releaseEventsSlice, eventsQueryGet } from "@/features/settings/queries/events"
import {
	shouldSkipEventsScroll,
	fetchEventsPageSafely,
	oldestEventTimestamp,
	type EventEntry
} from "@/features/settings/lib/eventsPagination"
import {
	createEventDescriber,
	groupEventsByDay,
	type EventDescriber,
	type EventListRow,
	type EventModelContext
} from "@/features/settings/lib/eventModel"
import { useEventModelContext } from "@/features/settings/hooks/useEventModelContext"
import {
	EMPTY_EVENTS_FILTER,
	eventEntryUuid,
	filterEvents,
	findEventEntry,
	isEventsFilterActive,
	isFillCapped,
	newDeviceBadgeKeys,
	startOfToday,
	type EventsFilter
} from "@/features/settings/components/events/eventsList.logic"
import { EventsTimeline, type EventsNearEndReason } from "@/features/settings/components/events/eventsTimeline"
import { EventsSummaryCard } from "@/features/settings/components/events/eventsSummaryCard"
import { EventsFilters } from "@/features/settings/components/events/eventsFilters"
import { EventDetailDialog } from "@/features/settings/components/events/eventDetailDialog"
import { useIsOnline } from "@/lib/useIsOnline"
import { useNowMinute } from "@/lib/useNowMinute"
import { blockingQueryError } from "@/queries/blockingError"
import { log } from "@/lib/log"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { EmptyMessage } from "@/components/emptyMessage"
import { LoadingState } from "@/components/loadingState"
import { Button } from "@/components/ui/button"

// One identity for the not-yet-loaded case, so a pending render can't churn the derivations below.
const EMPTY_EVENTS: EventEntry[] = []

// Memoized hooks rather than inline derivations: the compiler merges an inline value's memo scope into
// each consumer's, which would rebuild the describer (and every description) on a keystroke and the rows
// on every minute tick.
function useEventDescriber(ctx: EventModelContext): EventDescriber {
	return useMemo(() => createEventDescriber(ctx), [ctx])
}

function useTimelineRows(entries: EventEntry[], filter: EventsFilter, describer: EventDescriber, today: number): EventListRow[] {
	return useMemo(() => groupEventsByDay(filterEvents(entries, filter, describer.searchText), today), [entries, filter, describer, today])
}

export interface EventsListProps {
	// The `event` search param: the event whose detail dialog is open.
	eventUuid: string | null
	onOpenEvent: (uuid: string) => void
	onCloseEvent: () => void
}

export function EventsList({ eventUuid, onOpenEvent, onCloseEvent }: EventsListProps) {
	const { t } = useTranslation(["events", "common"])
	const isOnline = useIsOnline()
	const now = useNowMinute()
	const eventsQuery = useEventsQuery()
	const ctx = useEventModelContext()
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [filter, setFilter] = useState<EventsFilter>(EMPTY_EVENTS_FILTER)
	// The slice's oldest event when a page reported the end. A trim or a replacing first page moves the
	// oldest event, and paging resumes from there.
	const [ended, setEnded] = useState<{ oldest: bigint | undefined } | null>(null)
	// The cursor a page read failed at: filling the panel stops there until the reader scrolls again.
	const [failedAt, setFailedAt] = useState<bigint | null>(null)
	const [loadingMore, setLoadingMore] = useState(false)
	// Pages read to fill the panel since the search or category last changed.
	const [fillPages, setFillPages] = useState(0)
	// An event that names no uuid can't be linked to, so its dialog opens from here, keyed by its list key.
	const [unlinkedEntry, setUnlinkedEntry] = useState<EventEntry | null>(null)
	const inflightRef = useRef(false)

	const entries = eventsQuery.data?.entries ?? EMPTY_EVENTS
	const oldest = eventsQuery.data?.oldest
	const hasMore = ended === null || ended.oldest !== oldest
	const describer = useEventDescriber(ctx)
	const filterActive = isEventsFilterActive(filter)
	const rows = useTimelineRows(entries, filter, describer, startOfToday(now))
	const newDevices = newDeviceBadgeKeys(entries, !hasMore)
	const fillCapped = isFillCapped({ filterActive, hasMore, fillPages })
	const linkedEntry = findEventEntry(entries, eventUuid)

	useEffect(() => releaseEventsSlice, [])

	async function loadOlder(reason: EventsNearEndReason): Promise<void> {
		if (
			shouldSkipEventsScroll({ inflight: inflightRef.current, hasMore, queryReady: eventsQuery.data !== undefined, isOnline }) ||
			oldest === undefined ||
			(reason === "fill" && (failedAt === oldest || fillCapped))
		) {
			return
		}

		if (reason === "fill" && filterActive) {
			setFillPages(count => count + 1)
		}

		inflightRef.current = true
		setLoadingMore(true)
		const result = await fetchEventsPageSafely(() => loadOlderEvents(oldest))
		inflightRef.current = false
		setLoadingMore(false)

		if (result.status === "error") {
			// Not the end: the next scroll retries.
			log.error("settings-events", "pagination fetch failed", oldest.toString(), result.dto)
			toast.error(errorLabel(result.dto))
			setFailedAt(oldest)

			return
		}

		setFailedAt(null)

		if (result.terminate) {
			setEnded({ oldest: oldestEventTimestamp(eventsQueryGet() ?? []) })
		}
	}

	function openEntry(entry: EventEntry): void {
		const uuid = eventEntryUuid(entry)

		if (uuid === undefined) {
			setUnlinkedEntry(entry)
		} else {
			onOpenEvent(uuid)
		}
	}

	// A changed search or category shows a different set, read from its top.
	function updateFilter(next: EventsFilter): void {
		setFilter(next)
		setFillPages(0)
		scrollElement?.scrollTo({ top: 0 })
	}

	// The reader asked: this page, then the panel fills again as far as it did before.
	function searchOlder(): void {
		setFillPages(0)
		void loadOlder("scroll")
	}

	const searchOlderButton = (
		<Button
			variant="outline"
			onClick={searchOlder}
		>
			{t("eventsSearchOlder")}
		</Button>
	)

	const dialog = (
		<EventDetailDialog
			eventUuid={unlinkedEntry === null ? eventUuid : unlinkedEntry.key}
			entry={unlinkedEntry ?? linkedEntry}
			waitForList={eventsQuery.status === "pending"}
			onClose={() => {
				if (unlinkedEntry !== null) {
					setUnlinkedEntry(null)
				} else {
					onCloseEvent()
				}
			}}
		/>
	)

	if (eventsQuery.status === "pending") {
		return (
			<>
				<LoadingState size="md" />
				{dialog}
			</>
		)
	}

	// Never over loaded rows: replacing the list would drop the reader's place in it.
	if (blockingQueryError(eventsQuery) !== null) {
		return (
			<div className="flex flex-1 flex-col p-6">
				<EmptyMessage
					icon={HistoryIcon}
					title={t("eventsLoadError")}
				>
					<Button
						variant="outline"
						onClick={() => {
							void eventsQuery.refetch()
						}}
					>
						{t("common:tryAgain")}
					</Button>
				</EmptyMessage>
				{dialog}
			</div>
		)
	}

	if (entries.length === 0) {
		return (
			<div className="flex flex-1 flex-col p-6">
				<EmptyMessage
					icon={HistoryIcon}
					title={t("eventsEmptyTitle")}
					description={t("eventsEmptyDescription")}
				/>
				{dialog}
			</div>
		)
	}

	// Filtered down to nothing with no older page left to search, none reachable right now, or none read
	// without asking.
	const noResults = filterActive && rows.length === 0 && (!hasMore || !isOnline || failedAt === oldest || fillCapped)

	return (
		<div className="flex min-h-0 flex-1 flex-col px-4 pt-2 pb-6 sm:px-6">
			<div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4">
				<EventsSummaryCard
					entries={entries}
					oldest={oldest}
					complete={!hasMore}
					describer={describer}
					now={now}
				/>
				<EventsFilters
					filter={filter}
					onChange={updateFilter}
				/>
				{noResults ? (
					<EmptyMessage
						icon={SearchXIcon}
						title={t("eventsNoResultsTitle")}
						description={t(hasMore ? "eventsNoResultsLoadedDescription" : "eventsNoResultsDescription")}
					>
						<div className="flex flex-wrap justify-center gap-2">
							{fillCapped && isOnline ? searchOlderButton : null}
							<Button
								variant="outline"
								onClick={() => {
									updateFilter(EMPTY_EVENTS_FILTER)
								}}
							>
								{t("eventsClearFilters")}
							</Button>
						</div>
					</EmptyMessage>
				) : (
					<EventsTimeline
						rows={rows}
						describer={describer}
						newDevices={newDevices}
						historyComplete={!hasMore}
						now={now}
						scrollElement={scrollElement}
						scrollRef={setScrollElement}
						onOpen={openEntry}
						onNearEnd={reason => {
							void loadOlder(reason)
						}}
						footer={
							loadingMore ? (
								<LoadingState
									size="sm"
									className="h-12 flex-none"
								/>
							) : fillCapped && isOnline ? (
								<div className="flex justify-center px-2.5 py-3">{searchOlderButton}</div>
							) : hasMore ? null : (
								<p className="px-2.5 py-3 text-center text-xs text-muted-foreground">{t("eventsEndOfHistory")}</p>
							)
						}
					/>
				)}
			</div>
			{dialog}
		</div>
	)
}
