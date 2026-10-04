import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CopyIcon, FolderOpenIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { copyText } from "@/lib/copyText"
import { DirectoryGlyph, FileTypeIcon } from "@/features/drive/components/itemIcon"
import { EVENT_ICONS, EVENT_TONE_CLASS } from "@/features/settings/lib/eventIcons"
import type { EventIconKey, EventTone } from "@/features/settings/lib/eventModel"
import type {
	EventDetailColor,
	EventDetailRow,
	EventDetailSection,
	EventHeroGlyph
} from "@/features/settings/components/events/eventDetailDialog.logic"
import { MiddleEllipsis } from "@/components/middleEllipsis"
import { UserAvatar } from "@/components/userAvatar"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

// The event's glyph on a tone-tinted tile: the item's own icon with the action as a badge, or the action
// alone when the event names no item.
export function EventHeroTile({ glyph, icon, tone }: { glyph: EventHeroGlyph; icon: EventIconKey; tone: EventTone }) {
	const Icon = EVENT_ICONS[icon]

	if (glyph.type === "action") {
		return (
			<span className={cn("flex size-16 shrink-0 items-center justify-center rounded-2xl [&_svg]:size-7", EVENT_TONE_CLASS[tone])}>
				<Icon aria-hidden="true" />
			</span>
		)
	}

	return (
		<span className="relative flex size-16 shrink-0 items-center justify-center rounded-2xl bg-muted">
			{glyph.type === "file" ? (
				<FileTypeIcon
					iconKey={glyph.iconKey}
					className="size-9"
				/>
			) : (
				<DirectoryGlyph
					color={glyph.color}
					className="size-9"
				/>
			)}
			<span
				className={cn(
					"absolute -right-1.5 -bottom-1.5 flex size-7 items-center justify-center rounded-full ring-3 ring-popover [&_svg]:size-3.5",
					// The muted tint is translucent over the tile; the badge needs its own backdrop.
					tone === "default" ? "bg-secondary text-secondary-foreground" : EVENT_TONE_CLASS[tone]
				)}
			>
				<Icon aria-hidden="true" />
			</span>
		</span>
	)
}

function CopyButton({ value, label }: { value: string; label: string }) {
	const { t } = useTranslation("events")

	return (
		<TooltipIconButton
			label={t("eventsActionCopyField", { field: label })}
			className="-my-1 shrink-0 text-muted-foreground"
			onClick={() => {
				void copyText(value, t("eventsCopied"))
			}}
		>
			<CopyIcon />
		</TooltipIconButton>
	)
}

function Swatch({ hex }: { hex: string }) {
	return (
		<span
			aria-hidden="true"
			className="inline-block size-3 shrink-0 rounded-full ring-1 ring-foreground/15"
			style={{ backgroundColor: hex }}
		/>
	)
}

function ColorValue({ color }: { color: EventDetailColor }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<Swatch hex={color.hex} />
			{color.value}
			{color.hint === undefined ? null : <span className="font-mono text-xs font-normal text-muted-foreground">{color.hint}</span>}
		</span>
	)
}

function RowShell({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2.5 text-sm">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
				<span className="min-w-0 text-right font-medium break-words select-text">{children}</span>
				{action}
			</span>
		</div>
	)
}

function NameValue({ row }: { row: EventDetailRow }) {
	const { t } = useTranslation("events")

	if (row.misleading !== true) {
		return <bdi>{row.value}</bdi>
	}

	return (
		<span className="inline-flex min-w-0 items-start gap-1.5">
			<TriangleAlertIcon
				aria-label={t("eventsMisleadingName")}
				className="mt-0.5 size-3.5 shrink-0 text-amber-500"
			/>
			<bdi className="min-w-0 break-all">{row.value}</bdi>
		</span>
	)
}

function RowValue({ row }: { row: EventDetailRow }) {
	if (row.pending === true) {
		return <Spinner className="ml-auto size-4 text-muted-foreground" />
	}

	if (row.colors !== undefined) {
		return (
			<span className="inline-flex flex-wrap items-center justify-end gap-x-1.5">
				<ColorValue color={row.colors.from} />
				<span aria-hidden="true">→</span>
				<ColorValue color={row.colors.to} />
			</span>
		)
	}

	if (row.swatch !== undefined) {
		return (
			<ColorValue
				color={
					row.hint === undefined ? { value: row.value, hex: row.swatch } : { value: row.value, hex: row.swatch, hint: row.hint }
				}
			/>
		)
	}

	if (row.name === true) {
		return <NameValue row={row} />
	}

	if (row.contact !== undefined) {
		const { contact } = row

		return (
			<span className="inline-flex min-w-0 items-center gap-2">
				<UserAvatar
					src={contact.avatar}
					name={contact.name ?? contact.email}
					size="sm"
				/>
				<span className="flex min-w-0 flex-col text-left">
					{contact.name === undefined ? null : <span className="truncate">{contact.name}</span>}
					<span className={cn("break-all", contact.name === undefined ? null : "text-xs font-normal text-muted-foreground")}>
						{contact.email}
					</span>
				</span>
			</span>
		)
	}

	if (row.location !== undefined) {
		return (
			<span className="inline-flex min-w-0 items-center gap-1.5">
				<DirectoryGlyph
					color="default"
					className="size-4 shrink-0"
				/>
				<bdi className="min-w-0 break-words">{row.value}</bdi>
			</span>
		)
	}

	if (row.opaque === true) {
		return (
			<MiddleEllipsis
				value={row.value}
				className="font-mono text-xs"
			/>
		)
	}

	return (
		<>
			{row.value}
			{row.hint === undefined ? null : <span className="ml-1.5 text-xs font-normal text-muted-foreground">{row.hint}</span>}
		</>
	)
}

function UserAgentRow({ row }: { row: EventDetailRow }) {
	const { t } = useTranslation("events")
	const [open, setOpen] = useState(false)

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
		>
			<RowShell
				label={row.label}
				action={
					<CopyButton
						value={row.value}
						label={row.label}
					/>
				}
			>
				<CollapsibleTrigger
					render={
						<Button
							variant="link"
							size="xs"
							className="h-auto px-0 font-medium"
						/>
					}
				>
					{t(open ? "eventsActionHideUserAgent" : "eventsActionShowUserAgent")}
				</CollapsibleTrigger>
			</RowShell>
			<CollapsibleContent className="px-3.5 pb-2.5">
				<p className="font-mono text-xs break-all text-muted-foreground select-text">{row.value}</p>
			</CollapsibleContent>
		</Collapsible>
	)
}

export function EventDetailRowView({
	row,
	locationPending,
	onOpenLocation
}: {
	row: EventDetailRow
	locationPending: boolean
	onOpenLocation: (uuid: string) => void
}) {
	const { t } = useTranslation("events")

	if (row.collapsible === true) {
		return <UserAgentRow row={row} />
	}

	const { location } = row
	const action =
		location !== undefined ? (
			<TooltipIconButton
				label={t("eventsActionOpenLocation")}
				className="-my-1 shrink-0 text-muted-foreground"
				disabled={locationPending}
				onClick={() => {
					onOpenLocation(location)
				}}
			>
				{locationPending ? <Spinner /> : <FolderOpenIcon />}
			</TooltipIconButton>
		) : row.copy !== undefined ? (
			<CopyButton
				value={row.copy}
				label={row.label}
			/>
		) : null

	return (
		<RowShell
			label={row.label}
			action={action}
		>
			<RowValue row={row} />
		</RowShell>
	)
}

export function EventDetailSectionView({
	section,
	locationPending,
	onOpenLocation
}: {
	section: EventDetailSection
	locationPending: boolean
	onOpenLocation: (uuid: string) => void
}) {
	const headingId = `event-detail-${section.key}`

	return (
		<section
			aria-labelledby={headingId}
			className="flex min-w-0 flex-col gap-1.5"
		>
			<h3
				id={headingId}
				className="px-1 text-xs font-medium text-muted-foreground"
			>
				{section.title}
			</h3>
			<div className="flex min-w-0 flex-col divide-y divide-border/50 rounded-xl ring-1 ring-border/60">
				{section.rows.map(row => (
					<EventDetailRowView
						key={row.key}
						row={row}
						locationPending={locationPending}
						onOpenLocation={onOpenLocation}
					/>
				))}
			</div>
		</section>
	)
}

export function RawEventView({ json }: { json: string }) {
	const { t } = useTranslation("events")
	const [open, setOpen] = useState(false)

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="flex min-w-0 flex-col gap-1.5"
		>
			<div className="flex items-center justify-between gap-2 px-1">
				<CollapsibleTrigger
					render={
						<Button
							variant="link"
							size="xs"
							className="h-auto px-0"
						/>
					}
				>
					{t(open ? "eventsActionHideRawEvent" : "eventsActionShowRawEvent")}
				</CollapsibleTrigger>
				{open ? (
					<CopyButton
						value={json}
						label={t("eventsFieldRawEvent")}
					/>
				) : null}
			</div>
			<CollapsibleContent>
				<pre className="max-h-64 overflow-auto rounded-xl bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap select-text">
					{json}
				</pre>
			</CollapsibleContent>
		</Collapsible>
	)
}
