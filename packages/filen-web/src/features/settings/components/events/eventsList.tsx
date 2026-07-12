import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { HistoryIcon } from "lucide-react"
import type { UserEvent } from "@filen/sdk-rs"
import { useEventsQuery, loadOlderEvents } from "@/features/settings/queries/events"
import { shouldSkipEventsScroll } from "@/features/settings/lib/eventsPagination"
import { useIsOnline } from "@/lib/useIsOnline"
import { EventRow } from "@/features/settings/components/events/eventRow"
import { EventDetailDialog } from "@/features/settings/components/events/eventDetailDialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"

const ROW_HEIGHT = 52
const OVERSCAN = 10
// Load the next page once the user has scrolled within this many px of the bottom — the audit log
// renders newest-first, so "load more" means "approach the bottom", mirroring the notes/chats
// sidebars' own near-edge thresholds.
const BOTTOM_THRESHOLD = 200

// Sorted desc by timestamp (newest first, matching mobile's own Events screen) and Err (undecryptable)
// entries dropped — they carry no stable id to key/dedupe by, same rule loadOlderEvents/
// eventsPagination.ts applies to every later page.
function sortedOkEvents(data: ReturnType<typeof useEventsQuery>["data"]): UserEvent[] {
	if (!data) {
		return []
	}

	return data
		.filter(e => e.type === "ok")
		.slice()
		.sort((a, b) => (a.timestamp === b.timestamp ? 0 : a.timestamp > b.timestamp ? -1 : 1))
}

export function EventsList() {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const eventsQuery = useEventsQuery()
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [selectedEvent, setSelectedEvent] = useState<UserEvent | null>(null)
	const [hasMore, setHasMore] = useState(true)
	const [loadingMore, setLoadingMore] = useState(false)
	const inflightRef = useRef(false)

	const events = sortedOkEvents(eventsQuery.data)
	const firstPageErrCount =
		eventsQuery.status === "success" && events.length === 0 ? eventsQuery.data.filter(e => e.type === "err").length : 0

	const virtualizer = useVirtualizer({
		count: events.length,
		getScrollElement: () => scrollElement,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN,
		getItemKey: index => events[index]?.id ?? index
	})

	async function handleScroll(el: HTMLDivElement): Promise<void> {
		if (
			shouldSkipEventsScroll({
				inflight: inflightRef.current,
				hasMore,
				queryReady: eventsQuery.status === "success",
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
		try {
			const { terminate } = await loadOlderEvents(oldest.timestamp)

			if (terminate) {
				setHasMore(false)
			}
		} finally {
			inflightRef.current = false
			setLoadingMore(false)
		}
	}

	if (eventsQuery.status === "pending") {
		return (
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-2 p-6">
				<Skeleton className="h-13 w-full rounded-xl" />
				<Skeleton className="h-13 w-full rounded-xl" />
				<Skeleton className="h-13 w-full rounded-xl" />
			</div>
		)
	}

	if (eventsQuery.status === "error") {
		return (
			<div className="flex flex-1 flex-col p-6">
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HistoryIcon />
						</EmptyMedia>
						<EmptyTitle>{t("settingsEventsLoadError")}</EmptyTitle>
					</EmptyHeader>
					<Button
						variant="outline"
						onClick={() => {
							void eventsQuery.refetch()
						}}
					>
						{t("common:tryAgain")}
					</Button>
				</Empty>
			</div>
		)
	}

	if (events.length === 0) {
		return (
			<div className="flex flex-1 flex-col p-6">
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HistoryIcon />
						</EmptyMedia>
						<EmptyTitle>{t("settingsEventsEmptyTitle")}</EmptyTitle>
						<EmptyDescription>
							{firstPageErrCount > 0
								? t("settingsEventsUndecryptable", { count: firstPageErrCount })
								: t("settingsEventsEmptyDescription")}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</div>
		)
	}

	return (
		<>
			<div
				ref={setScrollElement}
				aria-label={t("settingsSectionEvents")}
				className="mx-auto flex w-full max-w-2xl flex-1 flex-col overflow-y-auto px-6"
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
					<div className="flex items-center justify-center py-4">
						<Spinner className="text-muted-foreground" />
					</div>
				)}
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
