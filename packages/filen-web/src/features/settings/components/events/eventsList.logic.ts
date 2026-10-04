import type { TFunction } from "i18next"
import {
	NAME_VALUE_KEYS,
	detectNewDevices,
	entryCategory,
	type EventCategory,
	type EventDescription,
	type EventListRow
} from "@/features/settings/lib/eventModel"
import type { EventEntry } from "@/features/settings/lib/eventsPagination"
import { middleEllipsis } from "@/lib/middleEllipsis"

export const EVENT_ROW_HEIGHT = 60
export const DAY_HEADER_HEIGHT = 32

export type EventsCategoryFilter = "all" | EventCategory

export interface EventsFilter {
	category: EventsCategoryFilter
	query: string
}

export const EMPTY_EVENTS_FILTER: EventsFilter = { category: "all", query: "" }

// Older pages a search or category reads by itself, filling the panel, before it asks to go on: a rare
// match on a heavy account would otherwise read the whole 30-day window.
export const FILTER_FILL_PAGES = 5

// Filling the panel waits for the reader: a search or category has read its pages and history goes on.
export function isFillCapped(state: { filterActive: boolean; hasMore: boolean; fillPages: number }): boolean {
	return state.filterActive && state.hasMore && state.fillPages >= FILTER_FILL_PAGES
}

export function isEventsFilterActive(filter: EventsFilter): boolean {
	return filter.category !== "all" || filter.query.trim().length > 0
}

// Every whitespace-separated term must occur in the event's search text. An event the build can't
// categorize only shows under "all".
export function filterEvents(entries: EventEntry[], filter: EventsFilter, searchText: (entry: EventEntry) => string): EventEntry[] {
	const terms = filter.query
		.toLowerCase()
		.split(/\s+/)
		.filter(term => term.length > 0)

	if (filter.category === "all" && terms.length === 0) {
		return entries
	}

	return entries.filter(entry => {
		if (filter.category !== "all" && entryCategory(entry) !== filter.category) {
			return false
		}

		if (terms.length === 0) {
			return true
		}

		const text = searchText(entry)

		return terms.every(term => text.includes(term))
	})
}

function startOfDay(ms: number): number {
	return new Date(ms).setHours(0, 0, 0, 0)
}

export function startOfToday(now: number): number {
	return startOfDay(now)
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Sign-ins from a browser and OS no earlier loaded event used, where that says something: the loaded
// history before the sign-in covers a week, or the whole 30-day window is loaded. The oldest loaded day is
// left out either way: every device there is the first of the window, not a new one.
export function newDeviceBadgeKeys(entries: readonly EventEntry[], complete: boolean): Set<string> {
	const badges = new Set<string>()
	const oldest = entries.at(-1)

	if (oldest === undefined) {
		return badges
	}

	const oldestDay = new Date(startOfDay(Number(oldest.timestamp)))
	// The next local midnight, whatever a DST shift makes of the day's length.
	const oldestDayEnd = oldestDay.setDate(oldestDay.getDate() + 1)
	const coveredFrom = complete ? oldestDayEnd : Math.max(oldestDayEnd, Number(oldest.timestamp) + WEEK_MS)
	const firsts = detectNewDevices(entries)

	for (const entry of entries) {
		if (Number(entry.timestamp) < coveredFrom) {
			break
		}

		if (
			entry.type === "ok" &&
			(entry.event.kind.type === "login" || entry.event.kind.type === "failedLogin") &&
			firsts.has(entry.key)
		) {
			badges.add(entry.key)
		}
	}

	return badges
}

export interface DayHeaderLayout {
	// Row index and content offset of each day header, in order.
	rows: number[]
	starts: number[]
}

// Fixed row heights, so offsets are a running sum.
export function dayHeaderLayout(rows: readonly EventListRow[]): DayHeaderLayout {
	const layout: DayHeaderLayout = { rows: [], starts: [] }
	let offset = 0

	for (let i = 0; i < rows.length; i++) {
		if (rows[i]?.type === "day") {
			layout.rows.push(i)
			layout.starts.push(offset)
			offset += DAY_HEADER_HEIGHT
		} else {
			offset += EVENT_ROW_HEIGHT
		}
	}

	return layout
}

// The day header pinned at a scroll offset, and how far the next one pushes it up.
export function stickyDayHeaderAt(layout: DayHeaderLayout, scrollTop: number): { index: number; push: number } {
	const { starts } = layout
	let low = 0
	let high = starts.length - 1
	let index = 0

	while (low <= high) {
		const mid = (low + high) >> 1

		if ((starts[mid] ?? 0) <= scrollTop) {
			index = mid
			low = mid + 1
		} else {
			high = mid - 1
		}
	}

	const next = starts[index + 1]

	return { index, push: next === undefined ? 0 : Math.min(0, next - scrollTop - DAY_HEADER_HEIGHT) }
}

export interface TitleSegment {
	text: string
	strong: boolean
}

const MARK = ""

// The sentence with each readable item name set apart, shortened from the middle unless `full`. Names are
// interpolated as markers and split on afterwards, so a name that also occurs in the sentence's own words
// is never mistaken for it.
export function eventTitleSegments(description: EventDescription, t: TFunction<"events">, full = false): TitleSegment[] {
	const fallbacks = new Set<string>([t("eventsFallbackFile"), t("eventsFallbackDirectory"), t("eventsFallbackItem")])
	const values: Record<string, string | number> = { ...description.values }
	const names: string[] = []

	for (const key of NAME_VALUE_KEYS) {
		const value = description.values[key]

		if (value !== undefined && !fallbacks.has(value)) {
			values[key] = `${MARK}${String(names.length)}${MARK}`
			names.push(value)
		}
	}

	if (names.length === 0) {
		return [{ text: description.title, strong: false }]
	}

	return t(description.titleKey, values)
		.split(MARK)
		.flatMap((part, i): TitleSegment[] => {
			if (i % 2 === 0) {
				return part.length > 0 ? [{ text: part, strong: false }] : []
			}

			const name = names[Number(part)]

			if (name === undefined) {
				return []
			}

			return [{ text: full ? name : middleEllipsis(name, { start: 28, end: 14 }), strong: true }]
		})
}

// The row's muted line.
export function eventSecondaryText(description: EventDescription): string {
	return description.secondary.join(" · ")
}

// An undecodable event without a timestamp sorts by its neighbour's, which is no time to show for it.
export function entryTimeKnown(entry: EventEntry): boolean {
	return entry.type === "ok" || entry.raw.timestamp !== undefined
}

// The event uuid a deep link names: decoded events always carry one, undecodable ones when their JSON does.
export function eventEntryUuid(entry: EventEntry): string | undefined {
	return entry.type === "ok" ? entry.event.uuid : entry.raw.uuid
}

export function findEventEntry(entries: readonly EventEntry[], uuid: string | null): EventEntry | null {
	if (uuid === null) {
		return null
	}

	return entries.find(entry => eventEntryUuid(entry) === uuid) ?? null
}
