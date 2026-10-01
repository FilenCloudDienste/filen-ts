import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { HistoryIcon } from "lucide-react"
import { toast } from "sonner"
import type { UserEvent } from "@filen/sdk-rs"
import { useEventsQuery, loadOlderEvents, releaseEventsSlice } from "@/features/settings/queries/events"
import { shouldSkipEventsScroll, fetchEventsPageSafely, type OkEventResult } from "@/features/settings/lib/eventsPagination"
import { useIsOnline } from "@/lib/useIsOnline"
import { blockingQueryError } from "@/queries/blockingError"
import { log } from "@/lib/log"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { EventRow } from "@/features/settings/components/events/eventRow"
import { EventDetailDialog } from "@/features/settings/components/events/eventDetailDialog"
import { EmptyMessage } from "@/components/emptyMessage"
import { LoadingState } from "@/components/loadingState"
import { Button } from "@/components/ui/button"
import { SettingsPanel } from "@/features/settings/components/settingsLayout"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

const ROW_HEIGHT = 52
const OVERSCAN = 10
// Load the next page once the user has scrolled within this many px of the bottom — the audit log
// renders newest-first, so "load more" means "approach the bottom", mirroring the notes/chats
// sidebars' own near-edge thresholds.
const BOTTOM_THRESHOLD = 200
// One identity for the not-yet-loaded case, so a pending render can't churn the virtualizer's inputs.
const EMPTY_EVENTS: OkEventResult[] = []

export function EventsList() {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const eventsQuery = useEventsQuery()
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [selectedEvent, setSelectedEvent] = useState<UserEvent | null>(null)
	const [hasMore, setHasMore] = useState(true)
	const [loadingMore, setLoadingMore] = useState(false)
	const inflightRef = useRef(false)

	const events = eventsQuery.data?.ok ?? EMPTY_EVENTS
	const firstPageErrCount = eventsQuery.data !== undefined && events.length === 0 ? eventsQuery.data.errCount : 0

	useEffect(() => releaseEventsSlice, [])

	// Memoized by hand (useVirtualizer opts this component out of the React Compiler): the virtualizer
	// re-lays every row when its key function changes, so it must change with the events and nothing else.
	const getItemKey = useCallback((index: number) => events[index]?.id ?? index, [events])

	const virtualizer = useVirtualizer({
		count: events.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN,
		getItemKey
	})

	async function handleScroll(el: HTMLDivElement): Promise<void> {
		if (
			shouldSkipEventsScroll({
				inflight: inflightRef.current,
				hasMore,
				queryReady: eventsQuery.data !== undefined,
				isOnline
			})
		) {
			return
		}

		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight

		if (distanceFromBottom > BOTTOM_THRESHOLD) {
			return
		}

		const oldest = events.at(-1)

		if (!oldest) {
			return
		}

		inflightRef.current = true
		setLoadingMore(true)
		const result = await fetchEventsPageSafely(() => loadOlderEvents(oldest.timestamp))
		inflightRef.current = false
		setLoadingMore(false)

		if (result.status === "error") {
			// hasMore is deliberately left untouched — a transient fetch failure should not
			// permanently mark the log "fully loaded"; the very next near-bottom scroll retries.
			log.error("settings-events", "pagination fetch failed", oldest.timestamp.toString(), result.dto)
			toast.error(errorLabel(result.dto))
			return
		}

		if (result.terminate) {
			setHasMore(false)
		}
	}

	if (eventsQuery.status === "pending") {
		return <LoadingState size="md" />
	}

	// Never over loaded rows: replacing the list would drop the reader's place in it.
	if (blockingQueryError(eventsQuery) !== null) {
		return (
			<div className="flex flex-1 flex-col p-6">
				<EmptyMessage
					icon={HistoryIcon}
					title={t("settingsEventsLoadError")}
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
			</div>
		)
	}

	if (events.length === 0) {
		return (
			<div className="flex flex-1 flex-col p-6">
				<EmptyMessage
					icon={HistoryIcon}
					title={t("settingsEventsEmptyTitle")}
					description={
						firstPageErrCount > 0
							? t("settingsEventsUndecryptable", { count: firstPageErrCount })
							: t("settingsEventsEmptyDescription")
					}
				/>
			</div>
		)
	}

	return (
		<>
			{/* The panel is the scroll element and sizes to its rows until it reaches the page's height,
			    so a short log is a short panel rather than a tall empty one. */}
			<div className="flex min-h-0 flex-1 flex-col px-4 pt-2 pb-6 sm:px-6">
				<SettingsPanel
					ref={setScrollElement}
					aria-label={t("settingsSectionEvents")}
					className="mx-auto min-h-0 w-full max-w-3xl overflow-y-auto p-1.5"
					onScroll={e => {
						void handleScroll(e.currentTarget)
					}}
				>
					<div
						className="relative w-full"
						style={{ height: virtualizer.getTotalSize() }}
					>
						{virtualizer.getVirtualItems().map(virtualRow => {
							const event = events[virtualRow.index]

							if (!event) {
								return null
							}

							return (
								<div
									key={virtualRow.key}
									className="absolute top-0 left-0 w-full"
									style={{ height: ROW_HEIGHT, transform: `translateY(${String(virtualRow.start)}px)` }}
								>
									<EventRow
										event={event}
										onOpen={setSelectedEvent}
									/>
								</div>
							)
						})}
					</div>
					{loadingMore && (
						<LoadingState
							size="sm"
							className="h-12 flex-none"
						/>
					)}
				</SettingsPanel>
			</div>
			<EventDetailDialog
				event={selectedEvent}
				onOpenChange={open => {
					if (!open) {
						setSelectedEvent(null)
					}
				}}
			/>
		</>
	)
}
