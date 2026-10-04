import { useRef, useState, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { CircleHelpIcon, CloudOffIcon, CopyIcon, FolderSearchIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react"
import { RELATIVE_TIME_CUTOFF_DAYS } from "@filen/shared"
import { formatRelativeTime } from "@/lib/relativeTime"
import { useNowMinute } from "@/lib/useNowMinute"
import { useIsOnline } from "@/lib/useIsOnline"
import { copyText } from "@/lib/copyText"
import { describeEvent, type EventDescription, type EventModelContext } from "@/features/settings/lib/eventModel"
import type { EventEntry } from "@/features/settings/lib/eventsPagination"
import { entryTimeKnown, eventTitleSegments } from "@/features/settings/components/events/eventsList.logic"
import { useEventModelContext } from "@/features/settings/hooks/useEventModelContext"
import { useEventItemActions } from "@/features/settings/hooks/useEventItemActions"
import { useEventDetailQuery, useEventLocationNameQuery } from "@/features/settings/queries/eventDetail"
import {
	buildEventDetailView,
	eventDetailText,
	eventHeroGlyph,
	eventLocationUuid,
	eventLookupFailure,
	eventLookupRef,
	type EventDetailLocation
} from "@/features/settings/components/events/eventDetailDialog.logic"
import { EventDetailSectionView, EventHeroTile, RawEventView } from "@/features/settings/components/events/eventDetailRows"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface EventDetailDialogProps {
	eventUuid: string | null
	// The loaded event, or null for one the list doesn't hold (a deep link), which is then read by its uuid.
	entry: EventEntry | null
	// The list's first page is still loading: a deep-linked event waits for it before being read alone.
	waitForList: boolean
	onClose: () => void
}

interface Shown {
	uuid: string
	entry: EventEntry | null
}

const FULL_DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" })
const RELATIVE_CUTOFF_MS = RELATIVE_TIME_CUTOFF_DAYS * 24 * 60 * 60 * 1000

// Open while `eventUuid` is set. The event last shown stays rendered through the exit animation.
export function EventDetailDialog({ eventUuid, entry, waitForList, onClose }: EventDetailDialogProps) {
	const [shown, setShown] = useState<Shown | null>(eventUuid === null ? null : { uuid: eventUuid, entry })
	const scrollRef = useRef<HTMLDivElement>(null)

	if (eventUuid !== null && (shown?.uuid !== eventUuid || shown.entry !== entry)) {
		setShown({ uuid: eventUuid, entry })
	}

	const view = eventUuid === null ? shown : { uuid: eventUuid, entry }

	return (
		<Dialog
			open={eventUuid !== null}
			onOpenChange={next => {
				if (!next) {
					onClose()
				}
			}}
			onOpenChangeComplete={opened => {
				if (!opened) {
					setShown(null)
				}
			}}
		>
			<DialogContent
				className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg"
				initialFocus={scrollRef}
			>
				{view === null ? null : view.entry === null ? (
					<DeepLinkedEvent
						key={view.uuid}
						uuid={view.uuid}
						waitForList={waitForList}
						scrollRef={scrollRef}
					/>
				) : (
					<EventDetailBody
						key={view.uuid}
						entry={view.entry}
						scrollRef={scrollRef}
					/>
				)}
			</DialogContent>
		</Dialog>
	)
}

// Why a deep-linked event isn't shown: gone, offline, or a failed read with its retry as `children`.
function DeepLinkStatus({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-3 py-6 text-center">
			<span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground [&_svg]:size-6">
				<Icon aria-hidden="true" />
			</span>
			<DialogTitle className="max-w-xs leading-snug">{title}</DialogTitle>
			{children}
		</div>
	)
}

function DeepLinkedEvent({
	uuid,
	waitForList,
	scrollRef
}: {
	uuid: string
	waitForList: boolean
	scrollRef: RefObject<HTMLDivElement | null>
}) {
	const { t } = useTranslation(["events", "common"])
	const isOnline = useIsOnline()
	const query = useEventDetailQuery(uuid, !waitForList)

	if (query.status === "success") {
		return (
			<EventDetailBody
				entry={query.data}
				scrollRef={scrollRef}
			/>
		)
	}

	if (query.status === "pending" && isOnline) {
		return (
			<div className="flex min-h-40 items-center justify-center">
				<DialogTitle className="sr-only">{t("common:loading")}</DialogTitle>
				<Spinner className="size-6 text-muted-foreground" />
			</div>
		)
	}

	// Paused until the connection returns, when it reads by itself.
	if (query.status === "pending") {
		return (
			<DeepLinkStatus
				icon={CloudOffIcon}
				title={t("eventsDetailOffline")}
			/>
		)
	}

	if (eventLookupFailure(query.error) === "notFound") {
		return (
			<DeepLinkStatus
				icon={CircleHelpIcon}
				title={t("eventsNotFound")}
			/>
		)
	}

	return (
		<DeepLinkStatus
			icon={TriangleAlertIcon}
			title={t("eventsDetailLoadError")}
		>
			<Button
				variant="outline"
				disabled={query.isFetching || !isOnline}
				onClick={() => {
					void query.refetch()
				}}
			>
				{query.isFetching ? <Spinner data-icon="inline-start" /> : null}
				{t("common:tryAgain")}
			</Button>
		</DeepLinkStatus>
	)
}

// Described once per entry: no hook runs after it, so the compiler keeps its memo.
function EventDetailBody({ entry, scrollRef }: { entry: EventEntry; scrollRef: RefObject<HTMLDivElement | null> }) {
	const ctx = useEventModelContext()
	const description = describeEvent(entry, ctx)

	return (
		<EventDetailContent
			entry={entry}
			description={description}
			ctx={ctx}
			scrollRef={scrollRef}
		/>
	)
}

function EventDetailContent({
	entry,
	description,
	ctx,
	scrollRef
}: {
	entry: EventEntry
	description: EventDescription
	ctx: EventModelContext
	scrollRef: RefObject<HTMLDivElement | null>
}) {
	const { t } = useTranslation("events")
	const { t: tCommon } = useTranslation("common")
	const now = useNowMinute()
	const locationUuid = eventLocationUuid(description)
	// A cached name (the drive root's included) needs no request; otherwise one, resolved on open.
	const unresolved = locationUuid !== undefined && description.location === undefined && locationUuid !== ctx.rootUuid
	const nameQuery = useEventLocationNameQuery(unresolved ? locationUuid : undefined)
	const lookupRef = eventLookupRef(description)
	const actions = useEventItemActions({ item: lookupRef, rootUuid: ctx.rootUuid })

	let location: EventDetailLocation | undefined

	if (locationUuid !== undefined) {
		if (description.location !== undefined) {
			location = { status: "resolved", uuid: locationUuid, name: description.location }
		} else if (typeof nameQuery.data === "string") {
			location = { status: "resolved", uuid: locationUuid, name: nameQuery.data }
		} else if (nameQuery.isLoading) {
			location = { status: "pending", uuid: locationUuid }
		}
	}

	const view = buildEventDetailView(entry, description, location, ctx)
	const timestamp = Number(entry.timestamp)
	const timeKnown = entryTimeKnown(entry)
	const when = timeKnown ? FULL_DATE_TIME.format(timestamp) : t("eventsUnknownTime")
	const relative = timeKnown && now - timestamp < RELATIVE_CUTOFF_MS ? formatRelativeTime(timestamp, tCommon, now) : null

	return (
		<>
			<div
				ref={scrollRef}
				tabIndex={-1}
				className="-mx-6 -mt-2 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-2 outline-none"
			>
				<div className="flex min-w-0 flex-col items-center gap-3 pt-2 text-center">
					<EventHeroTile
						glyph={eventHeroGlyph(entry, description)}
						icon={description.icon}
						tone={description.tone}
					/>
					<div className="flex min-w-0 flex-col items-center gap-1">
						<DialogTitle className="leading-snug break-words select-text">
							{eventTitleSegments(description, t, true).map((segment, i) =>
								segment.strong ? <bdi key={i}>{segment.text}</bdi> : segment.text
							)}
						</DialogTitle>
						<DialogDescription>
							{timeKnown ? <time dateTime={new Date(timestamp).toISOString()}>{when}</time> : when}
							{/* Kept whole: a narrow dialog would otherwise break "3 minutes ago" across lines. */}
							{relative === null ? null : (
								<>
									{" "}
									<span className="whitespace-nowrap">· {relative}</span>
								</>
							)}
						</DialogDescription>
					</div>
					{description.misleading === true ? (
						<p className="flex items-start gap-1.5 text-left text-xs text-muted-foreground">
							<TriangleAlertIcon
								aria-hidden="true"
								className="mt-px size-3.5 shrink-0 text-amber-500"
							/>
							<span className="min-w-0 flex-1">{t("eventsMisleadingName")}</span>
						</p>
					) : null}
				</div>

				{view.sections.map(section => (
					<EventDetailSectionView
						key={section.key}
						section={section}
						locationPending={actions.locationPending}
						onOpenLocation={uuid => {
							void actions.openLocation(uuid)
						}}
					/>
				))}

				{view.rawJson === undefined ? null : <RawEventView json={view.rawJson} />}
			</div>

			{actions.itemStatus === "gone" ? (
				<p
					role="status"
					className="text-center text-sm text-muted-foreground sm:text-right"
				>
					{t("eventsItemGone")}
				</p>
			) : null}

			<DialogFooter>
				<Button
					variant="outline"
					onClick={() => {
						void copyText(eventDetailText(description.title, when, view), t("eventsCopied"))
					}}
				>
					<CopyIcon data-icon="inline-start" />
					{t("eventsActionCopyDetails")}
				</Button>
				{lookupRef === undefined ? null : (
					<Button
						disabled={actions.itemStatus !== "idle"}
						onClick={() => {
							void actions.showInDrive()
						}}
					>
						{actions.itemStatus === "pending" ? (
							<Spinner data-icon="inline-start" />
						) : (
							<FolderSearchIcon data-icon="inline-start" />
						)}
						{t("eventsActionShowInDrive")}
					</Button>
				)}
			</DialogFooter>
		</>
	)
}
