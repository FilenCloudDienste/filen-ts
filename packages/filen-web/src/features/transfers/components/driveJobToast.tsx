import { useState, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import {
	ChevronRightIcon,
	FileTextIcon,
	FolderSearchIcon,
	KeyRoundIcon,
	PauseIcon,
	PlayIcon,
	RotateCcwIcon,
	TriangleAlertIcon,
	XIcon
} from "lucide-react"
import { cn, formatBytes, formatBytesPerSecond, formatSecondsToMediaClock, pausedJobBlocksSlot } from "@filen/shared"
import { retryFailedCopy } from "@/features/drive/lib/copy"
import { rerunCompress, retryFailedExtract } from "@/features/drive/lib/archiveJobs"
import { setTransferPaused } from "@/features/transfers/lib/control"
import { promptExtractPassword } from "@/features/transfers/lib/extractPasswordPrompt"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { jobCardModel, type JobCardKeyStatus, type JobCardModel } from "@/features/transfers/components/driveJobCard.logic"
import { percentFormat } from "@/features/transfers/components/transferRow.logic"
import { type DriveJob } from "@/features/drive/lib/driveJobs.logic"
import { type DriveItem } from "@/features/drive/lib/item"
import { defaultRevealDeps, runOpenContainingDirectory } from "@/features/drive/lib/reveal"
import { errorLabelOr } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

export interface DriveJobToastProps {
	jobId: string
	// The stack measures a custom toast only when its element is replaced, so the card asks for that.
	onHeightChange: () => void
	onDismiss: () => void
	// A retry is a new job with a card of its own, which supersedes this one.
	onRetried: (retryJobId: string) => void
	// Opens the directory `item` landed in, with it selected. Navigation is the caller's.
	onShowDirectory: (item: DriveItem) => void
}

// A drive job's (copy, compress, extract) progress card, rendered as a persistent toast (lib/jobToast.tsx).
// Everything shown is read live from the job's store entry, so the toast element itself never needs
// replacing to update.
export function DriveJobToast({ jobId, onHeightChange, onDismiss, onRetried, onShowDirectory }: DriveJobToastProps) {
	const { t, i18n } = useTranslation("transfers")
	const job = useDriveJobsStore(state => state.jobs[jobId])
	// The row's flag flips on click; the job's own flags follow once the SDK reports the pause.
	const rowPaused = useTransfersStore(state => state.transfers.find(transfer => transfer.id === jobId)?.paused ?? false)
	// Only a paused job can hold the slot that way, so nothing else is looked at for a running one.
	const slotHeldWhilePaused = useDriveJobsStore(state => {
		const own = state.jobs[jobId]

		return own !== undefined && own.paused && pausedJobBlocksSlot(Object.values(state.jobs), jobId)
	})
	const [detailsOpen, setDetailsOpen] = useState(false)

	if (job === undefined) {
		return null
	}

	const model = jobCardModel(job, { slotHeldWhilePaused })
	const { actions, rate } = model
	const percentLabel = model.percent === null ? null : percentFormat(i18n.language).format(model.percent / 100)
	const bytesLine = [
		model.bytes === null
			? null
			: t("transfersCopyBytesProgress", {
					done: formatBytes(model.bytes.done),
					total: formatBytes(model.bytes.total)
				}),
		rate === null ? null : formatBytesPerSecond(rate.bytesPerSecond),
		rate?.etaSeconds == null ? null : t("transfersCopyEta", { eta: formatSecondsToMediaClock(rate.etaSeconds) })
	]
		.filter(part => part !== null)
		.join(" · ")

	return (
		<div
			// Stacked behind another toast, the box shrinks to the front toast's height and its content fades,
			// as sonner does for its own styled toasts (it leaves a custom one's content alone).
			className="w-full overflow-hidden rounded-(--border-radius) border bg-popover text-sm text-popover-foreground shadow-lg min-[601px]:w-(--width) [[data-sonner-toast][data-expanded=false][data-front=false]_&]:pointer-events-none [[data-sonner-toast][data-expanded=false][data-front=false]_&]:max-h-(--front-toast-height)"
		>
			<div
				// The content, not the box: stacking clips the box to its slot, which is no change of the card.
				ref={element => {
					if (element === null) {
						return undefined
					}

					let height = element.offsetHeight
					const observer = new ResizeObserver(() => {
						if (element.offsetHeight !== height) {
							height = element.offsetHeight
							onHeightChange()
						}
					})

					observer.observe(element)

					return () => {
						observer.disconnect()
					}
				}}
				className="flex flex-col gap-2 p-4 transition-opacity duration-400 [[data-sonner-toast][data-expanded=false][data-front=false]_&]:opacity-0"
			>
				<div className="flex items-start gap-2">
					<p className="min-w-0 flex-1 truncate font-medium">{t(model.title.key, model.title.values)}</p>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={t(model.labels.dismiss)}
						onClick={onDismiss}
					>
						<XIcon />
					</Button>
				</div>
				<JobStatusLine model={model} />
				{model.summary === null ? null : (
					<p className="text-xs text-muted-foreground tabular-nums">
						{t("transfersExtractSummary", {
							extracted: model.summary.extracted,
							skipped: model.summary.skipped,
							failed: model.summary.failed
						})}
					</p>
				)}
				{model.warnings.map(warning => (
					<p
						key={warning.key}
						className="flex items-start gap-1.5 text-xs text-muted-foreground"
					>
						<TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-amber-500" />
						<span className="min-w-0 flex-1">{t(warning.key, { count: warning.count })}</span>
					</p>
				))}
				<div className="flex items-center gap-2">
					<Progress
						value={model.percent}
						aria-label={t(model.labels.progress)}
						className="min-w-0 flex-1 gap-0"
					/>
					{percentLabel === null ? null : (
						<span className="shrink-0 text-xs text-muted-foreground tabular-nums">{percentLabel}</span>
					)}
				</div>
				{bytesLine.length > 0 ? <p className="truncate text-xs text-muted-foreground tabular-nums">{bytesLine}</p> : null}
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="xs"
						aria-expanded={detailsOpen}
						onClick={() => {
							setDetailsOpen(open => !open)
						}}
					>
						<ChevronRightIcon
							data-icon="inline-start"
							className={cn("transition-transform", detailsOpen && "rotate-90")}
						/>
						{t("transfersCopyDetails")}
					</Button>
					<div className="flex-1" />
					{actions.pauseCancel ? (
						<>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={t(rowPaused ? "transfersRowResume" : "transfersRowPause")}
								disabled={job.cancelRequest !== null}
								onClick={() => {
									setTransferPaused(jobId, !rowPaused)
								}}
							>
								{rowPaused ? <PlayIcon /> : <PauseIcon />}
							</Button>
							<Button
								variant="outline"
								size="xs"
								disabled={job.cancelRequest !== null}
								onClick={event => {
									leaveToaster(event)
									useDriveJobsStore.getState().setCancelPromptId(jobId)
								}}
							>
								{t("transfersRowCancel")}
							</Button>
						</>
					) : (
						<JobResultActions
							job={job}
							actions={actions}
							onRetried={onRetried}
							onShowDirectory={onShowDirectory}
						/>
					)}
				</div>
				{detailsOpen ? (
					<JobDetails
						job={job}
						model={model}
						onRetried={onRetried}
					/>
				) : null}
				{actions.pauseCancel ? <p className="text-xs text-muted-foreground">{t(model.labels.tabNote)}</p> : null}
			</div>
		</div>
	)
}

// The card as the toast stack renders it: inside the router (the Toaster is mounted at the root), so its
// Show in directory navigates.
export function RoutedDriveJobToast(props: Omit<DriveJobToastProps, "onShowDirectory">) {
	const navigate = useNavigate()

	return (
		<DriveJobToast
			{...props}
			onShowDirectory={item => {
				void runOpenContainingDirectory(defaultRevealDeps, item, target => {
					void navigate(target)
				})
			}}
		/>
	)
}

// Sonner's toaster hands focus back to whatever held it before the toaster whenever focus leaves it, which
// would pull focus straight back out of a dialog a card button opens. Leaving first lets that happen
// before the dialog takes focus.
function leaveToaster(event: MouseEvent<HTMLElement>): void {
	event.currentTarget.blur()
}

function JobStatusLine({ model }: { model: JobCardModel }) {
	const { t } = useTranslation("transfers")
	const { status } = model
	const keyText = (keyStatus: JobCardKeyStatus): string =>
		keyStatus.count === undefined ? t(keyStatus.key) : t(keyStatus.key, { count: keyStatus.count })
	let text: string

	switch (status.kind) {
		case "key":
			text = keyText(status)

			break
		case "files":
			text = t("transfersCopyFilesProgress", { done: status.done, count: status.count })

			break
		case "listing":
			text = t("transfersCompressPhaseListing", { done: status.done, count: status.count })

			break
		case "error":
			text = errorLabelOr(status.error, t("transfersCopyErrorGeneric"))

			break
		case "quota":
			text =
				status.neededBytes === null
					? t("transfersArchiveQuotaUnknown", { free: formatBytes(status.freeBytes) })
					: t(model.labels.quota, { needed: formatBytes(status.neededBytes), free: formatBytes(status.freeBytes) })

			break
		case "password":
			text = t(status.wrong ? "transfersExtractWrongPassword" : "transfersExtractPasswordRequired")

			break
	}

	return (
		<>
			<p className={cn("text-xs", model.statusFailed ? "text-destructive" : "text-muted-foreground")}>{text}</p>
			{status.kind === "error" && status.trash !== undefined ? (
				<p className="text-xs text-muted-foreground">{keyText(status.trash)}</p>
			) : null}
		</>
	)
}

// What a settled archive job offers; a copy offers its retry beside its failures only, where an extract's
// shows here, without opening the details first.
function JobResultActions({
	job,
	actions,
	onRetried,
	onShowDirectory
}: {
	job: DriveJob
	actions: JobCardModel["actions"]
	onRetried: (retryJobId: string) => void
	onShowDirectory: (item: DriveItem) => void
}) {
	const { t } = useTranslation("transfers")
	const { showDirectory } = actions
	const jobId = job.id

	return (
		<>
			{showDirectory === null ? null : (
				<Button
					variant="ghost"
					size="xs"
					onClick={() => {
						onShowDirectory(showDirectory)
					}}
				>
					<FolderSearchIcon data-icon="inline-start" />
					{t("transfersRowShowInDirectory")}
				</Button>
			)}
			{actions.report ? (
				<Button
					variant="ghost"
					size="xs"
					onClick={event => {
						leaveToaster(event)
						useDriveJobsStore.getState().setReportJobId(jobId)
					}}
				>
					<FileTextIcon data-icon="inline-start" />
					{t("transfersJobViewReport")}
				</Button>
			) : null}
			{actions.password ? (
				<Button
					variant="outline"
					size="xs"
					onClick={event => {
						leaveToaster(event)
						promptExtractPassword(jobId)
					}}
				>
					<KeyRoundIcon data-icon="inline-start" />
					{t("transfersJobEnterPassword")}
				</Button>
			) : null}
			{actions.retry === "rerun" ? (
				<Button
					variant="outline"
					size="xs"
					onClick={() => {
						const retryJobId = rerunCompress(jobId)

						if (retryJobId !== null) {
							onRetried(retryJobId)
						}
					}}
				>
					<RotateCcwIcon data-icon="inline-start" />
					{t("transfersJobRerun")}
				</Button>
			) : null}
			{actions.retry === "failed" && job.kind === "extract" ? (
				<Button
					variant="outline"
					size="xs"
					onClick={() => {
						const retryJobId = retryFailedExtract(jobId)

						if (retryJobId !== null) {
							onRetried(retryJobId)
						}
					}}
				>
					<RotateCcwIcon data-icon="inline-start" />
					{t("transfersCopyRetryFailed")}
				</Button>
			) : null}
		</>
	)
}

function JobDetails({ job, model, onRetried }: { job: DriveJob; model: JobCardModel; onRetried: (retryJobId: string) => void }) {
	const { t } = useTranslation("transfers")
	const { active, failures, moreFailures } = model.details
	const { notes } = model

	if (active.length === 0 && failures.length === 0 && notes.length === 0) {
		return <p className="border-t pt-2 text-xs text-muted-foreground">{t("transfersCopyNoDetails")}</p>
	}

	return (
		<div className="flex max-h-60 flex-col gap-3 overflow-y-auto border-t pt-2 text-xs">
			{active.length > 0 ? (
				<section className="flex flex-col gap-1">
					<h3 className="font-medium">{t(model.labels.current)}</h3>
					<ul className="flex flex-col gap-0.5 text-muted-foreground">
						{active.map(file => (
							<li
								key={file.key}
								className="flex gap-2"
							>
								<span className="min-w-0 flex-1 truncate">{file.name}</span>
								<span className="shrink-0 tabular-nums">
									{file.size === null ? (
										formatBytes(file.done)
									) : (
										<>
											{formatBytes(file.done)} / {formatBytes(file.size)}
										</>
									)}
								</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
			{failures.length > 0 ? (
				<section className="flex flex-col gap-1">
					<h3 className="font-medium">{t(model.labels.failures)}</h3>
					<ul className="flex flex-col gap-1">
						{failures.map(failure => (
							<li
								key={failure.key}
								className="flex flex-col"
							>
								<span className="truncate">{failure.path}</span>
								<span className="truncate text-destructive">
									{errorLabelOr(failure.error, t("transfersCopyErrorGeneric"))}
								</span>
							</li>
						))}
					</ul>
					{moreFailures > 0 ? (
						<p className="text-muted-foreground">{t("transfersCopyMoreFailures", { count: moreFailures })}</p>
					) : null}
					{model.actions.retry === "failed" && job.kind === "copy" ? (
						<Button
							variant="outline"
							size="xs"
							className="self-start"
							onClick={() => {
								const retryJobId = retryFailedCopy(job.id)

								if (retryJobId !== null) {
									onRetried(retryJobId)
								}
							}}
						>
							<RotateCcwIcon data-icon="inline-start" />
							{t("transfersCopyRetryFailed")}
						</Button>
					) : null}
				</section>
			) : null}
			{notes.length > 0 ? (
				<ul className="flex flex-col gap-1 text-muted-foreground">
					{notes.map(note => (
						<li key={note.key}>{t(note.key, { count: note.count })}</li>
					))}
				</ul>
			) : null}
		</div>
	)
}
