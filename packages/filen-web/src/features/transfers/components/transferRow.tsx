import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	CheckIcon,
	CopyIcon,
	DownloadIcon,
	FilesIcon,
	FolderSearchIcon,
	PanelBottomOpenIcon,
	PauseIcon,
	PlayIcon,
	Trash2Icon,
	UploadIcon,
	XIcon
} from "lucide-react"
import { copyJobRate, formatBytes, formatBytesFixed, formatSecondsToMediaClock, isCopyJobRunning, cn } from "@filen/shared"
import { isActiveTransfer, useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import {
	transferProgress,
	activeStatusLabelKey,
	finishedStatusLabelKey,
	transferIconKey,
	transferRate,
	percentFormat,
	runningPercentFraction,
	type TransferRate
} from "@/features/transfers/components/transferRow.logic"
import { pauseTransfer, resumeTransfer } from "@/features/transfers/lib/control"
import { showCopyToast } from "@/features/transfers/lib/copyToast"
import { pruneSettledCopyJobs } from "@/features/drive/lib/copy"
import { useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { DirectoryGlyph, FileTypeIcon } from "@/features/drive/components/itemIcon"
import type { DriveItem } from "@/features/drive/lib/item"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface TransferRowProps {
	transfer: Transfer
	// Cancel's own confirm dialog is owned by the SCREEN (screens/transfers.tsx), not this row:
	// buildTransfersDisplayList renders active/finished transfers in two SEPARATE sections, so a row
	// moving from active to finished (settling mid-confirm) unmounts this component and remounts a new
	// one in the other section — a dialog-open flag kept in local row state would silently vanish right
	// under the user's cursor the instant that happens. The screen instead tracks a stable id (immune
	// to this component ever remounting) and re-resolves the target transfer by id on every render, so
	// a transfer that settles naturally while its confirm is open closes the dialog gracefully instead
	// of losing it. This callback is only ever wired to the active-row branch below.
	onRequestCancel: () => void
	// Opens the directory `item` landed in, with it selected. Navigation is the screen's.
	onShowInDirectory: (item: DriveItem) => void
}

const RING_RADIUS = 18
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

// The leading glyph: the item's own type icon inside a ring that fills with the transfer's progress, and
// a badge on its corner for what is happening to it — its direction while it runs, a pause, a check, an
// alert. A finished row drops the ring: a full circle beside every done row would only be noise. The
// ring is the row's progressbar, named after the item, while it runs.
function TransferGlyph({
	transfer,
	progress,
	icon,
	trashing
}: {
	transfer: Transfer
	progress: number
	icon: ReactNode
	trashing: boolean
}) {
	const { t } = useTranslation("transfers")
	const active = isActiveTransfer(transfer.status)
	const DirectionIcon = transfer.direction === "upload" ? UploadIcon : transfer.direction === "download" ? DownloadIcon : CopyIcon

	let badge: ReactNode

	if (trashing) {
		badge = <Trash2Icon />
	} else if (active) {
		badge = transfer.paused ? <PauseIcon /> : <DirectionIcon />
	} else if (transfer.status === "done") {
		badge = <CheckIcon />
	} else {
		badge = <span className="text-[11px] leading-none font-bold">!</span>
	}

	return (
		<div className="relative size-10 shrink-0">
			{active ? (
				<div
					role="progressbar"
					aria-label={transfer.name}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(progress)}
					aria-valuetext={t(activeStatusLabelKey(transfer.direction, transfer.paused))}
					className="absolute inset-0"
				>
					<svg
						viewBox="0 0 40 40"
						aria-hidden="true"
						className="size-full -rotate-90"
					>
						<circle
							cx="20"
							cy="20"
							r={RING_RADIUS}
							fill="none"
							strokeWidth="2.5"
							className="stroke-muted"
						/>
						<circle
							cx="20"
							cy="20"
							r={RING_RADIUS}
							fill="none"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeDasharray={RING_CIRCUMFERENCE}
							strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress / 100)}
							className={cn(
								"transition-[stroke-dashoffset] duration-300 ease-out",
								transfer.paused || trashing ? "stroke-muted-foreground/50" : "stroke-primary"
							)}
						/>
					</svg>
				</div>
			) : (
				<div className="absolute inset-0 rounded-full bg-muted" />
			)}
			<div className="absolute inset-0 flex items-center justify-center">{icon}</div>
			<div
				aria-hidden="true"
				className={cn(
					"absolute -right-0.5 -bottom-0.5 flex size-[18px] items-center justify-center rounded-full ring-2 ring-background [&_svg]:size-2.5 [&_svg]:stroke-[3]",
					badgeTone(transfer, trashing)
				)}
			>
				{badge}
			</div>
		</div>
	)
}

// Solid fills only: the badge sits over the ring and the icon, where a translucent one reads as a smudge.
// Running and done are the strong fill; a stalled state (paused, moving to the trash, finished with
// some items failed) the quieter one; a failure the destructive one.
function badgeTone(transfer: Transfer, trashing: boolean): string {
	if (transfer.status === "error") {
		return "bg-destructive text-white"
	}

	if (trashing || transfer.paused || transfer.status === "completedWithErrors") {
		return "bg-muted-foreground text-background"
	}

	return "bg-primary text-primary-foreground"
}

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={label}
						className="text-muted-foreground hover:text-foreground"
						onClick={onClick}
					>
						{children}
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

// One transfer: the glyph, the item's name over a single line of details, and its controls. An active
// row reads "312 MiB of 842 MiB · 37% · 4.2 MB/s · 2:05 left" (or "Paused · …"); a finished one says
// what happened, "Uploaded · 6 MiB", or in red why it failed. Active rows pause/resume and cancel (the
// screen confirms the cancel, see onRequestCancel); finished rows can open where the item landed and
// be removed from the list, which touches nothing but the list.
export function TransferRow({ transfer, onRequestCancel, onShowInDirectory }: TransferRowProps) {
	const { t, i18n } = useTranslation("transfers")
	const progress = transferProgress(transfer)
	const active = isActiveTransfer(transfer.status)
	const job = useCopyJobsStore(state => (transfer.direction === "copy" ? state.jobs[transfer.id] : undefined))
	const rowSamples = useTransfersStore(state => state.rowSpeedSamples[transfer.id])
	// A stopped copy's row stays active past its job while its copies move to the trash, which can't be
	// paused or stopped.
	const trashing = active && job !== undefined && !isCopyJobRunning(job)
	// A copy's rate comes off its job, which knows the files it has not reached yet.
	const rate: TransferRate | null =
		transfer.direction === "copy" ? (job === undefined ? null : copyJobRate(job)) : transferRate(transfer, rowSamples ?? [])
	// What "Show in directory" opens: a landed upload's file, or the first item a copy created.
	const revealItem =
		transfer.status === "done" || transfer.status === "completedWithErrors" ? (transfer.item ?? job?.created[0]) : undefined

	// The running line keeps its figures still without reserving space for them. Live figures keep their
	// decimals (formatBytesFixed), so a tick never changes their length, and tabular digits their width;
	// what still changes length does so rarely (9% to 10%, 10:00 to 9:59). The speed is the exception, as
	// it rises and falls across a digit or a unit all the time, so it goes last, where it has nothing to
	// push. A finished row's figures no longer move, so they read plainly.
	const bytes =
		transfer.size > 0
			? t("transfersRowBytesProgress", { done: formatBytesFixed(transfer.bytesTransferred), total: formatBytesFixed(transfer.size) })
			: formatBytesFixed(transfer.bytesTransferred)
	let details: (string | null)[]

	if (trashing) {
		details = [t("transfersStatusMovingToTrash")]
	} else if (active && transfer.paused) {
		details = [t("transfersStatusPaused"), bytes]
	} else if (active) {
		details = [
			bytes,
			transfer.size > 0 ? percentFormat(i18n.language).format(runningPercentFraction(progress)) : null,
			rate?.etaSeconds == null ? null : t("transfersRowTimeLeft", { eta: formatSecondsToMediaClock(rate.etaSeconds) }),
			rate === null ? null : t("transfersAggregateSpeed", { speed: formatBytesFixed(rate.bytesPerSecond) })
		]
	} else if (transfer.status === "error") {
		details = [
			t(finishedStatusLabelKey(transfer.status, transfer.direction)),
			transfer.error === undefined ? null : errorLabel(transfer.error)
		]
	} else {
		details = [t(finishedStatusLabelKey(transfer.status, transfer.direction)), formatBytes(transfer.size)]
	}

	const icon =
		job?.glyph === "directory" ? (
			<DirectoryGlyph
				color="default"
				className="size-5"
			/>
		) : job?.glyph === "items" ? (
			<FilesIcon
				aria-hidden="true"
				className="size-5 text-muted-foreground"
			/>
		) : (
			<FileTypeIcon
				iconKey={transferIconKey(transfer)}
				className="size-5"
			/>
		)

	return (
		<li
			aria-label={transfer.name}
			className="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-accent/40"
		>
			<TransferGlyph
				transfer={transfer}
				progress={progress}
				icon={icon}
				trashing={trashing}
			/>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">{transfer.name}</p>
				<p
					className={cn(
						"truncate text-xs tabular-nums",
						transfer.status === "error" ? "text-destructive" : "text-muted-foreground"
					)}
				>
					{details.filter(part => part !== null).join(" · ")}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-0.5">
				{job !== undefined ? (
					<RowAction
						label={t("transfersRowCopyDetails")}
						onClick={() => {
							showCopyToast(transfer.id)
						}}
					>
						<PanelBottomOpenIcon />
					</RowAction>
				) : null}
				{!active ? (
					<>
						{revealItem !== undefined ? (
							<RowAction
								label={t("transfersRowShowInDirectory")}
								onClick={() => {
									onShowInDirectory(revealItem)
								}}
							>
								<FolderSearchIcon />
							</RowAction>
						) : null}
						<RowAction
							label={t("transfersRowRemove")}
							onClick={() => {
								useTransfersStore.getState().remove(transfer.id)
								pruneSettledCopyJobs()
							}}
						>
							<XIcon />
						</RowAction>
					</>
				) : trashing ? null : (
					<>
						<RowAction
							label={t(transfer.paused ? "transfersRowResume" : "transfersRowPause")}
							onClick={() => {
								if (transfer.paused) {
									resumeTransfer(transfer.id)
								} else {
									pauseTransfer(transfer.id)
								}
							}}
						>
							{transfer.paused ? <PlayIcon /> : <PauseIcon />}
						</RowAction>
						<RowAction
							label={t("transfersRowCancel")}
							onClick={onRequestCancel}
						>
							<XIcon />
						</RowAction>
					</>
				)}
			</div>
		</li>
	)
}
