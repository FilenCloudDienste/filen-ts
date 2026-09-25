import {
	type AnyNormalDir,
	type CopyEntry,
	type CopyError,
	type CopyItem,
	type CopyItemsCallback,
	type CopyReport,
	type CopyUpdate,
	ErrorKind,
	ManagedFuture
} from "@filen/sdk-rs"
import {
	applyCopyUpdate,
	copyJobShownBytes,
	copyMaxBytes,
	isQuotaPreflightFailure,
	settleCopyJob,
	type CopyUpdateEvents,
	type StorageCounters
} from "@filen/shared"
import { randomUUID } from "expo-crypto"
import auth from "@/lib/auth"
import i18n from "@/lib/i18n"
import logger from "@/lib/logger"
import { createCompositeAbortSignal, disposeSdkAbortSignal, PauseSignal, wrapAbortSignalForSdk } from "@/lib/signals"
import { unwrapParentUuid } from "@/lib/sdkUnwrap"
import { unwrapSdkError } from "@/lib/sdkErrors"
import { driveItemDisplayName } from "@/lib/decryption"
import transfers from "@/features/transfers/transfers"
import { copyDoesNotFitMessage, notEnoughStorageMessage } from "@/features/transfers/quota"
import useTransfersStore, { type FinishedTransfer } from "@/features/transfers/store/useTransfers.store"
import useCopyJobsStore, { getCopyJob } from "@/features/copy/store/useCopyJobs.store"
import {
	collectCopyEvents,
	copyJobError,
	copyJobErrorToHumanReadable,
	copyReportInput,
	copyUpdateInput,
	createCopyJob,
	createdDriveItem,
	emptyCopyEvents,
	retryEntries,
	versionTargets,
	type CopyDestination,
	type CopyJob,
	type CopyJobFailure,
	type CopyJobGlyph,
	type CopySettlement
} from "@/features/copy/copyAdapter"
import { copyGlyphForCopyItems, copyGlyphForEntries, copyGlyphForItems, driveItemToCopyItem } from "@/features/copy/copySource"
import copyActivity from "@/features/drive/copyActivity"
import socketCreateBatcher from "@/features/drive/socketCreateBatcher"
import { markDirectorySizesStale } from "@/features/drive/queries/useDirectorySize.query"
import { trash } from "@/features/drive/driveTrash"
import { accountQuotaDeps, addAccountStorageUsed } from "@/queries/useAccount.query"
import { driveItemsQueryRefetchAfterSocketGap } from "@/features/drive/queries/useDriveItems.query"
import useSocketStore from "@/stores/useSocket.store"
import type { DriveItem } from "@/types"

// At most one job store and row write per window from progress callbacks. Each callback holds a Rust
// worker until it returns (invokeBlocking), so it only records; the write happens on the window's
// leading edge, a trailing timer catches the last update, and settle always writes.
export const COPY_FLUSH_MS = 250

type CopySource = { kind: "items"; items: CopyItem[]; destination: AnyNormalDir } | { kind: "entries"; entries: CopyEntry[] }

type CopyRequest = {
	id: string
	source: CopySource
	destination: CopyDestination
	itemCount: number
	name: string
	glyph: CopyJobGlyph
}

type CopyControls = {
	abort: AbortController
	pause: PauseSignal
}

function copyRowName(itemCount: number, singleName: string): string {
	return itemCount === 1 ? singleName : i18n.t("copy_n_items", { count: itemCount })
}

function finishedOutcome(job: CopyJob): Pick<FinishedTransfer, "outcome" | "errorMessage"> | null {
	switch (job.outcome.status) {
		case "running":
		case "done": {
			return {
				outcome: "succeeded",
				errorMessage: null
			}
		}

		case "doneWithFailures": {
			return {
				outcome: "completedWithErrors",
				errorMessage: null
			}
		}

		// A cancelled copy's row just goes; what it made stays, or went to the trash on request. A trash
		// that left items behind brings the row back (syncTrashFailedRow).
		case "cancelled": {
			return null
		}

		case "quotaExceeded": {
			return {
				outcome: "errored",
				errorMessage: quotaExceededMessage(job.totals, job.outcome.freeBytes)
			}
		}

		case "failed": {
			return {
				outcome: "errored",
				errorMessage: copyJobErrorToHumanReadable(job.outcome.error)
			}
		}
	}
}

// The scan's total is what didn't fit. The SDK's own pre-flight refusal reports no totals at all, so
// only the free figure it was checked against can be said; a server refusal of a copy that fit that
// figure gets the plain limit message.
function quotaExceededMessage(totals: CopyJob["totals"], freeBytes: number): string {
	if (totals.bytes > freeBytes) {
		return notEnoughStorageMessage(totals.bytes, freeBytes)
	}

	if (totals.bytes === 0 && totals.files === 0 && totals.dirs === 0) {
		return copyDoesNotFitMessage(freeBytes)
	}

	return copyJobErrorToHumanReadable({
		kind: "MaxStorageReached",
		message: "",
		serverMessage: undefined
	})
}

// A settled job's finished row; null for a cancelled one, whose row comes back only while "move to
// trash" left items behind.
function finishedRow(job: CopyJob): FinishedTransfer | null {
	const finished = finishedOutcome(job)

	if (!finished) {
		return null
	}

	return {
		id: job.id,
		type: "copy",
		name: job.rowName,
		size: job.totals.bytes,
		bytesTransferred: job.counts.bytesDone,
		startedAt: job.startedAt,
		finishedAt: Date.now(),
		outcome: finished.outcome,
		errorMessage: finished.errorMessage,
		errorCount: job.failures.length,
		copyGlyph: job.glyph,
		copyNotes: {
			skipped: job.counts.entriesSkipped,
			renamed: job.renamedCount,
			savedAsVersion: job.savedAsVersionCount,
			propagationFailed: job.propagationFailedCount
		},
		// A file saved as a new version still landed its bytes.
		copyNothingCopied: job.counts.dirsCreated === 0 && job.counts.filesDone === 0 && job.savedAsVersionCount === 0
	}
}

// The row of a stopped copy whose "move to trash" left items behind.
function stoppedRow(job: CopyJob): FinishedTransfer {
	return {
		id: job.id,
		type: "copy",
		name: job.rowName,
		size: job.totals.bytes,
		bytesTransferred: job.counts.bytesDone,
		startedAt: job.startedAt,
		finishedAt: Date.now(),
		outcome: "errored",
		errorMessage: null,
		errorCount: 0,
		copyGlyph: job.glyph
	}
}

// Jobs whose stop dialog is open: the job and what it made are kept for a "move to trash" answer even
// if it settles meanwhile.
const choosingCancel = new Set<string>()

// "Move to trash" runs in flight per job; the main batch, late creates and Retry can overlap. The job is
// kept while one runs, or a failure it reports would find no job to keep it.
const trashing = new Map<string, number>()

// Destinations whose listings may have missed create echoes. Refetched once no copy creates items: a
// refetch while one does drops the echoes landing mid-fetch.
const socketGapDestinations = new Set<string | null>()

// Runs copies as one SDK job and one transfers row each, however many items a job holds. The SDK owns
// the scan, concurrency, retries and share/link propagation; this feeds its progress into the stores
// and hands the top-level items it creates to the socket create batcher (nested ones arrive as socket
// echoes). Cancelling keeps what was copied unless "move to trash" was asked for.
class CopyRunner {
	private readonly controls = new Map<string, CopyControls>()

	public start({ items, destination, destinationDir }: { items: DriveItem[]; destination: CopyDestination; destinationDir: AnyNormalDir }): string | null {
		const first = items[0]

		if (first === undefined) {
			return null
		}

		return this.launch({
			source: {
				kind: "items",
				items: items.map(driveItemToCopyItem),
				destination: destinationDir
			},
			destination,
			itemCount: items.length,
			name: copyRowName(items.length, driveItemDisplayName(first)),
			glyph: copyGlyphForItems(items)
		})
	}

	// SDK items a caller built itself (a public link's file or directory).
	public startCopyItems({
		items,
		name,
		destination,
		destinationDir
	}: {
		items: CopyItem[]
		name: string
		destination: CopyDestination
		destinationDir: AnyNormalDir
	}): string | null {
		if (items.length === 0) {
			return null
		}

		return this.launch({
			source: {
				kind: "items",
				items,
				destination: destinationDir
			},
			destination,
			itemCount: items.length,
			name: copyRowName(items.length, name),
			glyph: copyGlyphForCopyItems(items)
		})
	}

	// A new job for what the given one could not copy, each item back into the directory it was meant for.
	public retryFailed(jobId: string): string | null {
		const job = getCopyJob(jobId)
		const first = job?.retryable[0]

		if (!job || !first) {
			return null
		}

		const entries = retryEntries(job.retryable)

		return this.launch({
			source: {
				kind: "entries",
				entries
			},
			destination: job.destination,
			itemCount: entries.length,
			name: copyRowName(entries.length, first.info.destName),
			glyph: copyGlyphForEntries(entries)
		})
	}

	// The job settles as cancelled through its own report; "trash" then moves its top-level items to the
	// trash (never a permanent delete).
	public requestCancel(jobId: string, mode: "keep" | "trash"): void {
		const controls = this.controls.get(jobId)

		if (!controls) {
			return
		}

		useCopyJobsStore.getState().update(jobId, job => ({
			...job,
			cancelRequest: mode
		}))

		controls.abort.abort()
	}

	public pause(jobId: string): void {
		this.controls.get(jobId)?.pause.pause()
	}

	// The stop dialog opens: the copy waits so the count shown stays true and nothing new is made while
	// the user decides. Returns whether this paused it, so "continue" resumes only then.
	public holdForCancelChoice(jobId: string): boolean {
		choosingCancel.add(jobId)

		const controls = this.controls.get(jobId)

		if (!controls || controls.pause.isPaused()) {
			return false
		}

		controls.pause.pause()

		return true
	}

	public async resolveCancelChoice(jobId: string, choice: "keep" | "trash" | "continue", resumeOnContinue: boolean): Promise<void> {
		choosingCancel.delete(jobId)

		if (this.controls.has(jobId)) {
			if (choice === "continue") {
				if (resumeOnContinue) {
					this.resume(jobId)
				}

				return
			}

			this.requestCancel(jobId, choice)
			// A paused job only takes the stop once it runs again.
			this.resume(jobId)

			return
		}

		// Settled while the dialog was open. A "trash" answer still removes what it made, as it would have
		// had the job been running.
		if (choice === "trash") {
			await this.trashCreated(jobId)
		}

		useCopyJobsStore.getState().update(jobId, settled => (settled.created.length === 0 ? settled : { ...settled, created: [] }))

		pruneSettledCopyJobs()
	}

	public resume(jobId: string): void {
		this.controls.get(jobId)?.pause.resume()
	}

	private launch(request: Omit<CopyRequest, "id">): string {
		const id = randomUUID()
		const job = this.run({
			...request,
			id
		}).catch((e: unknown) => {
			logger.error("copy", "copy job threw", { id, error: e })

			return undefined
		})

		transfers.trackCopy(job)

		return id
	}

	// Never throws: every way a job can end is an outcome on its job.
	public async run(request: CopyRequest): Promise<CopyJob | undefined> {
		const { id, source, destination, itemCount, name, glyph } = request
		const epoch = transfers.sessionEpoch
		const live = () => transfers.sessionEpoch === epoch
		const abort = new AbortController()
		const compositeAbort = createCompositeAbortSignal(transfers.copyScopeSignal(), abort.signal)
		const pause = new PauseSignal()
		let sdkAbort: ReturnType<typeof wrapAbortSignalForSdk> | null = null

		this.controls.set(id, {
			abort,
			pause
		})

		copyActivity.begin()

		const socketAtStart = useSocketStore.getState()
		const startedAt = Date.now()

		useCopyJobsStore.getState().put(
			createCopyJob({
				id,
				destination,
				itemCount,
				glyph,
				rowName: name,
				startedAt
			})
		)

		const setRowPaused = (paused: boolean) => {
			useTransfersStore.getState().setTransfers(prev => prev.map(t => (t.id === id && t.paused !== paused ? { ...t, paused } : t)))
		}

		// Counted by copyActivity once the SDK reports the pause done, not at the request: in-flight work
		// still finishing creates items.
		let countedPaused = false
		// A report of the pause that crossed a resume is stale.
		let pauseRequested = false

		const countPaused = (paused: boolean) => {
			if (paused === countedPaused) {
				return
			}

			countedPaused = paused

			copyActivity.setPaused(paused)

			if (paused) {
				this.refetchSocketGaps(live)
			}
		}

		const pauseListeners = [
			pause.addEventListener("pause", () => {
				pauseRequested = true

				setRowPaused(true)
			}),
			pause.addEventListener("resume", () => {
				pauseRequested = false

				// It creates again before the SDK reports the resume.
				countPaused(false)
				setRowPaused(false)
			})
		]

		useTransfersStore.getState().setTransfers(prev => [
			...prev,
			{
				id,
				type: "copy",
				name,
				glyph,
				size: 0,
				bytesTransferred: 0,
				startedAt,
				paused: false,
				abort: () => this.requestCancel(id, "keep"),
				pause: () => this.pause(id),
				resume: () => this.resume(id)
			}
		])

		let latest: CopyUpdate | null = null
		let pendingEvents: CopyUpdateEvents<CopyJobFailure> = emptyCopyEvents()
		let lastFlushAt = 0
		let trailing: ReturnType<typeof setTimeout> | null = null
		// What the job made as it went, as its callbacks reported it. Joined with the report for "move to
		// trash": the SDK call rejects without a report when the job ignores its cancel past the grace.
		const createdAsReported: DriveItem[] = []
		// Set once the job settled with "move to trash": a create delivered after that (a job dropped past
		// its grace still delivers what it queued) is trashed on arrival.
		let trashLateCreates = false
		// The job as it settled, brought back when a late create's trash fails after the job was pruned.
		let settledJob: CopyJob | undefined
		const trashLate = (item: DriveItem) => this.trashForJob(id, [item], settledJob)

		const flush = () => {
			if (trailing) {
				clearTimeout(trailing)

				trailing = null
			}

			const update = latest

			if (!update || !live()) {
				return
			}

			const events = pendingEvents

			latest = null
			pendingEvents = emptyCopyEvents()
			lastFlushAt = Date.now()

			useCopyJobsStore.getState().update(id, job => applyCopyUpdate(job, copyUpdateInput(update, events)))

			const job = getCopyJob(id)

			if (!job) {
				return
			}

			// The total grows while the scan finds more to copy.
			const size = job.totals.bytes
			const bytesTransferred = copyJobShownBytes(job)

			useTransfersStore.getState().setTransfers(prev => prev.map(t => (t.id === id ? { ...t, size, bytesTransferred } : t)))
		}

		const callback: CopyItemsCallback = {
			onTopLevelPlanned() {
				// Nothing survives a kill, so the plan is not recorded.
			},
			onTopLevelCreated(topLevel) {
				try {
					if (!live()) {
						return
					}

					const item = createdDriveItem(topLevel.item)
					const parentUuid = "parent" in item.data ? unwrapParentUuid(item.data.parent) : null

					if (trashLateCreates) {
						void trashLate(item)

						return
					}

					createdAsReported.push(item)

					if (parentUuid) {
						socketCreateBatcher.enqueue({
							parentUuid,
							item,
							recent: item.type === "file"
						})
					}
				} catch (e) {
					logger.error("copy", "onTopLevelCreated failed", { id, error: e })
				}
			},
			onUpdate(update) {
				try {
					if (!live()) {
						return
					}

					collectCopyEvents(update.events, pendingEvents)

					latest = update

					countPaused(update.paused && pauseRequested)

					if (Date.now() - lastFlushAt >= COPY_FLUSH_MS) {
						flush()
					} else if (!trailing) {
						trailing = setTimeout(flush, COPY_FLUSH_MS)
					}
				} catch (e) {
					logger.error("copy", "onUpdate failed", { id, error: e })
				}
			}
		}

		try {
			sdkAbort = wrapAbortSignalForSdk(compositeAbort)

			const managedFuture = ManagedFuture.new({
				pauseSignal: pause.getSignal(),
				abortSignal: sdkAbort
			})

			let lastReport: CopyReport | null = null

			// Never pass asyncOpts: its signal cancels the Rust future and loses the report. Cancelling goes
			// through the managed future instead, and the report comes back either way.
			const attempt = async (maxBytes: number | undefined): Promise<CopySettlement> => {
				const options = {
					maxBytes: maxBytes === undefined ? undefined : BigInt(maxBytes)
				}

				lastReport = null

				try {
					const { authedSdkClient } = await auth.getSdkClients()
					const report: CopyReport =
						source.kind === "entries"
							? await authedSdkClient.copyItemsTo(source.entries, options, callback, managedFuture)
							: await authedSdkClient.copyItems(source.items, source.destination, options, callback, managedFuture)

					lastReport = report

					return {
						report: copyReportInput(report),
						maxBytes
					}
				} catch (e) {
					return {
						error: toJobError(e)
					}
				}
			}

			const cachedFresh = accountQuotaDeps.isCachedFresh?.() ?? false
			let maxBytes = copyMaxBytes(cachedFresh ? accountQuotaDeps.cached() : await readFreshAccount())
			let settlement = await attempt(maxBytes)

			// A cached figure can predate a delete made elsewhere, so a refusal against it reads once fresh
			// and runs again only if that frees more. A fresh figure is already the answer.
			if (
				cachedFresh &&
				"report" in settlement &&
				isQuotaPreflightFailure(settlement.report) &&
				maxBytes !== undefined &&
				!compositeAbort.aborted &&
				live()
			) {
				const freshMaxBytes = copyMaxBytes(await readFreshAccount())

				if (!compositeAbort.aborted && freshMaxBytes !== undefined) {
					if (freshMaxBytes > maxBytes) {
						maxBytes = freshMaxBytes
						settlement = await attempt(maxBytes)
					} else {
						settlement = {
							report: settlement.report,
							maxBytes: freshMaxBytes
						}
					}
				}
			}

			// Refused before anything was written, and stopped meanwhile (its own stop, Cancel all or the
			// background lifecycle, the last two setting no cancelRequest): it ends as the stop it was.
			if ("report" in settlement && isQuotaPreflightFailure(settlement.report) && compositeAbort.aborted) {
				settlement = {
					error: {
						kind: "Cancelled",
						message: "",
						serverMessage: undefined
					}
				}
			}

			flush()

			// Signed out meanwhile: no listing, cache or account write for the old session.
			if (!live()) {
				useTransfersStore.getState().setTransfers(prev => prev.filter(t => t.id !== id))
				useCopyJobsStore.getState().remove(id)

				return undefined
			}

			// Everything this job made at the top level: the final attempt's report joined with what the
			// callbacks reported, once per uuid, never a version target.
			const copied = copiedTopLevel(lastReport, createdAsReported)
			const final = settlement

			useCopyJobsStore.getState().update(id, job => ({
				...settleCopyJob(job, final),
				created: copied
			}))

			// Nested items only reach listings as socket echoes. A socket that was down, or reconnected, at
			// any point during the job may have dropped some.
			settledJob = getCopyJob(id)

			const socket = useSocketStore.getState()

			if (
				settledJob &&
				(settledJob.counts.dirsCreated > 0 || settledJob.counts.filesDone > 0) &&
				(socketAtStart.state !== "connected" || socket.state !== "connected" || socket.connectedAt !== socketAtStart.connectedAt)
			) {
				socketGapDestinations.add(settledJob.destination.uuid)
			}

			trashLateCreates = settledJob?.cancelRequest === "trash"

			return await this.settle(id, live)
		} finally {
			if (trailing) {
				clearTimeout(trailing)
			}

			for (const listener of pauseListeners) {
				listener.remove()
			}

			this.controls.delete(id)
			compositeAbort.dispose()
			disposeSdkAbortSignal(sdkAbort)
			pause.dispose()

			// Created items land in their listings before Recents is refreshed.
			if (live()) {
				socketCreateBatcher.flushNow()
			}

			// A job dropped past its cancel grace still delivers what it queued: none of that counts.
			pauseRequested = false
			countPaused(false)
			copyActivity.end()

			this.refetchSocketGaps(live)
		}
	}

	private refetchSocketGaps(live: () => boolean): void {
		if (socketGapDestinations.size === 0 || copyActivity.isCreating()) {
			return
		}

		if (live()) {
			for (const destinationUuid of socketGapDestinations) {
				driveItemsQueryRefetchAfterSocketGap(destinationUuid)
			}
		}

		socketGapDestinations.clear()
	}

	// Only top-level items; their subtrees go with them. Moved to the trash, never deleted.
	private async trashCreated(id: string): Promise<void> {
		await this.trashForJob(id, getCopyJob(id)?.created ?? [])
	}

	// "Retry" on a stopped copy's row: moves to the trash just what the last attempt could not.
	public async retryTrash(id: string): Promise<void> {
		const failed = getCopyJob(id)?.trashFailed ?? []

		if (failed.length === 0) {
			return
		}

		await this.trashForJob(id, failed)
	}

	// What fails stays on the job next to earlier failures this run did not retry, and keeps, or brings
	// back, the job's row with a Retry. `settled` brings back a job pruned before a late create's trash
	// failed. Takes no abort signal: the job's own is aborted by the very stop that asked for the trash,
	// and the copy scope's by iOS backgrounding too.
	private async trashForJob(id: string, items: readonly DriveItem[], settled?: CopyJob): Promise<void> {
		const epoch = transfers.sessionEpoch

		trashing.set(id, (trashing.get(id) ?? 0) + 1)

		try {
			const { failedItems, ...trashResult } = await trashCopied(id, items)

			// Signed out meanwhile: the ended session gets no job or row back.
			if (transfers.sessionEpoch !== epoch) {
				return
			}

			if (!getCopyJob(id)) {
				if (!settled || failedItems.length === 0) {
					return
				}

				useCopyJobsStore.getState().put({
					...settled,
					created: [],
					trashFailed: []
				})
			}

			const attempted = new Set(items.map(item => item.data.uuid))

			useCopyJobsStore.getState().update(id, job => ({
				...job,
				trashResult,
				trashFailed: [...job.trashFailed.filter(item => !attempted.has(item.data.uuid)), ...failedItems]
			}))

			syncTrashFailedRow(id)
		} finally {
			const running = (trashing.get(id) ?? 1) - 1

			if (running > 0) {
				trashing.set(id, running)
			} else {
				trashing.delete(id)

				// A prune the trash held back happens now.
				pruneSettledCopyJobs()
			}
		}
	}

	private async settle(id: string, live: () => boolean): Promise<CopyJob | undefined> {
		const job = getCopyJob(id)

		if (!job) {
			return undefined
		}

		const hadRow = useTransfersStore.getState().transfers.some(t => t.id === id)
		const row = hadRow ? finishedRow(job) : null

		useTransfersStore.getState().setTransfers(prev => prev.filter(t => t.id !== id))

		if (row) {
			useTransfersStore.getState().addFinishedTransfer(row)
		}

		// Honoured however the job ended: a copy that finished before the cancel reached it still made
		// what the user asked to remove.
		if (job.cancelRequest === "trash") {
			await this.trashCreated(id)

			// Signed out while the trash ran: no account, size or job write for the ended session.
			if (!live()) {
				return undefined
			}
		}

		if (job.counts.bytesDone > 0) {
			addAccountStorageUsed(BigInt(job.counts.bytesDone))
		}

		if (job.counts.dirsCreated > 0 || job.counts.filesDone > 0) {
			markDirectorySizesStale()
		}

		// What it created was only needed for "move to trash", unless that question is still open;
		// failures stay for "Retry failed items".
		if (!choosingCancel.has(id)) {
			useCopyJobsStore.getState().update(id, settled => (settled.created.length === 0 ? settled : { ...settled, created: [] }))
		}

		const settled = getCopyJob(id)

		pruneSettledCopyJobs()

		return settled
	}
}

async function readFreshAccount(): Promise<StorageCounters | undefined> {
	try {
		return await accountQuotaDeps.fetchFresh()
	} catch {
		return undefined
	}
}

function copiedTopLevel(report: CopyReport | null, reported: readonly DriveItem[]): DriveItem[] {
	const targets = report ? versionTargets(report) : new Set<string>()
	const seen = new Set<string>()
	const items: DriveItem[] = []

	const add = (item: DriveItem) => {
		if (!targets.has(item.data.uuid) && !seen.has(item.data.uuid)) {
			seen.add(item.data.uuid)
			items.push(item)
		}
	}

	for (const topLevel of report?.topLevel ?? []) {
		add(createdDriveItem(topLevel.item))
	}

	for (const item of reported) {
		add(item)
	}

	return items
}

// Moves a copy's top-level items to the trash (their subtrees go with them) and logs the outcome, so a
// partial or slow trash is visible in the diagnostic log.
async function trashCopied(id: string, items: readonly DriveItem[]): Promise<{ moved: number; failed: number; failedItems: DriveItem[] }> {
	if (items.length === 0) {
		logger.info("copy", "move to trash: nothing to trash", { id })

		return {
			moved: 0,
			failed: 0,
			failedItems: []
		}
	}

	const startedAt = Date.now()
	const results = await Promise.allSettled(items.map(item => trash({ item })))
	const failures: { uuid: string; error: unknown }[] = []
	const failedItems: DriveItem[] = []

	results.forEach((result, index) => {
		const item = items[index]

		if (result.status === "rejected" && item) {
			failedItems.push(item)
			failures.push({
				uuid: item.data.uuid,
				error: result.reason
			})
		}
	})

	const outcome = {
		moved: results.length - failures.length,
		failed: failures.length
	}

	if (failures.length > 0) {
		logger.warn("copy", "move to trash: some items were not trashed", { id, ...outcome, durationMs: Date.now() - startedAt, failures })
	} else {
		logger.info("copy", "move to trash: done", { id, ...outcome, durationMs: Date.now() - startedAt })
	}

	return {
		...outcome,
		failedItems
	}
}

// A stopped copy keeps its row only while "move to trash" left items behind; a copy that finished keeps
// its row regardless and just drops the line once the retry succeeds. No toast either way.
function syncTrashFailedRow(id: string): void {
	const job = getCopyJob(id)

	if (!job) {
		return
	}

	const failed = job.trashFailed.length
	const store = useTransfersStore.getState()
	const row = store.finishedTransfers.find(finished => finished.id === id)

	if (failed > 0) {
		if (row) {
			store.updateFinishedTransfer(id, finished => ({
				...finished,
				copyTrashFailed: failed
			}))

			return
		}

		// A copy that finished comes back as it ended (its row was removed meanwhile), so a later clean
		// retry leaves that row rather than an empty error.
		store.addFinishedTransfer({
			...(finishedRow(job) ?? stoppedRow(job)),
			copyTrashFailed: failed
		})

		return
	}

	if (!row?.copyTrashFailed) {
		return
	}

	if (job.outcome.status === "cancelled") {
		store.removeFinishedTransfer(id)

		return
	}

	store.updateFinishedTransfer(id, ({ copyTrashFailed: _cleared, ...finished }) => finished)
}

// A thrown copy (the SDK couldn't start or report), as the error record the job carries.
function toJobError(e: unknown): ReturnType<typeof copyJobError> {
	const sdkError = unwrapSdkError(e)
	const error: CopyError = sdkError
		? {
				kind: sdkError.kind(),
				message: sdkError.innerMessage() ?? "",
				serverMessage: sdkError.serverMessage(),
				serverCode: sdkError.serverCode()
			}
		: {
				kind: ErrorKind.Internal,
				message: e instanceof Error ? e.message : String(e),
				serverMessage: undefined,
				serverCode: undefined
			}

	return copyJobError(error)
}

// A settled job stays while its finished row can still offer "Retry failed items"; a cancelled one
// (no finished row) goes at once.
function pruneSettledCopyJobs(): void {
	const rows = new Set<string>()

	for (const finished of useTransfersStore.getState().finishedTransfers) {
		rows.add(finished.id)
	}

	for (const job of Object.values(useCopyJobsStore.getState().jobs)) {
		if (job.outcome.status !== "running" && !rows.has(job.id) && !choosingCancel.has(job.id) && !trashing.has(job.id)) {
			useCopyJobsStore.getState().remove(job.id)
		}
	}
}

// A finished row removed by hand (Remove from list, Clear finished, a retry) takes its settled job with it.
useTransfersStore.subscribe((state, prev) => {
	if (state.finishedTransfers.length < prev.finishedTransfers.length) {
		pruneSettledCopyJobs()
	}
})

const copyRunner = new CopyRunner()

export default copyRunner
