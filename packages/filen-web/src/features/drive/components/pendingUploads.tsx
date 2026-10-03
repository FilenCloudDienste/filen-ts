import { useLayoutEffect, useState, type PointerEvent, type ReactNode, type Ref } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { ArrowUpIcon, FilesIcon, XIcon } from "lucide-react"
import { cn, formatBytesFixed, isWaitingForArchiveSlot } from "@filen/shared"
import { isDriveJobDirection, useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { activeStatusLabelKey, transferProgress } from "@/features/transfers/components/transferRow.logic"
import { TransferIcon } from "@/features/transfers/components/transferIcon"
import { useRunningDetails, useTransferRate, type RunningDetails } from "@/features/transfers/hooks/useTransferFigures"
import {
	parsePendingRowKey,
	pendingCancelSubject,
	pendingFailedCount,
	pendingGroupProgress,
	pendingGroupSpeed,
	pendingJobIds,
	pendingJobSpeed,
	pendingRunFigures,
	pendingSummaryFigures,
	pendingSummarySamples,
	pendingUploadRowKeys,
	type PendingCancelKept,
	type PendingGroupFigures,
	type PendingRowKey
} from "@/features/drive/lib/pendingUploads.logic"
import { cancelPendingRow, dismissPendingRow } from "@/features/drive/lib/pendingUploads"
import { TILE_ROW_HEIGHT } from "@/features/drive/lib/gridLayout"
import {
	LIST_NAME_CLASS,
	LIST_ROW_CLASS,
	LIST_SIZE_COLUMN_CLASS,
	LIST_TRAILING_SLOT_CLASS,
	TILE_CLASS,
	TILE_FACE_CLASS,
	TILE_NAME_CLASS,
	TILE_SUBLINE_CLASS
} from "@/features/drive/lib/listingCells"
import { flushListingCreates } from "@/features/drive/queries/drive"
import type { DriveViewMode } from "@/features/drive/lib/preferences"
import { DirectoryGlyph } from "@/features/drive/components/itemIcon"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

export interface PendingUploadsProps {
	parentUuid: string | null
	viewMode: DriveViewMode
	// The grid's column count, so pending tiles line up with the items' tiles below them.
	columns: number
	// The block's element, which the listing watches to pin the bar once it scrolls away.
	blockRef: Ref<HTMLDivElement>
}

type RowAction = (key: PendingRowKey) => void

// The rows sit in the listbox's scrolled layer but are no options: a press on them must not start the
// listbox's selection or marquee. Keys need no guard, since the listbox leaves keys on buttons alone.
function stopListboxPress(event: PointerEvent): void {
	event.stopPropagation()
}

// Uploads and drive jobs running into the directory on screen, as the first rows of its listing
// (pendingUploads.logic.ts has the grouping). They scroll with the items, above the virtualized rows,
// which start below them (the virtualizer's paddingStart); a progress tick re-renders only the row it
// moved. List rows are ROW_HEIGHT tall and tiles a full tile row, so the block's height only changes when
// a row comes or goes.
export function PendingUploads({ parentUuid, viewMode, columns, blockRef }: PendingUploadsProps) {
	const { t } = useTranslation("drive")
	const keys = useTransfersStore(useShallow(state => pendingUploadRowKeys(state, parentUuid)))
	// The row whose Cancel is being confirmed, kept here: a row that settles unmounts, and its confirm with it.
	const [cancelKey, setCancelKey] = useState<PendingRowKey | null>(null)
	const running = keys.some(key => !key.startsWith("failed"))
	const failed = keys.some(key => key.startsWith("failed"))

	// A landed upload reaches the listing with the next batched create flush (queueListingCreate), up to
	// a quarter second after its row went, and an emptied directory shows its empty state meanwhile.
	// Landing the queue as the rows change closes that gap. A summary row's files come and go without
	// changing the rows, so a big upload keeps its batching.
	useLayoutEffect(
		() => () => {
			flushListingCreates()
		},
		[keys]
	)

	function handleCancel(key: PendingRowKey): void {
		const { kind, id } = parsePendingRowKey(key)

		// A drive job asks through its own prompt, mounted once at the root.
		if (kind === "job") {
			useDriveJobsStore.getState().setCancelPromptId(id)
		} else {
			setCancelKey(key)
		}
	}

	function handleDismiss(key: PendingRowKey): void {
		dismissPendingRow(key, parentUuid)
	}

	return (
		<div
			ref={blockRef}
			className="absolute inset-x-0 top-0"
			onPointerDown={stopListboxPress}
		>
			<p
				role="status"
				className="sr-only"
			>
				{[running ? t("drivePendingUploadsRunningStatus") : null, failed ? t("drivePendingUploadsFailedStatus") : null]
					.filter(part => part !== null)
					.join(". ")}
			</p>
			<ul
				aria-label={t("drivePendingUploadsLabel")}
				className={viewMode === "list" ? "flex flex-col" : "grid"}
				style={
					viewMode === "grid"
						? { gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`, gridAutoRows: TILE_ROW_HEIGHT }
						: undefined
				}
			>
				{keys.map(key => (
					<PendingRow
						key={key}
						rowKey={key}
						parentUuid={parentUuid}
						viewMode={viewMode}
						onCancel={handleCancel}
						onDismiss={handleDismiss}
					/>
				))}
			</ul>
			<PendingCancelDialog
				parentUuid={parentUuid}
				rowKey={cancelKey !== null && keys.includes(cancelKey) ? cancelKey : null}
				onClose={() => {
					setCancelKey(null)
				}}
			/>
		</div>
	)
}

interface RowProps {
	rowKey: PendingRowKey
	parentUuid: string | null
	viewMode: DriveViewMode
	onCancel: RowAction
	onDismiss: RowAction
}

function PendingRow(props: RowProps) {
	switch (parsePendingRowKey(props.rowKey).kind) {
		case "upload":
		case "failedUpload":
		case "job":
			return <PendingTransferRow {...props} />
		case "directory":
		case "failedDirectory":
			return <PendingDirectoryRow {...props} />
		case "uploading":
			return <PendingSummaryRow {...props} />
		case "failed":
			return <PendingFailedSummaryRow {...props} />
	}
}

function useFailedDetails(): (error: ErrorDTO | undefined) => string {
	const { t } = useTranslation("transfers")

	return error => [t("transfersStatusError"), error === undefined ? null : errorLabel(error)].filter(part => part !== null).join(" · ")
}

// A failed row's figures: the one line, everywhere.
function failedLine(text: string): RunningDetails {
	return { full: text, percent: null, medium: text, short: text }
}

// The summary's figures, speed and progress, shared by its row and the pinned bar.
function usePendingSummary(parentUuid: string | null): { figures: PendingGroupFigures; details: RunningDetails; percent: number } {
	const figures = useTransfersStore(useShallow(state => pendingSummaryFigures(state, parentUuid)))
	const samples = useTransfersStore(useShallow(state => pendingSummarySamples(state, parentUuid)))
	const jobIds = useTransfersStore(useShallow(state => pendingJobIds(state, parentUuid)))
	const jobSpeed = useDriveJobsStore(state => pendingJobSpeed(state.jobs, jobIds))
	const runningDetails = useRunningDetails()
	const speed = pendingGroupSpeed(samples) + jobSpeed
	const { percent, etaSeconds } = pendingGroupProgress(figures, speed)

	return {
		figures,
		percent,
		details: runningDetails({ transferred: figures.transferred, size: figures.bytes, percent, etaSeconds, bytesPerSecond: speed })
	}
}

// Uploads only name their files; with drive jobs in, the count is of transfers.
function useSummaryLabel(): (figures: PendingGroupFigures) => string {
	const { t } = useTranslation("drive")

	return figures =>
		figures.jobs === 0
			? t("drivePendingUploadsUploading", { count: figures.files })
			: t("drivePendingTransfersRunning", { count: figures.files + figures.jobs })
}

function RowButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<TooltipIconButton
			label={label}
			className={cn(LIST_TRAILING_SLOT_CLASS, "text-muted-foreground hover:text-foreground")}
			onClick={onClick}
		>
			<XIcon />
		</TooltipIconButton>
	)
}

// One upload or drive job. A job's figures and glyph come off its job, as on the transfers screen.
function PendingTransferRow({ rowKey, viewMode, onCancel, onDismiss }: RowProps) {
	const { t } = useTranslation(["transfers", "drive"])
	const { kind, id } = parsePendingRowKey(rowKey)
	const transfer = useTransfersStore(state => state.transfers.find(candidate => candidate.id === id))

	if (transfer === undefined) {
		return null
	}

	const failed = kind === "failedUpload"

	return (
		<PendingTransferCell
			transfer={transfer}
			failed={failed}
			viewMode={viewMode}
			action={
				<RowButton
					label={failed ? t("drive:drivePendingUploadsDismiss") : t("transfersRowCancel")}
					onClick={() => {
						if (failed) {
							onDismiss(rowKey)
						} else {
							onCancel(rowKey)
						}
					}}
				/>
			}
		/>
	)
}

function PendingTransferCell({
	transfer,
	failed,
	viewMode,
	action
}: {
	transfer: Transfer
	failed: boolean
	viewMode: DriveViewMode
	action: ReactNode
}) {
	const { t } = useTranslation("transfers")
	const rate = useTransferRate(transfer)
	const waiting = useDriveJobsStore(state => {
		const job = isDriveJobDirection(transfer.direction) ? state.jobs[transfer.id] : undefined

		return job !== undefined && isWaitingForArchiveSlot(job)
	})
	const runningDetails = useRunningDetails()
	const failedDetails = useFailedDetails()
	const progress = transferProgress(transfer)
	let details: RunningDetails

	if (failed) {
		details = failedLine(failedDetails(transfer.error))
	} else if (transfer.paused) {
		const paused = t("transfersStatusPaused")

		details = {
			full: [paused, formatBytesFixed(transfer.bytesTransferred)].join(" · "),
			percent: paused,
			medium: paused,
			short: paused
		}
	} else if (transfer.size === 0 || waiting) {
		// Nothing to measure yet (a job still scanning, or queued for the page's one archive slot): say what
		// it is doing.
		const status = t(activeStatusLabelKey(transfer.direction, false, waiting))

		details = { full: status, percent: status, medium: status, short: status }
	} else {
		details = runningDetails({
			transferred: transfer.bytesTransferred,
			size: transfer.size,
			percent: progress,
			etaSeconds: rate?.etaSeconds ?? null,
			bytesPerSecond: rate?.bytesPerSecond ?? null
		})
	}

	return (
		<PendingCell
			viewMode={viewMode}
			icon={className => (
				<TransferIcon
					transfer={transfer}
					className={className}
				/>
			)}
			name={transfer.name}
			details={details}
			progress={failed ? null : progress}
			failed={failed}
			action={action}
		/>
	)
}

function PendingDirectoryRow({ rowKey, viewMode, onCancel, onDismiss }: RowProps) {
	const { t } = useTranslation(["transfers", "drive"])
	const { kind, id } = parsePendingRowKey(rowKey)
	const figures = useTransfersStore(useShallow(state => pendingRunFigures(state, id)))
	const name = useTransfersStore(state => state.uploadBatches[id]?.ref.directoryName ?? "")
	const error = useTransfersStore(state => state.uploadBatches[id]?.error)
	const samples = useTransfersStore(state => state.batchSpeedSamples[id])
	const runningDetails = useRunningDetails()
	const failedDetails = useFailedDetails()
	const failed = kind === "failedDirectory"
	const speed = samples === undefined ? 0 : pendingGroupSpeed([samples])
	const { percent, etaSeconds } = pendingGroupProgress(figures, speed)

	return (
		<PendingCell
			viewMode={viewMode}
			icon={className => (
				<DirectoryGlyph
					color="default"
					className={className}
				/>
			)}
			name={name}
			details={
				failed
					? failedLine(failedDetails(error))
					: runningDetails({
							transferred: figures.transferred,
							size: figures.bytes,
							percent,
							etaSeconds,
							bytesPerSecond: speed
						})
			}
			progress={failed ? null : percent}
			failed={failed}
			action={
				<RowButton
					label={failed ? t("drive:drivePendingUploadsDismiss") : t("transfersRowCancel")}
					onClick={() => {
						if (failed) {
							onDismiss(rowKey)
						} else {
							onCancel(rowKey)
						}
					}}
				/>
			}
		/>
	)
}

function PendingSummaryRow({ rowKey, parentUuid, viewMode, onCancel }: RowProps) {
	const { t } = useTranslation("transfers")
	const { figures, details, percent } = usePendingSummary(parentUuid)
	const summaryLabel = useSummaryLabel()

	return (
		<PendingCell
			viewMode={viewMode}
			icon={className => (
				<FilesIcon
					aria-hidden="true"
					className={cn(className, "text-muted-foreground")}
				/>
			)}
			name={summaryLabel(figures)}
			details={details}
			progress={percent}
			failed={false}
			action={
				<RowButton
					label={t("transfersRowCancel")}
					onClick={() => {
						onCancel(rowKey)
					}}
				/>
			}
		/>
	)
}

function PendingFailedSummaryRow({ rowKey, parentUuid, viewMode, onDismiss }: RowProps) {
	const { t } = useTranslation("drive")
	const count = useTransfersStore(state => pendingFailedCount(state, parentUuid))

	return (
		<PendingCell
			viewMode={viewMode}
			icon={className => (
				<FilesIcon
					aria-hidden="true"
					className={cn(className, "text-destructive")}
				/>
			)}
			name={t("drivePendingUploadsFailed", { count })}
			details={failedLine("")}
			progress={null}
			failed
			action={
				<RowButton
					label={t("drivePendingUploadsDismiss")}
					onClick={() => {
						onDismiss(rowKey)
					}}
				/>
			}
		/>
	)
}

// The progress, filling the row (left to right) or the tile's face (bottom to top) behind its content.
// A transform, so a tick repaints it without laying anything out.
function ProgressFill({ progress, label, axis }: { progress: number; label: string; axis: "x" | "y" }) {
	const fraction = String(progress / 100)

	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(progress)}
			className={cn(
				"absolute inset-0 -z-10 bg-primary/10 transition-transform duration-300 ease-out",
				axis === "x" ? "origin-left" : "origin-bottom"
			)}
			style={{ transform: axis === "x" ? `scaleX(${fraction})` : `scaleY(${fraction})` }}
		/>
	)
}

// One pending row in either view, laid out as an item's row or tile (listingCells.ts) so its columns sit
// under the header: the figures take the Size and Modified columns together, and only the percent where
// Modified is hidden. The name reads muted and the progress fills behind it; a failed one reads in red.
function PendingCell({
	viewMode,
	icon,
	name,
	details,
	progress,
	failed,
	action
}: {
	viewMode: DriveViewMode
	icon: (className: string) => ReactNode
	name: string
	details: RunningDetails
	progress: number | null
	failed: boolean
	action: ReactNode
}) {
	const tone = failed ? "text-destructive" : "text-muted-foreground"

	if (viewMode === "list") {
		return (
			<li
				aria-label={name}
				className={cn(LIST_ROW_CLASS, "relative isolate")}
			>
				{progress === null ? null : (
					<ProgressFill
						progress={progress}
						label={name}
						axis="x"
					/>
				)}
				{icon("size-6 shrink-0")}
				<span className={cn(LIST_NAME_CLASS, tone)}>{name}</span>
				<span className={cn(LIST_SIZE_COLUMN_CLASS, "truncate text-right text-xs tabular-nums lg:hidden", tone)}>
					{details.percent ?? details.short}
				</span>
				{/* The Size and Modified columns with the gap between them: w-20 + gap-3 + w-28. */}
				<span
					// The whole line, bytes included, for a pointer resting on the column.
					title={details.full}
					className={cn("hidden w-51 shrink-0 truncate text-right text-xs tabular-nums lg:block", tone)}
				>
					{details.medium}
				</span>
				{action}
			</li>
		)
	}

	return (
		<li
			aria-label={name}
			className={TILE_CLASS}
		>
			<div className={cn(TILE_FACE_CLASS, "isolate")}>
				{progress === null ? null : (
					<ProgressFill
						progress={progress}
						label={name}
						axis="y"
					/>
				)}
				{icon(cn("size-14", !failed && "opacity-60"))}
				<div className="absolute top-1 right-1">{action}</div>
			</div>
			<span className={cn(TILE_NAME_CLASS, tone)}>{name}</span>
			<span className={cn(TILE_SUBLINE_CLASS, "tabular-nums", tone)}>{details.short}</span>
		</li>
	)
}

// Pinned over the top of the listing while the rows are scrolled out of view: what they add up to, and a
// press brings them back. Running transfers first; with none, the failed count.
export function PendingUploadsBar({ parentUuid, onShow }: { parentUuid: string | null; onShow: () => void }) {
	const { t } = useTranslation("drive")
	const { figures, details, percent } = usePendingSummary(parentUuid)
	const failedCount = useTransfersStore(state => pendingFailedCount(state, parentUuid))
	const summaryLabel = useSummaryLabel()
	const running = figures.files + figures.jobs > 0

	return (
		<button
			type="button"
			aria-label={t("drivePendingShowTransfers")}
			onClick={onShow}
			className="absolute inset-x-0 top-0 isolate z-10 flex h-8 items-center gap-2 overflow-hidden border-b border-border/50 bg-background/90 px-3 text-xs shadow-sm focus-ring backdrop-blur-sm outline-none"
		>
			{running ? (
				<ProgressFill
					progress={percent}
					label={summaryLabel(figures)}
					axis="x"
				/>
			) : null}
			<ArrowUpIcon
				aria-hidden="true"
				className="size-3.5 shrink-0 text-muted-foreground"
			/>
			<span className={cn("min-w-0 flex-1 truncate text-left", !running && "text-destructive")}>
				{running ? summaryLabel(figures) : t("drivePendingUploadsFailed", { count: failedCount })}
			</span>
			{running ? <span className="hidden shrink-0 truncate text-muted-foreground tabular-nums sm:block">{details.full}</span> : null}
		</button>
	)
}

const KEPT_KEYS = {
	copied: "drive:drivePendingTransfersCancelKeptCopied",
	extracted: "drive:drivePendingTransfersCancelKeptExtracted",
	copiedOrExtracted: "drive:drivePendingTransfersCancelKeptCopiedOrExtracted"
} as const satisfies Record<NonNullable<PendingCancelKept>, string>

// The one confirm for whichever upload row's Cancel was pressed: the transfers screen's own for an upload
// or a directory, a count for the summary. Closes itself once there is nothing left to cancel.
function PendingCancelDialog({
	parentUuid,
	rowKey,
	onClose
}: {
	parentUuid: string | null
	rowKey: PendingRowKey | null
	onClose: () => void
}) {
	const { t } = useTranslation(["transfers", "drive"])
	const subject = useTransfersStore(useShallow(state => (rowKey === null ? null : pendingCancelSubject(state, rowKey, parentUuid))))
	let title: string = t("transfersRowCancelConfirmTitle")
	let body = ""

	if (subject !== null && "name" in subject) {
		body = t("transfersRowCancelConfirmBody", { name: subject.name })
	} else if (subject !== null) {
		title = t("drive:drivePendingUploadsCancelAllTitle")
		body =
			subject.jobs === 0
				? t("drive:drivePendingUploadsCancelAllBody", { count: subject.files })
				: [
						t("drive:drivePendingTransfersCancelAllBody", { count: subject.files + subject.jobs }),
						subject.kept === null ? null : t(KEPT_KEYS[subject.kept]),
						subject.archives === 0 ? null : t("drive:drivePendingTransfersCancelArchiveDiscarded", { count: subject.archives })
					]
						.filter(part => part !== null)
						.join(" ")
	}

	return (
		<ConfirmDialog
			open={subject !== null}
			pending={false}
			title={title}
			body={body}
			confirmLabel={t("transfersRowCancel")}
			cancelLabel={t("transfersCancelDialogDismiss")}
			destructive
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
			onConfirm={() => {
				if (rowKey !== null) {
					cancelPendingRow(rowKey, parentUuid)
				}

				onClose()
			}}
		/>
	)
}
