import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { EventDescriber, EventListRow } from "@/features/settings/lib/eventModel"
import type { EventEntry } from "@/features/settings/lib/eventsPagination"
import {
	DAY_HEADER_HEIGHT,
	EVENT_ROW_HEIGHT,
	dayHeaderLayout,
	stickyDayHeaderAt
} from "@/features/settings/components/events/eventsList.logic"
import { EventRow } from "@/features/settings/components/events/eventRow"
import { EventDayHeader } from "@/features/settings/components/events/eventDayHeader"
import { SettingsPanel } from "@/features/settings/components/settingsLayout"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

const OVERSCAN = 10
// The log is newest first: older pages load once the reader nears the bottom.
const BOTTOM_THRESHOLD = 200

export type EventsNearEndReason = "scroll" | "fill"

export interface EventsTimelineProps {
	rows: EventListRow[]
	describer: EventDescriber
	newDevices: ReadonlySet<string>
	historyComplete: boolean
	now: number
	scrollElement: HTMLDivElement | null
	scrollRef: (element: HTMLDivElement | null) => void
	footer: ReactNode
	onOpen: (entry: EventEntry) => void
	// Within reach of the bottom: on a scroll, or ("fill") when the rows leave the panel unfilled.
	onNearEnd: (reason: EventsNearEndReason) => void
}

function nearEnd(element: HTMLElement): boolean {
	return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD
}

// Owns the virtualizer, which opts its host out of the React Compiler and re-renders it on every range
// change while scrolling; split out so EventsList compiles and those renders stay here. Memoized by hand.
// The pinned day header is one overlay at the top of the panel, its day and push read from the fixed row
// heights on scroll rather than from per-row sticky positioning, which absolute rows can't use.
export function EventsTimeline({
	rows,
	describer,
	newDevices,
	historyComplete,
	now,
	scrollElement,
	scrollRef,
	footer,
	onOpen,
	onNearEnd
}: EventsTimelineProps) {
	const { t } = useTranslation("settings")
	const overlayRef = useRef<HTMLDivElement>(null)
	const [pinnedIndex, setPinnedIndex] = useState(0)
	const layout = useMemo(() => dayHeaderLayout(rows), [rows])
	// The virtualizer re-lays every row when its key function changes, so it changes with the rows only.
	const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])
	const estimateSize = useCallback((index: number) => (rows[index]?.type === "day" ? DAY_HEADER_HEIGHT : EVENT_ROW_HEIGHT), [rows])

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize,
		overscan: OVERSCAN,
		getItemKey
	})

	const syncPinned = useCallback(
		(element: HTMLElement) => {
			const { index, push } = stickyDayHeaderAt(layout, element.scrollTop)

			if (overlayRef.current !== null) {
				overlayRef.current.style.transform = push === 0 ? "" : `translateY(${String(push)}px)`
			}

			setPinnedIndex(index)
		},
		[layout]
	)

	useLayoutEffect(() => {
		if (scrollElement !== null) {
			syncPinned(scrollElement)
		}
	}, [scrollElement, syncPinned])

	// Rows that leave the panel unfilled (a narrow filter, a short page) load the next page right away.
	useEffect(() => {
		if (scrollElement !== null && nearEnd(scrollElement)) {
			onNearEnd("fill")
		}
	}, [scrollElement, rows, onNearEnd])

	const pinnedRow = rows[layout.rows[pinnedIndex] ?? -1]

	return (
		// The panel is the scroll element and sizes to its rows until it reaches the page's height, so a
		// short log is a short panel rather than a tall empty one.
		<SettingsPanel
			ref={scrollRef}
			role="region"
			aria-label={t("settingsSectionEvents")}
			className="min-h-0 w-full scroll-pt-8 overflow-y-auto px-1.5 pb-1.5"
			onScroll={event => {
				syncPinned(event.currentTarget)

				if (nearEnd(event.currentTarget)) {
					onNearEnd("scroll")
				}
			}}
		>
			<div
				ref={overlayRef}
				aria-hidden="true"
				className="sticky top-0 z-10 -mb-8 h-8"
			>
				{pinnedRow?.type === "day" ? (
					<EventDayHeader
						row={pinnedRow}
						now={now}
						pinned
					/>
				) : null}
			</div>
			<div
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(virtualRow => {
					const row = rows[virtualRow.index]

					if (row === undefined) {
						return null
					}

					return (
						<div
							key={virtualRow.key}
							className="absolute top-0 left-0 w-full"
							style={{ height: virtualRow.size, transform: `translateY(${String(virtualRow.start)}px)` }}
						>
							{row.type === "day" ? (
								<EventDayHeader
									row={row}
									now={now}
									pinned={false}
								/>
							) : (
								<EventRow
									entry={row.entry}
									description={describer.describe(row.entry)}
									newDevice={newDevices.has(row.key)}
									historyComplete={historyComplete}
									now={now}
									onOpen={onOpen}
								/>
							)}
						</div>
					)
				})}
			</div>
			{footer}
		</SettingsPanel>
	)
}
