import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRightIcon, FolderSearchIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react"
import {
	cn,
	compressReportSections,
	defaultCollapsedSections,
	extractReportSections,
	flattenReportSections,
	type JobReportLine,
	type JobReportSection
} from "@filen/shared"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { hideJobToast, showJobToast } from "@/features/transfers/lib/jobToast"
import { compressJobTitle, extractJobSummary, extractJobTitle } from "@/features/transfers/components/archiveJobToast.logic"
import {
	lineHeight,
	lineKey,
	noteText,
	reportRowPath,
	sectionCount,
	sectionTitleKey
} from "@/features/transfers/components/jobReport.logic"
import { jobHasReport, jobRevealItem, type DriveJob } from "@/features/drive/lib/driveJobs.logic"
import { canRetryExtract, type CompressJob, type ExtractJob } from "@/features/drive/lib/archiveJobs.logic"
import { retryFailedExtract } from "@/features/drive/lib/archiveJobs"
import { defaultRevealDeps, runOpenContainingDirectory } from "@/features/drive/lib/reveal"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { MiddleEllipsis } from "@/components/middleEllipsis"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

type ArchiveJob = CompressJob | ExtractJob
type Line = JobReportLine<ErrorDTO>

const OVERSCAN = 10

function reportJob(job: DriveJob | undefined): ArchiveJob | null {
	return job !== undefined && job.kind !== "copy" && jobHasReport(job) ? job : null
}

// The report of an archive job (what it skipped, renamed, could not do, and what became of the originals),
// opened from its card or transfers row and mounted once at the root beside the toasts. Its body exists
// only while the dialog shows: a report can run to thousands of lines.
export function JobReportDialog() {
	const job = useDriveJobsStore(state => reportJob(state.reportJobId === null ? undefined : state.jobs[state.reportJobId]))
	// The last report shown keeps its lines through the exit animation; dropped once that ends.
	const [shown, setShown] = useState<ArchiveJob | null>(job)

	if (job !== null && job !== shown) {
		setShown(job)
	}

	const view = job ?? shown

	function close(): void {
		useDriveJobsStore.getState().setReportJobId(null)
	}

	return (
		<Dialog
			open={job !== null}
			onOpenChange={next => {
				if (!next) {
					close()
				}
			}}
			onOpenChangeComplete={opened => {
				if (!opened) {
					setShown(null)

					// A job that left the store closed the report; its id must not reopen it later.
					if (view !== null && useDriveJobsStore.getState().reportJobId === view.id) {
						close()
					}
				}
			}}
		>
			<DialogContent className="sm:max-w-lg">
				{view === null ? null : (
					<JobReportBody
						key={view.id}
						job={view}
						onClose={close}
					/>
				)}
			</DialogContent>
		</Dialog>
	)
}

function JobReportBody({ job, onClose }: { job: ArchiveJob; onClose: () => void }) {
	const { t } = useTranslation(["archive", "transfers", "common"])
	const { t: tTransfers } = useTranslation("transfers")
	const navigate = useNavigate()
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	// Memoized by hand (useVirtualizer opts this component out of the React Compiler): sections are built
	// once per job object, flattened once per toggle, and the virtualizer's callbacks change only with them.
	const sections = useMemo(
		() => (job.kind === "extract" ? extractReportSections(job) : compressReportSections(job, uuid => job.sourceNames[uuid])),
		[job]
	)
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => defaultCollapsedSections(sections))
	const lines = useMemo(() => flattenReportSections(sections, collapsed), [sections, collapsed])
	const getItemKey = useCallback(
		(index: number) => {
			const line = lines[index]

			return line === undefined ? index : lineKey(line)
		},
		[lines]
	)
	const estimateSize = useCallback(
		(index: number) => {
			const line = lines[index]

			return line === undefined ? 0 : lineHeight(line)
		},
		[lines]
	)

	const virtualizer = useVirtualizer({
		count: lines.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize,
		overscan: OVERSCAN,
		getItemKey
	})

	const title = job.kind === "extract" ? extractJobTitle(job) : compressJobTitle(job)
	const summary = job.kind === "extract" ? extractJobSummary(job) : null
	const revealItem = jobRevealItem(job)
	const retryable = job.kind === "extract" && canRetryExtract(job)
	const misleading = sections.some(section => section.kind === "misleadingNames")

	const toggle = useCallback((key: string) => {
		setCollapsed(previous => {
			const next = new Set(previous)

			if (!next.delete(key)) {
				next.add(key)
			}

			return next
		})
	}, [])
	// A new job takes over the failures, and its card the place of this one's.
	const retryFailed = useCallback(() => {
		const retryJobId = retryFailedExtract(job.id)

		if (retryJobId === null) {
			return
		}

		onClose()
		hideJobToast(job.id)
		showJobToast(retryJobId)
	}, [job.id, onClose])

	return (
		<>
			<DialogHeader>
				<DialogTitle>{t("archiveReportTitle")}</DialogTitle>
				<DialogDescription>
					{tTransfers(title.key, title.values)}
					{summary === null ? null : (
						<>
							<br />
							<span className="tabular-nums">{tTransfers("transfersExtractSummary", summary)}</span>
						</>
					)}
				</DialogDescription>
			</DialogHeader>
			{misleading ? (
				<p className="flex items-start gap-1.5 text-xs text-muted-foreground">
					<TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-amber-500" />
					<span className="min-w-0 flex-1">{t("archiveReportMisleadingExplain")}</span>
				</p>
			) : null}
			<div
				ref={setScrollElement}
				className="h-96 overflow-y-auto"
			>
				<div
					className="relative w-full"
					style={{ height: virtualizer.getTotalSize() }}
				>
					{virtualizer.getVirtualItems().map(virtualRow => {
						const line = lines[virtualRow.index]

						if (line === undefined) {
							return null
						}

						return (
							<div
								key={virtualRow.key}
								className="absolute top-0 left-0 w-full"
								style={{ height: virtualRow.size, transform: `translateY(${String(virtualRow.start)}px)` }}
							>
								<ReportLine
									line={line}
									collapsed={line.type === "heading" && collapsed.has(line.section.key)}
									retryable={retryable}
									onToggle={toggle}
									onRetry={retryFailed}
								/>
							</div>
						)
					})}
				</div>
			</div>
			<DialogFooter>
				{revealItem === null ? null : (
					<Button
						variant="outline"
						onClick={() => {
							onClose()
							void runOpenContainingDirectory(defaultRevealDeps, revealItem, target => {
								void navigate(target)
							})
						}}
					>
						<FolderSearchIcon data-icon="inline-start" />
						{t("transfers:transfersRowShowInDirectory")}
					</Button>
				)}
				<Button onClick={onClose}>{t("common:close")}</Button>
			</DialogFooter>
		</>
	)
}

function ReportLine({
	line,
	collapsed,
	retryable,
	onToggle,
	onRetry
}: {
	line: Line
	collapsed: boolean
	retryable: boolean
	onToggle: (key: string) => void
	onRetry: () => void
}) {
	const { t } = useTranslation(["archive", "transfers"])

	switch (line.type) {
		case "heading":
			return (
				<ReportHeading
					section={line.section}
					collapsed={collapsed}
					retryable={retryable}
					onToggle={onToggle}
					onRetry={onRetry}
				/>
			)
		case "row": {
			const { row } = line
			const note = noteText(row.note, t)
			const path = reportRowPath(row)

			return (
				<div className="flex h-full min-w-0 flex-col justify-center pl-8 text-sm">
					<MiddleEllipsis
						value={path}
						start={28}
						end={28}
						className="truncate"
					/>
					{note === null ? null : (
						<span className={cn("truncate text-xs", row.note?.type === "error" ? "text-destructive" : "text-muted-foreground")}>
							{note}
						</span>
					)}
				</div>
			)
		}
		case "omitted":
			return (
				<p className="flex h-full items-center pl-8 text-xs text-muted-foreground">
					{t("archiveReportOmitted", { count: line.count })}
				</p>
			)
	}
}

function ReportHeading({
	section,
	collapsed,
	retryable,
	onToggle,
	onRetry
}: {
	section: JobReportSection<ErrorDTO>
	collapsed: boolean
	retryable: boolean
	onToggle: (key: string) => void
	onRetry: () => void
}) {
	const { t } = useTranslation("archive")

	return (
		<div className="flex h-full items-center gap-2">
			<Button
				variant="ghost"
				size="sm"
				className="min-w-0 flex-1 justify-start"
				aria-expanded={!collapsed}
				onClick={() => {
					onToggle(section.key)
				}}
			>
				<ChevronRightIcon
					data-icon="inline-start"
					className={cn("transition-transform", !collapsed && "rotate-90")}
				/>
				<span className="truncate font-medium">{t(sectionTitleKey(section))}</span>
				<span className="shrink-0 text-muted-foreground tabular-nums">{sectionCount(section)}</span>
			</Button>
			{section.kind === "failed" && retryable ? (
				<Button
					variant="outline"
					size="xs"
					onClick={onRetry}
				>
					<RotateCcwIcon data-icon="inline-start" />
					{t("archiveReportRetryFailed")}
				</Button>
			) : null}
		</div>
	)
}
