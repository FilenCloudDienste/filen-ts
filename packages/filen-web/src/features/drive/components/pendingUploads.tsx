import { useLayoutEffect, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { FilesIcon, XIcon } from "lucide-react"
import { cn, formatBytesFixed, formatBytesPerSecond, formatSecondsToMediaClock } from "@filen/shared"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import {
	percentFormat,
	runningPercentFraction,
	transferIconKey,
	transferProgress,
	transferRate
} from "@/features/transfers/components/transferRow.logic"
import {
	parsePendingRowKey,
	pendingCancelSubject,
	pendingFailedCount,
	pendingGroupProgress,
	pendingGroupSpeed,
	pendingRunFigures,
	pendingSummaryFigures,
	pendingSummarySamples,
	pendingUploadRowKeys,
	type PendingRowKey
} from "@/features/drive/lib/pendingUploads.logic"
import { cancelPendingRow, dismissPendingRow } from "@/features/drive/lib/pendingUploads"
import { GRID_INSET, ROW_HEIGHT, TILE_ROW_HEIGHT } from "@/features/drive/lib/gridLayout"
import { flushListingCreates } from "@/features/drive/queries/drive"
import type { DriveViewMode } from "@/features/drive/lib/preferences"
import { DirectoryGlyph, FileTypeIcon } from "@/features/drive/components/itemIcon"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

export interface PendingUploadsProps {
	parentUuid: string | null
	viewMode: DriveViewMode
	// The grid's column count, so pending tiles line up with the items' tiles below them.
	columns: number
}

type RowAction = (key: PendingRowKey) => void

// Uploads running into the directory on screen, pinned above its items (pendingUploads.logic.ts has the
// grouping). Outside the listbox, so they are no option, no index, no selection, drag or marquee target,
// and a progress tick re-renders only the row it moved. List rows are ROW_HEIGHT tall, tiles a full tile
// row, so the block's height only changes when a row comes or goes.
export function PendingUploads({ parentUuid, viewMode, columns }: PendingUploadsProps) {
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

	function handleDismiss(key: PendingRowKey): void {
		dismissPendingRow(key, parentUuid)
	}

	return (
		<div
			className={cn("shrink-0", viewMode === "list" && "border-b border-border/50")}
			style={viewMode === "grid" ? { padding: `${String(GRID_INSET)}px ${String(GRID_INSET)}px 0` } : undefined}
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
						onCancel={setCancelKey}
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
			return <PendingUploadRow {...props} />
		case "directory":
		case "failedDirectory":
			return <PendingDirectoryRow {...props} />
		case "uploading":
			return <PendingSummaryRow {...props} />
		case "failed":
			return <PendingFailedSummaryRow {...props} />
	}
}

// The running line, in the transfers screen's order and figures: done of total, percent, time left, and
// the speed last, as the one figure that keeps changing length.
function useRunningDetails(): (figures: {
	transferred: number
	size: number
	percent: number
	etaSeconds: number | null
	bytesPerSecond: number | null
}) => string {
	const { t, i18n } = useTranslation("transfers")

	return ({ transferred, size, percent, etaSeconds, bytesPerSecond }) =>
		[
			size > 0
				? t("transfersRowBytesProgress", { done: formatBytesFixed(transferred), total: formatBytesFixed(size) })
				: formatBytesFixed(transferred),
			size > 0 ? percentFormat(i18n.language).format(runningPercentFraction(percent)) : null,
			etaSeconds === null ? null : t("transfersRowTimeLeft", { eta: formatSecondsToMediaClock(etaSeconds) }),
			bytesPerSecond === null || bytesPerSecond <= 0 ? null : formatBytesPerSecond(bytesPerSecond)
		]
			.filter(part => part !== null)
			.join(" · ")
}

function useFailedDetails(): (error: ErrorDTO | undefined) => string {
	const { t } = useTranslation("transfers")

	return error => [t("transfersStatusError"), error === undefined ? null : errorLabel(error)].filter(part => part !== null).join(" · ")
}

function PendingUploadRow({ rowKey, viewMode, onCancel, onDismiss }: RowProps) {
	const { t } = useTranslation(["transfers", "drive"])
	const { kind, id } = parsePendingRowKey(rowKey)
	const transfer = useTransfersStore(state => state.transfers.find(candidate => candidate.id === id))
	const samples = useTransfersStore(state => state.rowSpeedSamples[id])
	const runningDetails = useRunningDetails()
	const failedDetails = useFailedDetails()

	if (transfer === undefined) {
		return null
	}

	const failed = kind === "failedUpload"
	const progress = transferProgress(transfer)
	const rate = transferRate(transfer, samples ?? [])
	const details = failed
		? failedDetails(transfer.error)
		: transfer.paused
			? [t("transfersStatusPaused"), formatBytesFixed(transfer.bytesTransferred)].join(" · ")
			: runningDetails({
					transferred: transfer.bytesTransferred,
					size: transfer.size,
					percent: progress,
					etaSeconds: rate?.etaSeconds ?? null,
					bytesPerSecond: rate?.bytesPerSecond ?? null
				})

	return (
		<PendingCell
			viewMode={viewMode}
			icon={className => (
				<FileTypeIcon
					iconKey={transferIconKey(transfer)}
					className={className}
				/>
			)}
			name={transfer.name}
			details={details}
			progress={failed ? null : progress}
			failed={failed}
			action={
				<TooltipIconButton
					label={failed ? t("drive:drivePendingUploadsDismiss") : t("transfersRowCancel")}
					className="text-muted-foreground hover:text-foreground"
					onClick={() => {
						if (failed) {
							onDismiss(rowKey)
						} else {
							onCancel(rowKey)
						}
					}}
				>
					<XIcon />
				</TooltipIconButton>
			}
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
					? failedDetails(error)
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
				<TooltipIconButton
					label={failed ? t("drive:drivePendingUploadsDismiss") : t("transfersRowCancel")}
					className="text-muted-foreground hover:text-foreground"
					onClick={() => {
						if (failed) {
							onDismiss(rowKey)
						} else {
							onCancel(rowKey)
						}
					}}
				>
					<XIcon />
				</TooltipIconButton>
			}
		/>
	)
}

function PendingSummaryRow({ rowKey, parentUuid, viewMode, onCancel }: RowProps) {
	const { t } = useTranslation(["drive", "transfers"])
	const figures = useTransfersStore(useShallow(state => pendingSummaryFigures(state, parentUuid)))
	const samples = useTransfersStore(useShallow(state => pendingSummarySamples(state, parentUuid)))
	const runningDetails = useRunningDetails()
	const speed = pendingGroupSpeed(samples)
	const { percent, etaSeconds } = pendingGroupProgress(figures, speed)

	return (
		<PendingCell
			viewMode={viewMode}
			icon={className => (
				<FilesIcon
					aria-hidden="true"
					className={cn(className, "text-muted-foreground")}
				/>
			)}
			name={t("drivePendingUploadsUploading", { count: figures.files })}
			details={runningDetails({
				transferred: figures.transferred,
				size: figures.bytes,
				percent,
				etaSeconds,
				bytesPerSecond: speed
			})}
			progress={percent}
			failed={false}
			action={
				<TooltipIconButton
					label={t("transfers:transfersRowCancel")}
					className="text-muted-foreground hover:text-foreground"
					onClick={() => {
						onCancel(rowKey)
					}}
				>
					<XIcon />
				</TooltipIconButton>
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
			details=""
			progress={null}
			failed
			action={
				<TooltipIconButton
					label={t("drivePendingUploadsDismiss")}
					className="text-muted-foreground hover:text-foreground"
					onClick={() => {
						onDismiss(rowKey)
					}}
				>
					<XIcon />
				</TooltipIconButton>
			}
		/>
	)
}

// The bar's fill is a transform, so a tick repaints it without laying anything out.
function ProgressLine({ progress, label, className }: { progress: number; label: string; className: string }) {
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(progress)}
			className={cn("overflow-hidden rounded-full bg-muted", className)}
		>
			<div
				className="h-full origin-left bg-primary transition-transform duration-300 ease-out"
				style={{ transform: `scaleX(${String(progress / 100)})` }}
			/>
		</div>
	)
}

// One pending row in either view: a list row the height of an item's row, or a tile the size of an item's
// tile. A failed one drops its bar and reads in red.
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
	details: string
	progress: number | null
	failed: boolean
	action: ReactNode
}) {
	const detailsClass = cn("truncate tabular-nums", failed ? "text-destructive" : "text-muted-foreground")

	if (viewMode === "list") {
		return (
			<li
				aria-label={name}
				className="relative flex shrink-0 items-center gap-3 px-3 text-sm"
				style={{ height: ROW_HEIGHT }}
			>
				{icon("size-6 shrink-0")}
				<span className={cn("min-w-0 flex-1 truncate", failed && "text-destructive")}>{name}</span>
				<span className={cn("max-w-[55%] shrink-0 text-right text-xs", detailsClass)}>{details}</span>
				{action}
				{progress === null ? null : (
					<ProgressLine
						progress={progress}
						label={name}
						className="absolute inset-x-3 bottom-0.5 h-0.5"
					/>
				)}
			</li>
		)
	}

	return (
		<li
			aria-label={name}
			className="flex w-44 flex-col gap-2 justify-self-center rounded-2xl p-2 text-center text-sm"
		>
			<div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-muted/40">
				{icon("size-14")}
				{progress === null ? null : (
					<ProgressLine
						progress={progress}
						label={name}
						className="absolute inset-x-3 bottom-3 h-1"
					/>
				)}
				<div className="absolute top-1 right-1">{action}</div>
			</div>
			<span className={cn("line-clamp-2 w-full text-xs break-words", failed && "text-destructive")}>{name}</span>
			<span className={cn("w-full text-[0.7rem]", detailsClass)}>{details}</span>
		</li>
	)
}

// The one confirm for whichever row's Cancel was pressed: the transfers screen's own for an upload or a
// directory, a count for the summary. Closes itself once there is nothing left to cancel.
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
	const subject = useTransfersStore(state => (rowKey === null ? null : pendingCancelSubject(state, rowKey, parentUuid)))

	return (
		<ConfirmDialog
			open={subject !== null}
			pending={false}
			title={typeof subject === "number" ? t("drive:drivePendingUploadsCancelAllTitle") : t("transfersRowCancelConfirmTitle")}
			body={
				typeof subject === "number"
					? t("drive:drivePendingUploadsCancelAllBody", { count: subject })
					: t("transfersRowCancelConfirmBody", { name: subject ?? "" })
			}
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
