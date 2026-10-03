import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	ArchiveIcon,
	CheckIcon,
	CopyIcon,
	DownloadIcon,
	FolderSearchIcon,
	PackageOpenIcon,
	PanelBottomOpenIcon,
	PauseIcon,
	PlayIcon,
	Trash2Icon,
	UploadIcon,
	XIcon,
	type LucideIcon
} from "lucide-react"
import { formatBytes, formatBytesFixed, isJobRunning, isWaitingForArchiveSlot, cn } from "@filen/shared"
import {
	isActiveTransfer,
	isDriveJobDirection,
	useTransfersStore,
	type Transfer,
	type TransferDirection
} from "@/features/transfers/store/useTransfersStore"
import {
	transferProgress,
	activeStatusLabelKey,
	finishedStatusLabelKey,
	jobDetailsLabelKey
} from "@/features/transfers/components/transferRow.logic"
import { setTransferPaused } from "@/features/transfers/lib/control"
import { showJobToast } from "@/features/transfers/lib/jobToast"
import { pruneSettledDriveJobs } from "@/features/drive/lib/driveJobs"
import { jobRevealItem } from "@/features/drive/lib/driveJobs.logic"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { TransferIcon } from "@/features/transfers/components/transferIcon"
import { useRunningDetails, useTransferRate } from "@/features/transfers/hooks/useTransferFigures"
import type { DriveItem } from "@/features/drive/lib/item"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

export interface TransferRowProps {
	transfer: Transfer
	// Cancel's own confirm dialog is owned by the SCREEN (screens/transfers.tsx), not this row:
	// buildTransfersDisplayList renders active/finished transfers in two SEPARATE sections, so a row
	// moving from active to finished (settling mid-confirm) unmounts this component and remounts a new
	// one in the other section — a dialog-open flag kept in local row state would silently vanish right
	// under the user's cursor the instant that happens. The screen instead tracks a stable id (immune
	// to this component ever remounting) and re-resolves the target transfer by id on every render, so
	// a transfer that settles naturally while its confirm is open closes the dialog gracefully instead
	// of losing it. This callback is only ever wired to the active-row branch below. It takes the transfer
	// so the (virtualized, uncompiled) list can pass one stable function instead of a closure per row.
	onRequestCancel: (transfer: Transfer) => void
	// Opens the directory `item` landed in, with it selected. Navigation is the screen's.
	onShowInDirectory: (item: DriveItem) => void
}

const RING_RADIUS = 18
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

const DIRECTION_ICONS: Readonly<Record<TransferDirection, LucideIcon>> = {
	upload: UploadIcon,
	download: DownloadIcon,
	copy: CopyIcon,
	compress: ArchiveIcon,
	extract: PackageOpenIcon
}

// The leading glyph: the item's own type icon inside a ring that fills with the transfer's progress, and
// a badge on its corner for what is happening to it — its direction while it runs, a pause, a check, an
// alert. A finished row drops the ring: a full circle beside every done row would only be noise. The
// ring is the row's progressbar, named after the item, while it runs.
function TransferGlyph({
	transfer,
	progress,
	icon,
	trashing,
	waiting
}: {
	transfer: Transfer
	progress: number
	icon: ReactNode
	trashing: boolean
	waiting: boolean
}) {
	const { t } = useTranslation("transfers")
	const active = isActiveTransfer(transfer.status)
	const DirectionIcon = DIRECTION_ICONS[transfer.direction]

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
					aria-valuetext={t(activeStatusLabelKey(transfer.direction, transfer.paused, waiting))}
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

const ROW_ACTION_CLASS = "text-muted-foreground hover:text-foreground"

// One transfer: the glyph, the item's name over a single line of details, and its controls. An active
// row reads "312 MiB of 842 MiB · 37% · 4.2 MB/s · 2:05 left" (or "Paused · …"); a finished one says
// what happened, "Uploaded · 6 MiB", or in red why it failed. Active rows pause/resume and cancel (the
// screen confirms the cancel, see onRequestCancel); finished rows can open where the item landed and
// be removed from the list, which touches nothing but the list.
export function TransferRow({ transfer, onRequestCancel, onShowInDirectory }: TransferRowProps) {
	const { t } = useTranslation("transfers")
	const progress = transferProgress(transfer)
	const active = isActiveTransfer(transfer.status)
	const isJob = isDriveJobDirection(transfer.direction)
	const landed = transfer.status === "done" || transfer.status === "completedWithErrors"
	// Primitives and stable refs only, so a row re-renders for its own job and only when what it shows moves.
	const hasJob = useDriveJobsStore(state => isJob && state.jobs[transfer.id] !== undefined)
	const jobEnded = useDriveJobsStore(state => {
		const job = isJob ? state.jobs[transfer.id] : undefined

		return job !== undefined && !isJobRunning(job)
	})
	const waiting = useDriveJobsStore(state => {
		const job = isJob ? state.jobs[transfer.id] : undefined

		return job !== undefined && isWaitingForArchiveSlot(job)
	})
	// What "Show in directory" opens: a landed upload's file or a job's own result (its archive, or the
	// first item it created), which the runners also set as the row's item.
	const jobItem = useDriveJobsStore(state => {
		const job = isJob && landed && transfer.item === undefined ? state.jobs[transfer.id] : undefined

		return job === undefined ? null : jobRevealItem(job)
	})
	// A stopped job's row stays active past its job while what it made moves to the trash, which can't be
	// paused or stopped.
	const trashing = active && jobEnded
	const rate = useTransferRate(transfer)
	const runningDetails = useRunningDetails()
	const revealItem = landed ? (transfer.item ?? jobItem ?? undefined) : undefined

	// The running line keeps its figures still without reserving space for them (useRunningDetails); a
	// finished row's figures no longer move, so they read plainly.
	let details: (string | null)[]

	if (trashing) {
		details = [t("transfersStatusMovingToTrash")]
	} else if (active && transfer.paused) {
		details = [t("transfersStatusPaused"), formatBytesFixed(transfer.bytesTransferred)]
	} else if (active && waiting) {
		details = [t("transfersStatusWaitingForSlot")]
	} else if (active) {
		details = [
			runningDetails({
				transferred: transfer.bytesTransferred,
				size: transfer.size,
				percent: progress,
				etaSeconds: rate?.etaSeconds ?? null,
				bytesPerSecond: rate?.bytesPerSecond ?? null
			}).full
		]
	} else if (transfer.status === "error") {
		details = [
			t(finishedStatusLabelKey(transfer.status, transfer.direction)),
			transfer.error === undefined ? null : errorLabel(transfer.error)
		]
	} else {
		details = [t(finishedStatusLabelKey(transfer.status, transfer.direction)), formatBytes(transfer.size)]
	}

	const icon = (
		<TransferIcon
			transfer={transfer}
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
				waiting={waiting}
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
				{hasJob && isDriveJobDirection(transfer.direction) ? (
					<TooltipIconButton
						label={t(jobDetailsLabelKey(transfer.direction))}
						className={ROW_ACTION_CLASS}
						onClick={() => {
							showJobToast(transfer.id)
						}}
					>
						<PanelBottomOpenIcon />
					</TooltipIconButton>
				) : null}
				{!active ? (
					<>
						{revealItem !== undefined ? (
							<TooltipIconButton
								label={t("transfersRowShowInDirectory")}
								className={ROW_ACTION_CLASS}
								onClick={() => {
									onShowInDirectory(revealItem)
								}}
							>
								<FolderSearchIcon />
							</TooltipIconButton>
						) : null}
						<TooltipIconButton
							label={t("transfersRowRemove")}
							className={ROW_ACTION_CLASS}
							onClick={() => {
								useTransfersStore.getState().remove(transfer.id)
								pruneSettledDriveJobs()
							}}
						>
							<XIcon />
						</TooltipIconButton>
					</>
				) : trashing ? null : (
					<>
						{transfer.browserManaged === true ? null : (
							<TooltipIconButton
								label={t(transfer.paused ? "transfersRowResume" : "transfersRowPause")}
								className={ROW_ACTION_CLASS}
								onClick={() => {
									setTransferPaused(transfer.id, !transfer.paused)
								}}
							>
								{transfer.paused ? <PlayIcon /> : <PauseIcon />}
							</TooltipIconButton>
						)}
						<TooltipIconButton
							label={t("transfersRowCancel")}
							className={ROW_ACTION_CLASS}
							onClick={() => {
								onRequestCancel(transfer)
							}}
						>
							<XIcon />
						</TooltipIconButton>
					</>
				)}
			</div>
		</li>
	)
}
