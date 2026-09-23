import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon, PauseIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react"
import { cn, formatBytes, formatSecondsToMediaClock } from "@filen/shared"
import { retryFailedCopy } from "@/features/drive/lib/copy"
import { pauseTransfer, resumeTransfer } from "@/features/transfers/lib/control"
import { useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import {
	COPY_CARD_ACTIVE_SHOWN,
	COPY_CARD_FAILURES_SHOWN,
	copyJobNotes,
	copyJobPercent,
	copyJobRate,
	copyJobStatus,
	copyJobTitle,
	isCopyJobRunning
} from "@/features/transfers/components/copyJobToast.logic"
import { type CopyJob } from "@/features/drive/lib/copy.logic"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

export interface CopyJobToastProps {
	jobId: string
	// The stack measures a custom toast only when its element is replaced, so the card asks for that.
	onHeightChange: () => void
	onDismiss: () => void
	// A retry is a new job with a card of its own, which supersedes this one.
	onRetried: (retryJobId: string) => void
}

// A copy job's progress card, rendered as a persistent toast (lib/copyToast.tsx). Everything shown is
// read live from the job's store entry, so the toast element itself never needs replacing to update.
export function CopyJobToast({ jobId, onHeightChange, onDismiss, onRetried }: CopyJobToastProps) {
	const { t, i18n } = useTranslation("transfers")
	const job = useCopyJobsStore(state => state.jobs[jobId])
	// The row's flag flips on click; the job's own flags follow once the SDK reports the pause.
	const rowPaused = useTransfersStore(state => state.transfers.find(transfer => transfer.id === jobId)?.paused ?? false)
	const [detailsOpen, setDetailsOpen] = useState(false)

	if (job === undefined) {
		return null
	}

	const running = isCopyJobRunning(job)
	const title = copyJobTitle(job)
	const percent = copyJobPercent(job)
	const rate = copyJobRate(job)
	const percentLabel =
		percent === null ? null : new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 0 }).format(percent / 100)
	const bytesLine = [
		job.totals.bytes > 0
			? t("transfersCopyBytesProgress", { done: formatBytes(job.counts.bytesDone), total: formatBytes(job.totals.bytes) })
			: null,
		rate === null ? null : t("transfersAggregateSpeed", { speed: formatBytes(rate.bytesPerSecond) }),
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
					<p className="min-w-0 flex-1 truncate font-medium">
						{title.key === "transfersCopyCardTitleEnded"
							? t(title.key, { destination: title.destination })
							: t(title.key, { count: title.count, destination: title.destination })}
					</p>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={t("transfersCopyCardDismiss")}
						onClick={onDismiss}
					>
						<XIcon />
					</Button>
				</div>
				<CopyJobStatusLine job={job} />
				<div className="flex items-center gap-2">
					<Progress
						value={percent}
						aria-label={t("transfersCopyProgressLabel")}
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
					{running ? (
						<>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={t(rowPaused ? "transfersRowResume" : "transfersRowPause")}
								disabled={job.cancelRequest !== null}
								onClick={() => {
									if (rowPaused) {
										resumeTransfer(jobId)
									} else {
										pauseTransfer(jobId)
									}
								}}
							>
								{rowPaused ? <PlayIcon /> : <PauseIcon />}
							</Button>
							<Button
								variant="outline"
								size="xs"
								disabled={job.cancelRequest !== null}
								onClick={() => {
									useCopyJobsStore.getState().setCancelPromptId(jobId)
								}}
							>
								{t("transfersRowCancel")}
							</Button>
						</>
					) : null}
				</div>
				{detailsOpen ? (
					<CopyJobDetails
						job={job}
						onRetried={onRetried}
					/>
				) : null}
				{running ? <p className="text-xs text-muted-foreground">{t("transfersCopyTabNote")}</p> : null}
			</div>
		</div>
	)
}

function CopyJobStatusLine({ job }: { job: CopyJob }) {
	const { t } = useTranslation("transfers")
	const status = copyJobStatus(job)
	const failed = job.outcome.status === "failed" || job.outcome.status === "quotaExceeded"
	let text: string

	switch (status.kind) {
		case "key":
			text = status.count === undefined ? t(status.key) : t(status.key, { count: status.count })

			break
		case "files":
			text = t("transfersCopyFilesProgress", { done: status.done, count: status.count })

			break
		case "error":
			text = status.label

			break
		case "quota":
			text = t("transfersCopyQuotaExceeded", { free: formatBytes(status.freeBytes) })

			break
	}

	return <p className={cn("text-xs", failed ? "text-destructive" : "text-muted-foreground")}>{text}</p>
}

function CopyJobDetails({ job, onRetried }: { job: CopyJob; onRetried: (retryJobId: string) => void }) {
	const { t } = useTranslation("transfers")
	const active = job.active.slice(0, COPY_CARD_ACTIVE_SHOWN)
	const failures = job.failures.slice(0, COPY_CARD_FAILURES_SHOWN)
	const moreFailures = job.failures.length - failures.length
	const notes = copyJobNotes(job)

	if (active.length === 0 && failures.length === 0 && notes.length === 0) {
		return <p className="border-t pt-2 text-xs text-muted-foreground">{t("transfersCopyNoDetails")}</p>
	}

	return (
		<div className="flex max-h-60 flex-col gap-3 overflow-y-auto border-t pt-2 text-xs">
			{active.length > 0 ? (
				<section className="flex flex-col gap-1">
					<h3 className="font-medium">{t("transfersCopyCurrentFiles")}</h3>
					<ul className="flex flex-col gap-0.5 text-muted-foreground">
						{active.map(file => (
							<li
								key={file.destUuid}
								className="flex gap-2"
							>
								<span className="min-w-0 flex-1 truncate">{file.name}</span>
								<span className="shrink-0 tabular-nums">
									{formatBytes(file.bytesDone)} / {formatBytes(file.size)}
								</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
			{failures.length > 0 ? (
				<section className="flex flex-col gap-1">
					<h3 className="font-medium">{t("transfersCopyFailures")}</h3>
					<ul className="flex flex-col gap-1">
						{failures.map(failure => (
							<li
								key={`${failure.sourceUuid}:${failure.destName}`}
								className="flex flex-col"
							>
								<span className="truncate">{failure.sourcePath}</span>
								<span className="truncate text-destructive">{failure.error.label}</span>
							</li>
						))}
					</ul>
					{moreFailures > 0 ? (
						<p className="text-muted-foreground">{t("transfersCopyMoreFailures", { count: moreFailures })}</p>
					) : null}
					{job.outcome.status !== "running" && job.retryable.length > 0 ? (
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
