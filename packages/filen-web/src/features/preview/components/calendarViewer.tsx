import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import type { CalendarEntry, CalendarFile, CalendarRecurrence, CalendarTime } from "@filen/shared/calendarFile"
import { codeMirrorLanguageFor, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { RenderedSourceViewer, type RenderedSource } from "@/features/preview/components/renderedSourceViewer"
import type { TextViewerProps } from "@/features/preview/components/textViewer"
import { MetadataCard } from "@/features/preview/components/metadataCard"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"
import type { MetadataField } from "@/features/preview/lib/metadataCard.types"
import {
	agendaDays,
	agendaTime,
	wallMs,
	dayMs,
	shownEnd,
	zoneTable,
	type ZoneTable,
	type AgendaDay,
	type AgendaItem,
	type AgendaTime
} from "@/features/preview/lib/calendarAgenda.logic"
import { readCalendarFile } from "@/features/preview/lib/textFamilyClient"
import { useTextFamilyReading } from "@/features/preview/hooks/useTextFamilyReading"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// Wall times are formatted from epoch ms read as UTC, so they show exactly as written.
const WALL_DAY = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" })
const WALL_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" })
const WALL_TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short", timeZone: "UTC" })
const WALL_DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
const LOCAL_TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" })
const LOCAL_DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" })
const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" })
const LIST = new Intl.ListFormat(undefined, { style: "long", type: "conjunction" })

// 2024-01-01 was a Monday.
const WEEKDAY_INDEX: Readonly<Record<string, number>> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 }

function weekdayName(code: string): string {
	return WEEKDAY.format(Date.UTC(2024, 0, 1 + (WEEKDAY_INDEX[code] ?? 0)))
}

function nthWeekday(t: TFunction<"preview">, rule: string): string {
	const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(rule)
	const day = weekdayName(match?.[2] ?? "MO")
	const n = match?.[1] === undefined ? null : Number(match[1])

	switch (n) {
		case null:
			return day
		case 1:
			return t("previewCalendarNth1", { day })
		case 2:
			return t("previewCalendarNth2", { day })
		case 3:
			return t("previewCalendarNth3", { day })
		case 4:
			return t("previewCalendarNth4", { day })
		case -1:
			return t("previewCalendarNthLast", { day })
		default:
			return t("previewCalendarNthOther", { day, n })
	}
}

function every(t: TFunction<"preview">, rule: CalendarRecurrence): string {
	const count = rule.interval

	switch (rule.frequency) {
		case "secondly":
			return t("previewCalendarEverySecond", { count })
		case "minutely":
			return t("previewCalendarEveryMinute", { count })
		case "hourly":
			return t("previewCalendarEveryHour", { count })
		case "daily":
			return t("previewCalendarEveryDay", { count })
		case "weekly":
			return t("previewCalendarEveryWeek", { count })
		case "monthly":
			return t("previewCalendarEveryMonth", { count })
		case "yearly":
			return t("previewCalendarEveryYear", { count })
	}
}

// "Every 2 weeks on Monday and Wednesday, 10 times".
function recurrenceWords(t: TFunction<"preview">, rule: CalendarRecurrence): string {
	const parts = [every(t, rule)]

	if (rule.byDay.length > 0) parts.push(t("previewCalendarOnDays", { days: LIST.format(rule.byDay.map(day => nthWeekday(t, day))) }))

	if (rule.byMonthDay.length > 0) parts.push(t("previewCalendarOnMonthDays", { days: LIST.format(rule.byMonthDay.map(String)) }))

	if (rule.byMonth.length > 0) {
		parts.push(
			t("previewCalendarInMonths", { months: LIST.format(rule.byMonth.map(month => MONTH.format(Date.UTC(2024, month - 1, 1)))) })
		)
	}

	const repeat = parts.join(" ")

	if (rule.count !== null) return `${repeat}, ${t("previewCalendarTimes", { count: rule.count })}`

	if (rule.until !== null) return `${repeat}, ${t("previewCalendarUntil", { date: WALL_DATE.format(wallMs(rule.until)) })}`

	return repeat
}

function timeText(t: TFunction<"preview">, time: CalendarTime, zones: ZoneTable): string {
	const shown = agendaTime(time, zones)

	if (shown.shownMs === null) {
		return WALL_DATE.format(wallMs(time))
	}

	const written = WALL_DATE_TIME.format(shown.shownMs)

	if (shown.unconverted && shown.zone !== null) {
		return t("previewCalendarZoneUnconverted", { time: written, zone: shown.zone })
	}

	const zoned = shown.zone === null ? written : t("previewCalendarZone", { time: written, zone: shown.zone })

	return shown.yourMs === null ? zoned : `${zoned} · ${t("previewCalendarYourTime", { time: LOCAL_DATE_TIME.format(shown.yourMs) })}`
}

function duration(seconds: number): string {
	const hours = Math.floor(seconds / 3600)
	const minutes = Math.floor((seconds % 3600) / 60)

	return `${String(hours)}:${String(minutes).padStart(2, "0")}`
}

function detailFields(t: TFunction<"preview">, entry: CalendarEntry, zones: ZoneTable): MetadataField[] {
	const fields: MetadataField[] = []
	const add = (label: string, value: string | null): void => {
		if (value !== null && value !== "") fields.push({ label, value })
	}

	add(t("previewCalendarStarts"), entry.start === null ? null : timeText(t, entry.start, zones))
	if (entry.kind === "todo") {
		add(t("previewCalendarDue"), entry.end === null ? null : timeText(t, entry.end, zones))
	} else {
		const end = entry.end === null ? null : shownEnd(entry.start, entry.end)

		add(t("previewCalendarEnds"), end === null ? null : timeText(t, end, zones))
	}
	add(t("previewCalendarDuration"), entry.durationSeconds === null ? null : duration(entry.durationSeconds))

	if (entry.recurrence !== null) {
		const extras = [
			entry.exceptions > 0 ? t("previewCalendarExceptions", { count: entry.exceptions }) : null,
			entry.extraDates > 0 ? t("previewCalendarExtraDates", { count: entry.extraDates }) : null
		].filter(extra => extra !== null)

		add(t("previewCalendarRepeats"), [recurrenceWords(t, entry.recurrence), ...extras].join(" · "))
	}

	add(t("previewCalendarLocation"), entry.location)
	add(t("previewCalendarOrganizer"), entry.organizer)
	add(t("previewCalendarAttendees"), entry.attendees.length === 0 ? null : entry.attendees.join(", "))
	add(t("previewCalendarStatus"), entry.status)

	if (entry.url !== null) fields.push({ label: t("previewCalendarLink"), value: entry.url, mono: true, copy: entry.url })

	add(t("previewCalendarDescription"), entry.description)

	return fields
}

function TimeColumn({ time }: { time: AgendaTime | null }) {
	const { t } = useTranslation("preview")

	if (time === null) {
		return <span />
	}

	if (time.shownMs === null) {
		return <span className="text-muted-foreground">{t("previewCalendarAllDay")}</span>
	}

	return (
		<span className="flex flex-col">
			<span className="tabular-nums">{WALL_TIME.format(time.shownMs)}</span>
			{time.zone === null ? null : (
				<span className="truncate text-xs text-muted-foreground">
					{time.unconverted ? t("previewCalendarZoneUnconvertedShort", { zone: time.zone }) : time.zone}
				</span>
			)}
			{time.yourMs === null ? null : (
				<span className="text-xs text-muted-foreground">
					{t("previewCalendarYourTime", { time: LOCAL_TIME.format(time.yourMs) })}
				</span>
			)}
		</span>
	)
}

function AgendaRow({ item, zones, open, onToggle }: { item: AgendaItem; zones: ZoneTable; open: boolean; onToggle: () => void }) {
	const { t } = useTranslation("preview")
	const { entry } = item
	const title = entry.summary ?? t("previewCalendarUntitled")

	return (
		<div className="border-b border-border/30">
			<button
				type="button"
				aria-expanded={open}
				className="grid w-full grid-cols-[1.25rem_6.5rem_minmax(0,1fr)] gap-x-3 px-4 py-2.5 text-start text-sm hover:bg-accent/50"
				onClick={onToggle}
			>
				{open ? <ChevronDownIcon className="mt-0.5 size-4" /> : <ChevronRightIcon className="mt-0.5 size-4" />}
				<TimeColumn time={item.time} />
				<span className="flex min-w-0 flex-col">
					<span className="font-medium break-words">
						<bdi>{title}</bdi>
						{entry.kind === "todo" ? (
							<span className="ms-2 text-xs text-muted-foreground">{t("previewCalendarTodo")}</span>
						) : null}
					</span>
					{entry.location === null ? null : (
						<span className="truncate text-muted-foreground">
							<bdi>{entry.location}</bdi>
						</span>
					)}
					{entry.recurrence === null ? null : (
						<span className="text-xs text-muted-foreground">{recurrenceWords(t, entry.recurrence)}</span>
					)}
				</span>
			</button>
			{open ? (
				<div className="px-4 ps-12 pb-4">
					<MetadataCard
						title={title}
						sections={[{ fields: detailFields(t, entry, zones) }]}
					/>
				</div>
			) : null}
		</div>
	)
}

type Row = { kind: "day"; day: AgendaDay } | { kind: "item"; item: AgendaItem }

// Entries past the cap: an exact count, or a lower bound when reading stopped before the file's end.
function omittedNote(t: TFunction<"preview">, count: number, truncated: boolean): string | null {
	if (truncated) {
		return ` · ${count > 0 ? t("previewCalendarOmittedAtLeast", { count }) : t("previewCalendarTruncated")}`
	}

	return count > 0 ? ` · ${t("previewCalendarOmitted", { count })}` : null
}

// A day heading; a day that is no date (never from the parser, which checks them) is shown as written.
function dayHeading(day: string): string {
	const ms = dayMs(day)

	return Number.isFinite(ms) ? WALL_DAY.format(ms) : day
}

// Only the rows in view are mounted; rows measure themselves (an expanded one holds its details).
function AgendaRows({ rows, zones }: { rows: readonly Row[]; zones: ZoneTable }) {
	const { t } = useTranslation("preview")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: index => (rows[index]?.kind === "day" ? 36 : 56),
		overscan: 8
	})

	return (
		<div
			ref={setScrollElement}
			className="min-h-0 flex-1 overflow-y-auto"
		>
			<div
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(virtualRow => {
					const row = rows[virtualRow.index]

					return (
						<div
							key={virtualRow.key}
							ref={virtualizer.measureElement}
							data-index={virtualRow.index}
							className="absolute top-0 left-0 w-full"
							style={{ transform: `translateY(${String(virtualRow.start)}px)` }}
						>
							{row === undefined ? null : row.kind === "day" ? (
								<h3 className="bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">
									{row.day.day === "" ? t("previewCalendarUndated") : dayHeading(row.day.day)}
								</h3>
							) : (
								<AgendaRow
									item={row.item}
									zones={zones}
									open={open.has(row.item.index)}
									onToggle={() => {
										const next = new Set(open)

										if (!next.delete(row.item.index)) next.add(row.item.index)

										setOpen(next)
									}}
								/>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}

// Grouped once per reading (the compiler keeps it while `calendar` stays), never per scroll.
function Agenda({ calendar }: { calendar: CalendarFile }) {
	const { t } = useTranslation("preview")
	const zones = zoneTable(calendar.zones)
	const rows: Row[] = agendaDays(calendar.entries, zones).flatMap(day => [
		{ kind: "day", day } as const,
		...day.items.map(item => ({ kind: "item", item }) as const)
	])
	const count = calendar.entries.length

	if (count === 0) {
		return <PreviewErrorState message={t("previewCalendarEmpty")} />
	}

	return (
		<div className="flex size-full flex-col">
			<p className="border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
				{calendar.name === null ? null : (
					<>
						<bdi className="font-medium text-foreground">{calendar.name}</bdi>
						{" · "}
					</>
				)}
				{t("previewCalendarSummary", { count })}
				{omittedNote(t, calendar.entriesOmitted, calendar.truncated)}
			</p>
			<AgendaRows
				rows={rows}
				zones={zones}
			/>
		</div>
	)
}

function AgendaView({ source }: { source: RenderedSource }) {
	const { t } = useTranslation("preview")
	const reading = useTextFamilyReading(source.file.text, readCalendarFile, "a calendar")

	if (reading.status === "pending") {
		return <PreviewLoading />
	}

	if (reading.status === "failed") {
		return <PreviewErrorState message={t("previewCalendarFailed")} />
	}

	return <Agenda calendar={reading.value} />
}

function renderAgenda(source: RenderedSource) {
	return <AgendaView source={source} />
}

// A calendar file: its events and to-dos as an agenda by day, each expanding to its details, its source a toggle away.
// No parameter defaults: the React Compiler skips a component that has them.
export function CalendarViewer({ item, alt, editable, onDirtyChange, contentRef, locked, onTextState, readAs }: TextViewerProps) {
	const { t } = useTranslation("preview")

	return (
		<RenderedSourceViewer
			item={item}
			alt={alt}
			renderer={renderAgenda}
			tag={codeMirrorLanguageFor(itemTypeExtension(item))}
			formatting={false}
			labels={{ view: t("previewCalendarView"), rendered: t("previewCalendarAgenda") }}
			{...(editable === undefined ? {} : { editable })}
			{...(onDirtyChange === undefined ? {} : { onDirtyChange })}
			{...(contentRef === undefined ? {} : { contentRef })}
			{...(locked === undefined ? {} : { locked })}
			{...(onTextState === undefined ? {} : { onTextState })}
			{...(readAs === undefined ? {} : { readAs })}
		/>
	)
}
