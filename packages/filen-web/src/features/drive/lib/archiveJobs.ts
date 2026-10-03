import * as Comlink from "comlink"
import {
	addItemCounts,
	applyCompressUpdate,
	applyExtractUpdate,
	compressJobRowFigures,
	copyMaxBytes,
	extractJobRowFigures,
	formatBytes,
	groupExtractRetries,
	isCompressPreflightRefusal,
	isExtractPreflightRefusal,
	isJobRunning,
	mergeExtractReports,
	rewindCompressEvents,
	rewindExtractEvents,
	settleCompressJob,
	settleExtractJob,
	summarizeDispositions,
	toItemCounts,
	type CompressUpdateInput,
	type CopyJobCounts,
	type ExtractUpdateInput,
	type JobDisposition,
	type JobOutcome,
	type JobRowFigures,
	type QuotaCheckDeps
} from "@filen/shared"
import type { AnyNormalDir } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { runOp } from "@/lib/actions/outcome"
import { asErrorDTO, plainErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { CompressReportDTO, ExtractReportDTO } from "@/lib/sdk/jobErrors"
import type { CompressJobEvent, CompressJobParams, ExtractEntriesJobParams, ExtractJobEvent, ExtractJobParams } from "@/workers/sdk.worker"
import { asDirectoryOrFile, narrowItem, narrowToSdkItems, type DriveItem } from "@/features/drive/lib/item"
import { normalizeParentUuid } from "@/features/drive/queries/drive"
import { currentRootUuid, trashItems } from "@/features/drive/lib/actions"
import { type BulkOutcome } from "@/lib/actions/bulk"
import { applyItemDeleted, applyItemTrashed } from "@/features/drive/lib/socketHandlers"
import { accountQuotaDeps } from "@/features/drive/lib/quota"
import {
	addTrashOutcome,
	afterDriveJobSettled,
	directoriesBetween,
	liesWithin,
	patchJobCreatedItem,
	pruneSettledDriveJobs,
	readFreshAccount,
	STOPPED,
	type JobSettledEffects
} from "@/features/drive/lib/driveJobs"
import { holdJobPassword, jobPassword } from "@/features/drive/lib/jobSecrets"
import {
	canRerunCompress,
	canRetryExtract,
	compressReportInput,
	compressUpdateInput,
	createWebCompressJob,
	createWebExtractJob,
	extractedTopLevel,
	extractReportInput,
	extractUpdateInput,
	isExtractTrashPending,
	type CompressJob,
	type CompressJobRequest,
	type CompressJobSettlement,
	type ExtractCall,
	type ExtractJob,
	type ExtractJobReport,
	type ExtractJobRequest,
	type ExtractJobSettlement
} from "@/features/drive/lib/archiveJobs.logic"
import { useTransfersStore, type TransfersStore } from "@/features/transfers/store/useTransfersStore"
import { getJobOf, jobsAccess, useDriveJobsStore, type JobsAccess } from "@/features/transfers/store/useDriveJobsStore"

// A compress or an extract runs as SDK jobs with one transfers row, as a copy does (copy.ts): the SDK
// owns the archive, its codecs, the page's one archive slot and removing the sources; this feeds the
// progress into the stores and patches the listings with what the job made and removed.

export type { CompressJobRequest, CompressSource, ExtractCall, ExtractJobRequest } from "@/features/drive/lib/archiveJobs.logic"

type OnCompressEvent = (event: CompressJobEvent) => void
type OnExtractEvent = (event: ExtractJobEvent) => void

export interface RunArchiveDeps {
	compressItems: (
		id: string,
		params: CompressJobParams,
		password: string | undefined,
		onEvent: OnCompressEvent
	) => Promise<CompressReportDTO>
	extractArchive: (
		id: string,
		params: ExtractJobParams,
		password: string | undefined,
		onEvent: OnExtractEvent
	) => Promise<ExtractReportDTO>
	extractArchiveEntries: (
		id: string,
		params: ExtractEntriesJobParams,
		password: string | undefined,
		onEvent: OnExtractEvent
	) => Promise<ExtractReportDTO>
	// Frees the worker's stop and pause for the job, which span its calls.
	release: (id: string) => void
	transfers: Pick<TransfersStore, "add" | "setProgress" | "setSize" | "setPaused" | "settle" | "remove" | "setItem">
	compressJobs: JobsAccess<CompressJob>
	extractJobs: JobsAccess<ExtractJob>
	account: QuotaCheckDeps
	patchCreated: (item: DriveItem) => void
	// Takes items the job removed out of the listings, ahead of the socket's echo.
	patchLeft: (uuids: readonly string[], how: "trash" | "delete", kind: "file" | "directory") => void
	trash: (items: DriveItem[]) => Promise<BulkOutcome<DriveItem>>
	settled: (job: CompressJob | ExtractJob, effects: JobSettledEffects) => void
}

type Row = Parameters<RunArchiveDeps["transfers"]["add"]>[0]

// The row's size and progress, written only when they moved: a paused, scanning or waiting job reports
// the same figures five times a second.
function rowFiguresWriter(transfers: RunArchiveDeps["transfers"], id: string): (figures: JobRowFigures) => void {
	let size = 0
	let shown = 0

	return figures => {
		if (figures.size !== size) {
			size = figures.size
			transfers.setSize(id, size)
		}

		if (figures.shown !== shown) {
			shown = figures.shown
			transfers.setProgress(id, shown)
		}
	}
}

function jobRow(id: string, direction: "compress" | "extract", name: string, destinationUuid: string | null): Row {
	return {
		id,
		direction,
		name,
		size: 0,
		bytesTransferred: 0,
		status: direction === "compress" ? "compressing" : "extracting",
		// Keyed as the destination's listing is (null for the root), so its pending row finds it.
		parentUuid: normalizeParentUuid(destinationUuid, currentRootUuid()),
		startedAt: Date.now()
	}
}

// The sources a job removed leave the listings now; the socket's echo then finds nothing left to do. One
// that went with another source it lies within is only taken out: the trash lists the outer one alone.
function patchDisposed(
	deps: RunArchiveDeps,
	dispositions: readonly JobDisposition<ErrorDTO>[],
	kindOf: (uuid: string) => "file" | "directory",
	nested?: (uuid: string) => boolean
): void {
	for (const { uuid, outcome } of dispositions) {
		if (outcome.type === "disposed") {
			deps.patchLeft([uuid], outcome.how === "trash" && nested?.(uuid) !== true ? "trash" : "delete", kindOf(uuid))
		}
	}
}

function hasDisposed(dispositions: readonly JobDisposition<ErrorDTO>[]): boolean {
	return dispositions.some(disposition => disposition.outcome.type === "disposed")
}

function quotaDTO(kind: "compress" | "extract", neededBytes: number | null, freeBytes: number): ErrorDTO {
	const free = formatBytes(freeBytes)

	return plainErrorDTO(
		neededBytes === null
			? i18n.t("transfers:transfersArchiveQuotaUnknown", { free })
			: kind === "compress"
				? i18n.t("transfers:transfersCompressQuotaExceeded", { needed: formatBytes(neededBytes), free })
				: i18n.t("transfers:transfersExtractQuotaExceeded", { needed: formatBytes(neededBytes), free }),
		"MaxStorageReached"
	)
}

// The kind stays, so the row and the card offer the password prompt.
function passwordDTO(wrong: boolean): ErrorDTO {
	return wrong
		? plainErrorDTO(i18n.t("transfers:transfersExtractWrongPassword"), "ArchiveWrongPassword")
		: plainErrorDTO(i18n.t("transfers:transfersExtractPasswordRequired"), "ArchivePasswordRequired")
}

function settleOutcomeRow(
	transfers: RunArchiveDeps["transfers"],
	id: string,
	kind: "compress" | "extract",
	outcome: JobOutcome<ErrorDTO>
): void {
	switch (outcome.status) {
		case "running":
		case "done":
			transfers.settle(id, "done")

			break
		case "doneWithIssues":
			transfers.settle(id, "completedWithErrors")

			break
		case "cancelled":
			transfers.settle(id, "cancelled")
			transfers.remove(id)

			break
		case "quotaExceeded":
			transfers.settle(id, "error", quotaDTO(kind, outcome.neededBytes, outcome.freeBytes))

			break
		case "passwordRequired":
		case "wrongPassword":
			transfers.settle(id, "error", passwordDTO(outcome.status === "wrongPassword"))

			break
		case "failed":
			transfers.settle(id, "error", outcome.error)

			break
	}
}

function settleExtractRow(transfers: RunArchiveDeps["transfers"], id: string, job: ExtractJob): void {
	// Items the stop asked to trash that are still at the destination: the row stays, as an error.
	if (job.trashResult !== null && job.trashResult.failed > 0) {
		transfers.settle(id, "error", plainErrorDTO(i18n.t("transfers:transfersExtractTrashFailed")))

		return
	}

	// The stop reached the extract only after it had finished, and moved all it made to the trash:
	// undone, it leaves no row, as when the stop came first.
	if (job.trashResult !== null && (job.outcome.status === "done" || job.outcome.status === "doneWithIssues")) {
		transfers.settle(id, "cancelled")
		transfers.remove(id)

		return
	}

	settleOutcomeRow(transfers, id, "extract", job.outcome)
}

// The removed sources' parents, once each, whose recursive sizes changed.
function disposedParents(
	dispositions: readonly JobDisposition<ErrorDTO>[],
	parentOf: (uuid: string) => string | null | undefined
): (string | null)[] {
	const parents = new Set<string | null>()

	for (const { uuid, outcome } of dispositions) {
		// A kept directory may still have lost files to a permanent removal that stopped part way.
		if (outcome.type === "disposed" || outcome.bytesFreed > 0) {
			const parent = parentOf(uuid)

			if (parent !== undefined) {
				parents.add(parent)
			}
		}
	}

	return [...parents]
}

// ── Compress ────────────────────────────────────────────────────────────────

async function attemptCompress(
	deps: RunArchiveDeps,
	request: CompressJobRequest,
	maxBytes: number | undefined,
	onEvent: OnCompressEvent
): Promise<CompressJobSettlement> {
	const { source } = request

	try {
		const report = await runOp(
			deps.compressItems(
				request.id,
				{
					items: source.kind === "items" ? narrowToSdkItems(source.items) : source.items,
					destinationUuid: request.destination.uuid,
					name: request.name,
					format: request.format,
					maxBytes,
					dispose: request.dispose ?? undefined
				},
				jobPassword(request.id),
				onEvent
			)
		)

		return { report: compressReportInput(report), maxBytes }
	} catch (e) {
		return { error: asErrorDTO(e) }
	}
}

function withArchive(job: CompressJob, archive: DriveItem | null): CompressJob {
	return archive === null || job.archive !== null ? job : { ...job, archive }
}

// After the settle, an update adds only what the settle left out: a report already lists everything
// but the propagation failures; a rejected call lists nothing.
function lateCompressUpdate(job: CompressJob, update: CompressUpdateInput<ErrorDTO>, fromReport: boolean): CompressJob {
	const { propagationFailed } = update.events

	if (fromReport) {
		return propagationFailed === 0 ? job : { ...job, propagationFailedCount: job.propagationFailedCount + propagationFailed }
	}

	const merged = applyCompressUpdate(job, update)

	if (
		merged.skipped === job.skipped &&
		merged.renamed === job.renamed &&
		merged.hashMismatches === job.hashMismatches &&
		merged.dispositions === job.dispositions &&
		propagationFailed === 0
	) {
		return job
	}

	return {
		...job,
		skipped: merged.skipped,
		renamed: merged.renamed,
		hashMismatches: merged.hashMismatches,
		dispositions: merged.dispositions,
		propagationFailedCount: merged.propagationFailedCount
	}
}

function sourceIndex(request: CompressJobRequest): Map<string, DriveItem> {
	return new Map(request.source.kind === "items" ? request.source.items.map(item => [item.data.uuid, item]) : [])
}

function compressEffects(job: CompressJob, sources: () => Map<string, DriveItem>): JobSettledEffects {
	const summary = summarizeDispositions(job.dispositions)
	const rootUuid = currentRootUuid()

	return {
		destinationUuid: job.destination.uuid,
		writtenDirs: [],
		bytesWritten: job.archive === null ? 0 : job.counts.archiveBytes,
		bytesFreed: summary.bytesFreed,
		sourceParents: disposedParents(job.dispositions, uuid => {
			const item = sources().get(uuid)

			return item === undefined ? undefined : normalizeParentUuid(asDirectoryOrFile(item).data.parent, rootUuid)
		})
	}
}

// Never throws: every way a job can end is an outcome on its job. Resolves undefined only if the job
// was dropped from the store meanwhile.
export async function runCompressJob(deps: RunArchiveDeps, request: CompressJobRequest): Promise<CompressJob | undefined> {
	const { id } = request

	deps.compressJobs.put(createWebCompressJob(request))
	deps.transfers.add(jobRow(id, "compress", request.name, request.destination.uuid))

	const writeRowFigures = rowFiguresWriter(deps.transfers, id)
	// The job as it settled, and whether from a report: as for a copy, an event can still arrive after.
	const settled: { job: CompressJob | undefined; fromReport: boolean } = { job: undefined, fromReport: false }
	// The archive as its callback announced it, written with the next update rather than on its own.
	let announced: DriveItem | null = null
	let sources: Map<string, DriveItem> | undefined
	const sourcesOf = (): Map<string, DriveItem> => (sources ??= sourceIndex(request))
	const kindOf = (uuid: string): "file" | "directory" => {
		const item = sourcesOf().get(uuid)

		return item === undefined ? "file" : asDirectoryOrFile(item).type
	}
	// Every source removed so far: a nested one shares its outer one's outcome.
	const removed = new Set<string>()
	const nested = (uuid: string): boolean => {
		const item = sourcesOf().get(uuid)

		return item !== undefined && liesWithin({ uuid: asDirectoryOrFile(item).data.parent }, removed)
	}

	const onEvent: OnCompressEvent = event => {
		if (event.type === "archiveCreated") {
			const archive = narrowItem(event.archive)

			deps.patchCreated(archive)
			deps.transfers.setItem(id, archive)

			if (settled.job === undefined) {
				announced = archive
			} else {
				// A call that rejected past its cancel grace still delivers what it had queued.
				deps.compressJobs.update(id, job => (job.archive === null ? { ...job, archive, lateArchive: true } : job))
			}

			return
		}

		const update = compressUpdateInput(event.update)
		const { dispositions } = update.events

		for (const { uuid, outcome } of dispositions) {
			if (outcome.type === "disposed") {
				removed.add(uuid)
			}
		}

		patchDisposed(deps, dispositions, kindOf, nested)

		if (settled.job !== undefined) {
			deps.compressJobs.update(id, job => lateCompressUpdate(job, update, settled.fromReport))

			return
		}

		const archive = announced

		announced = null
		deps.compressJobs.update(id, job => withArchive(applyCompressUpdate(job, update), archive))

		const job = deps.compressJobs.get(id)

		if (job !== undefined) {
			writeRowFigures(compressJobRowFigures(job))
		}
	}

	const cancelRequested = (): boolean => deps.compressJobs.get(id)?.cancelRequest != null
	const initial = deps.compressJobs.get(id)
	let maxBytes = copyMaxBytes(deps.account.cached())
	let settlement = await attemptCompress(deps, request, maxBytes, onEvent)

	// A bare tar states its size up front; a refusal of it reads the account once fresh, as a copy's does.
	if ("report" in settlement && isCompressPreflightRefusal(settlement.report) && maxBytes !== undefined && !cancelRequested()) {
		const freshMaxBytes = copyMaxBytes(await readFreshAccount(deps.account))

		if (freshMaxBytes !== undefined && freshMaxBytes > maxBytes && !cancelRequested()) {
			maxBytes = freshMaxBytes

			// The refused call's events would count twice.
			if (initial !== undefined) {
				deps.compressJobs.update(id, job => rewindCompressEvents(job, initial))
			}

			settlement = await attemptCompress(deps, request, maxBytes, onEvent)
		} else if (freshMaxBytes !== undefined && freshMaxBytes <= maxBytes) {
			// Never a figure the SDK's own check didn't refuse.
			settlement = { report: settlement.report, maxBytes: freshMaxBytes }
		}
	}

	// Refused before anything was written, by a job stopped meanwhile: it ends as the stop it was.
	if ("report" in settlement && isCompressPreflightRefusal(settlement.report) && cancelRequested()) {
		settlement = { ...settlement, report: { ...settlement.report, error: STOPPED } }
	}

	deps.release(id)

	const archive = announced

	announced = null
	deps.compressJobs.update(id, job => settleCompressJob(withArchive(job, archive), settlement))

	const job = deps.compressJobs.get(id)

	settled.job = job
	settled.fromReport = "report" in settlement

	if (job === undefined) {
		return undefined
	}

	writeRowFigures(compressJobRowFigures(job))
	settleOutcomeRow(deps.transfers, id, "compress", job.outcome)
	deps.settled(job, compressEffects(job, sourcesOf))

	return job
}

// ── Extract ─────────────────────────────────────────────────────────────────

type ExtractCallResult = { report: ExtractJobReport } | { error: ErrorDTO }

async function attemptExtract(
	deps: RunArchiveDeps,
	request: ExtractJobRequest,
	call: ExtractCall,
	maxBytes: number | undefined,
	onEvent: OnExtractEvent
): Promise<ExtractCallResult> {
	const password = jobPassword(request.id)
	const skipMacMetadata = request.skipMacMetadata

	try {
		const report = await runOp(
			call.type === "all"
				? deps.extractArchive(
						request.id,
						{
							archive: request.archive.file,
							destinationUuid: request.destination.uuid,
							root: request.root,
							maxBytes,
							skipMacMetadata,
							dispose: request.dispose ?? undefined
						},
						password,
						onEvent
					)
				: deps.extractArchiveEntries(
						request.id,
						{
							archive: request.archive.file,
							entries: call.entries,
							base: call.base,
							destination: call.destination,
							root: request.root,
							maxBytes,
							skipMacMetadata
						},
						password,
						onEvent
					)
		)

		return { report: extractReportInput(report) }
	} catch (e) {
		return { error: asErrorDTO(e) }
	}
}

function mergeCallReports(earlier: ExtractJobReport | undefined, report: ExtractJobReport): ExtractJobReport {
	return earlier === undefined ? report : { ...mergeExtractReports(earlier, report), topLevel: earlier.topLevel.concat(report.topLevel) }
}

// After the settle, an update adds only what the settle left out, as for a compress.
function lateExtractUpdate(job: ExtractJob, update: ExtractUpdateInput<AnyNormalDir, ErrorDTO>, fromReport: boolean): ExtractJob {
	const { propagationFailed, savedAsVersion } = update.events

	if (fromReport) {
		return propagationFailed === 0 ? job : { ...job, propagationFailedCount: job.propagationFailedCount + propagationFailed }
	}

	const merged = applyExtractUpdate(job, update)

	if (
		merged.failures === job.failures &&
		merged.skipped === job.skipped &&
		merged.renamed === job.renamed &&
		merged.misleadingNames === job.misleadingNames &&
		merged.dispositions === job.dispositions &&
		propagationFailed === 0 &&
		savedAsVersion === 0
	) {
		return job
	}

	return {
		...job,
		failures: merged.failures,
		skipped: merged.skipped,
		renamed: merged.renamed,
		misleadingNames: merged.misleadingNames,
		dispositions: merged.dispositions,
		savedAsVersionCount: merged.savedAsVersionCount,
		macMetadataSkippedCount: merged.macMetadataSkippedCount,
		propagationFailedCount: merged.propagationFailedCount
	}
}

// The directories below the destination whose recursive size the job moved: the top-level directories it
// created, and for a retry every directory from where its entries landed up to the destination.
function extractWrittenDirs(request: ExtractJobRequest, delivered: readonly DriveItem[]): string[] {
	const created = delivered.flatMap(item => (item.type === "directory" ? [item.data.uuid] : []))
	const into: AnyNormalDir[] = []

	for (const call of request.calls) {
		if (call.type === "entries" && "dir" in call.destination) {
			into.push(call.destination.dir)
		}
	}

	return into.length === 0 ? created : directoriesBetween(into, request.destination.uuid, created)
}

function extractEffects(job: ExtractJob, request: ExtractJobRequest, writtenDirs: readonly string[]): JobSettledEffects {
	const summary = summarizeDispositions(job.dispositions)
	const { file } = request.archive

	return {
		destinationUuid: job.destination.uuid,
		writtenDirs,
		bytesWritten: job.counts.bytesDone,
		bytesFreed: summary.bytesFreed,
		sourceParents: disposedParents(job.dispositions, () =>
			"parent" in file ? normalizeParentUuid(file.parent, currentRootUuid()) : undefined
		)
	}
}

// Never throws: every way a job can end is an outcome on its job. Resolves undefined only if the job
// was dropped from the store meanwhile.
export async function runExtractJob(deps: RunArchiveDeps, request: ExtractJobRequest): Promise<ExtractJob | undefined> {
	const { id } = request
	const row = jobRow(id, "extract", request.rowName, request.destination.uuid)

	// A rerun under the same id keeps the card where it is.
	deps.extractJobs.put({ ...createWebExtractJob(request), cardVisible: deps.extractJobs.get(id)?.cardVisible ?? false })
	deps.transfers.add(row)

	const writeRowFigures = rowFiguresWriter(deps.transfers, id)
	// The job as it settled, and whether from a report: as for a copy, an event can still arrive after.
	let settledJob: ExtractJob | undefined
	let settledFromReport = false
	// The top-level items delivered before the settle, kept here rather than on the job: only the settle
	// reads them.
	let delivered: DriveItem[] = []
	// What the row and card reveal, written with the next update; `revealChanged` until then.
	let reveal: DriveItem | null = null
	let revealChanged = false
	// Everything handed to the trash, or that the SDK trashed itself: none goes twice.
	const trashing = new Set<string>()
	// What the job's earlier calls counted: each call's own counts start from zero.
	let earlierCounts: CopyJobCounts | undefined

	const writeLateReveal = (): void => {
		if (revealChanged) {
			revealChanged = false
			deps.extractJobs.update(id, job => (job.firstCreated === reveal ? job : { ...job, firstCreated: reveal }))
		}
	}

	const trashLate = async (item: DriveItem): Promise<void> => {
		if (trashing.has(item.data.uuid)) {
			return
		}

		trashing.add(item.data.uuid)

		const outcome = await deps.trash([item])
		const current = deps.extractJobs.get(id)

		// While the stop's own batch is still moving, that batch settles the row, this one's result included.
		if (outcome.failed.length === 0 || (current !== undefined && isExtractTrashPending(current))) {
			deps.extractJobs.update(id, job => ({ ...job, trashResult: addTrashOutcome(job.trashResult, outcome) }))

			return
		}

		// Left at the destination: a job dropped meanwhile comes back, with the row that says so.
		const base = deps.extractJobs.get(id) ?? (settledJob === undefined ? undefined : { ...settledJob, cardVisible: false })

		if (base === undefined) {
			return
		}

		const job: ExtractJob = { ...base, created: [], trashResult: addTrashOutcome(base.trashResult, outcome) }
		const figures = extractJobRowFigures(job)

		deps.extractJobs.put(job)
		deps.transfers.remove(id)
		deps.transfers.add({ ...row, size: figures.size, bytesTransferred: figures.shown })
		settleExtractRow(deps.transfers, id, job)
	}

	const onEvent: OnExtractEvent = event => {
		if (event.type === "topLevelBatch") {
			for (const entry of event.items) {
				const item = narrowItem(entry.item)

				deps.patchCreated(item)

				if (reveal === null) {
					reveal = item
					revealChanged = true
					deps.transfers.setItem(id, item)
				}

				if (settledJob === undefined) {
					delivered.push(item)
				} else if (settledJob.cancelRequest === "trash") {
					void trashLate(item)
				}
			}

			if (settledJob !== undefined) {
				writeLateReveal()
			}

			return
		}

		const update = extractUpdateInput(event.update)
		const { topLevelTrashed, dispositions } = update.events

		// A late wrong password trashed folders already handed over: they leave the listings, the items a
		// stop would trash, and the reveal.
		if (topLevelTrashed.length > 0) {
			const gone = new Set(topLevelTrashed)

			deps.patchLeft(topLevelTrashed, "trash", "directory")

			for (const uuid of gone) {
				trashing.add(uuid)
			}

			delivered = delivered.filter(item => !gone.has(item.data.uuid))

			if (reveal !== null && gone.has(reveal.data.uuid)) {
				reveal = null
				revealChanged = true
			}
		}

		patchDisposed(deps, dispositions, () => "file")

		if (settledJob !== undefined) {
			deps.extractJobs.update(id, job => lateExtractUpdate(job, update, settledFromReport))
			writeLateReveal()

			return
		}

		const firstCreated = revealChanged ? reveal : undefined

		revealChanged = false
		deps.extractJobs.update(id, job => {
			const next = applyExtractUpdate(job, update, earlierCounts)

			return firstCreated === undefined ? next : { ...next, firstCreated }
		})

		const job = deps.extractJobs.get(id)

		if (job !== undefined) {
			writeRowFigures(extractJobRowFigures(job))
		}
	}

	const cancelRequested = (): boolean => deps.extractJobs.get(id)?.cancelRequest != null
	let maxBytes = copyMaxBytes(deps.account.cached())
	// What the last call could write: the job's limit less what its earlier calls wrote.
	let callMaxBytes = maxBytes
	const remainingMaxBytes = (): number | undefined =>
		maxBytes === undefined || earlierCounts === undefined ? maxBytes : Math.max(0, maxBytes - earlierCounts.bytesDone)
	let freshRead = false
	let report: ExtractJobReport | undefined
	let rejection: ErrorDTO | undefined
	let refusedUpFront = false

	// One call after another, each queueing for the page's archive slot again; a stop ends the run
	// between them, and so does a call that stopped early.
	for (const call of request.calls) {
		if (cancelRequested()) {
			break
		}

		const before = deps.extractJobs.get(id)

		callMaxBytes = remainingMaxBytes()

		let result = await attemptExtract(deps, request, call, callMaxBytes, onEvent)

		// A zip or 7z states its size up front; a refusal of it reads the account fresh, once a job.
		if ("report" in result && isExtractPreflightRefusal(result.report) && maxBytes !== undefined && !freshRead && !cancelRequested()) {
			freshRead = true

			const freshMaxBytes = copyMaxBytes(await readFreshAccount(deps.account))

			if (freshMaxBytes !== undefined && freshMaxBytes > maxBytes && !cancelRequested()) {
				maxBytes = freshMaxBytes
				callMaxBytes = remainingMaxBytes()

				// The refused call's events would count twice.
				if (before !== undefined) {
					deps.extractJobs.update(id, job => rewindExtractEvents(job, before))
				}

				result = await attemptExtract(deps, request, call, callMaxBytes, onEvent)
			} else if (freshMaxBytes !== undefined && freshMaxBytes <= maxBytes) {
				maxBytes = freshMaxBytes
				callMaxBytes = remainingMaxBytes()
			}
		}

		if ("error" in result) {
			rejection = result.error

			break
		}

		const callCounts = toItemCounts(result.report.counts)

		earlierCounts = earlierCounts === undefined ? callCounts : addItemCounts(earlierCounts, callCounts)
		report = mergeCallReports(report, result.report)
		refusedUpFront = isExtractPreflightRefusal(result.report)

		if (result.report.error !== undefined) {
			break
		}
	}

	// A job stopped before its first call, or refused up front once stopped, ends as the stop it was.
	let settlement: ExtractJobSettlement =
		rejection !== undefined ? { error: rejection } : report === undefined ? { error: STOPPED } : { report, maxBytes: callMaxBytes }

	if ("report" in settlement && refusedUpFront && cancelRequested()) {
		settlement = { ...settlement, report: { ...settlement.report, error: STOPPED } }
	}

	deps.release(id)

	const firstCreated = reveal

	revealChanged = false
	deps.extractJobs.update(id, job => {
		const settled = settleExtractJob(job, settlement)

		// A stop that came while the archive was being removed found it already gone: what was extracted
		// is all that is left of it, so the stop keeps it.
		if (settled.cancelRequest === "trash" && hasDisposed(settled.dispositions)) {
			return { ...settled, firstCreated, cancelRequest: "keep", created: [] }
		}

		// Only "move extracted items to trash" reads what the job made.
		return { ...settled, firstCreated, created: settled.cancelRequest === "trash" ? extractedTopLevel(settlement, delivered) : [] }
	})

	const writtenDirs = extractWrittenDirs(request, delivered)

	// Let go of them: the worker may still hold the callbacks.
	delivered = []

	settledJob = deps.extractJobs.get(id)
	settledFromReport = "report" in settlement

	if (settledJob === undefined) {
		return undefined
	}

	writeRowFigures(extractJobRowFigures(settledJob))

	// Honoured however the job ended, as a copy's: only top-level items are trashed, their subtrees with
	// them. The row stays active until then, but nothing on it is paused any more.
	if (settledJob.created.length > 0) {
		deps.transfers.setPaused(id, false)

		for (const item of settledJob.created) {
			trashing.add(item.data.uuid)
		}

		const outcome = await deps.trash(settledJob.created)

		deps.extractJobs.update(id, job => ({ ...job, created: [], trashResult: addTrashOutcome(job.trashResult, outcome) }))
		settledJob = deps.extractJobs.get(id) ?? {
			...settledJob,
			created: [],
			trashResult: addTrashOutcome(settledJob.trashResult, outcome)
		}
	}

	const job = settledJob

	settleExtractRow(deps.transfers, id, job)
	deps.settled(job, extractEffects(job, request, writtenDirs))

	return job
}

// ── Entry points ────────────────────────────────────────────────────────────

function patchLeft(uuids: readonly string[], how: "trash" | "delete", kind: "file" | "directory"): void {
	for (const uuid of uuids) {
		if (how === "trash") {
			applyItemTrashed(uuid, kind)
		} else {
			applyItemDeleted(uuid)
		}
	}
}

export const defaultArchiveDeps: RunArchiveDeps = {
	compressItems: (id, params, password, onEvent) => sdkApi.compressItems(id, params, password, Comlink.proxy(onEvent)),
	extractArchive: (id, params, password, onEvent) => sdkApi.extractArchive(id, params, password, Comlink.proxy(onEvent)),
	extractArchiveEntries: (id, params, password, onEvent) => sdkApi.extractArchiveEntries(id, params, password, Comlink.proxy(onEvent)),
	release: id => {
		void sdkApi.releaseJob(id)
	},
	transfers: useTransfersStore.getState(),
	compressJobs: jobsAccess("compress"),
	extractJobs: jobsAccess("extract"),
	account: accountQuotaDeps,
	patchCreated: patchJobCreatedItem,
	patchLeft,
	trash: trashItems,
	settled: (_job, effects) => {
		afterDriveJobSettled(effects)
	}
}

// Starts the compress and returns its job id at once; the job outlives whatever started it. The UI shows
// its card (features/transfers/lib/archiveToast.ts), keeping this module free of it.
export function startCompress(request: Omit<CompressJobRequest, "id">, password: string | undefined): string {
	const id = crypto.randomUUID()

	holdJobPassword(id, password)
	void runCompressJob(defaultArchiveDeps, { ...request, id })

	return id
}

export function startExtract(request: Omit<ExtractJobRequest, "id">, password: string | undefined): string {
	const id = crypto.randomUUID()

	holdJobPassword(id, password)
	void runExtractJob(defaultArchiveDeps, { ...request, id })

	return id
}

// A new job for what the given one could not extract, each entry back into the directory it was meant
// for, one call per directory. It supersedes the given one, as a copy's retry does.
export function retryFailedExtract(jobId: string): string | null {
	const job = getJobOf("extract", jobId)

	if (job === undefined || !canRetryExtract(job)) {
		return null
	}

	const groups = groupExtractRetries(job.failures.items)

	if (groups.length === 0) {
		return null
	}

	const id = crypto.randomUUID()
	const { request } = job
	const streamed = request.formatHint === "tar" || request.formatHint === "single"

	holdJobPassword(id, jobPassword(jobId))
	void runExtractJob(defaultArchiveDeps, {
		...request,
		id,
		root: { type: "destination" },
		// Every failure is an entry of this job's own archive, whose SDK uuid the call takes.
		calls: groups.map((group): ExtractCall => ({
			type: "entries",
			entries: group.entries.map(entry => ({ archive: request.archive.file.uuid, index: entry.index })),
			base: group.base,
			destination: { dir: group.destinationDir }
		})),
		dispose: null,
		// A tar is read whole for any of its entries, so one call's archive bytes measure it; several calls
		// read it again each.
		basis: groups.length === 1 && streamed ? { type: "archiveRead" } : { type: "unknown" },
		glyph: "items",
		retry: true
	})

	useDriveJobsStore.getState().update("extract", jobId, retried => ({ ...retried, retriedAway: true }))

	if ((job.trashResult?.failed ?? 0) === 0) {
		useTransfersStore.getState().remove(jobId)
	}

	pruneSettledDriveJobs()

	return id
}

// The same compress again, as a new job: one that failed or did not fit made nothing to keep.
export function rerunCompress(jobId: string): string | null {
	const job = getJobOf("compress", jobId)

	if (job === undefined || isJobRunning(job) || !canRerunCompress(job)) {
		return null
	}

	const id = crypto.randomUUID()

	holdJobPassword(id, jobPassword(jobId))
	void runCompressJob(defaultArchiveDeps, { ...job.request, id })

	useTransfersStore.getState().remove(jobId)
	pruneSettledDriveJobs()

	return id
}

// The same extract again under the same id, with the password the first run lacked or got wrong: its
// card stays where it is, and its row starts over.
export function rerunExtractWithPassword(jobId: string, password: string): boolean {
	const job = getJobOf("extract", jobId)

	if (job === undefined || (job.outcome.status !== "passwordRequired" && job.outcome.status !== "wrongPassword")) {
		return false
	}

	holdJobPassword(jobId, password)
	useTransfersStore.getState().remove(jobId)
	void runExtractJob(defaultArchiveDeps, job.request)

	return true
}
