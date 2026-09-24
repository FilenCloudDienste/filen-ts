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
	copyMaxBytes,
	effectiveBytesDone,
	isQuotaPreflightFailure,
	settleCopyJob,
	type CopyUpdateEvents,
	type StorageCounters
} from "@filen/shared"
import auth from "@/lib/auth"
import i18n from "@/lib/i18n"
import logger from "@/lib/logger"
import { createCompositeAbortSignal, disposeSdkAbortSignal, PauseSignal, wrapAbortSignalForSdk } from "@/lib/signals"
import { unwrapParentUuid } from "@/lib/sdkUnwrap"
import { unwrapSdkError } from "@/lib/sdkErrors"
import { driveItemDisplayName } from "@/lib/decryption"
import transfers from "@/features/transfers/transfers"
import { notEnoughStorageMessage } from "@/features/transfers/quota"
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

		// A cancelled copy's row just goes; what it made stays (or went to the trash on request).
		case "cancelled": {
			return null
		}

		case "quotaExceeded": {
			return {
				outcome: "errored",
				// The scan's total is what didn't fit; without one only the plain limit message can be said.
				errorMessage:
					job.totals.bytes > job.outcome.freeBytes
						? notEnoughStorageMessage(job.totals.bytes, job.outcome.freeBytes)
						: copyJobErrorToHumanReadable({
								kind: "MaxStorageReached",
								message: "",
								serverMessage: undefined
							})
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

// Jobs whose stop dialog is open: the job and what it made are kept for a "move to trash" answer even
// if it settles meanwhile.
const choosingCancel = new Set<string>()

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
		const id = globalThis.crypto.randomUUID()
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
		// Set when what the job made below its destination may have outrun the socket.
		let refetchDestination: { uuid: string | null } | null = null

		useCopyJobsStore.getState().put(createCopyJob(id, destination, itemCount, glyph))

		const setRowPaused = (paused: boolean) => {
			useTransfersStore.getState().setTransfers(prev => prev.map(t => (t.id === id && t.paused !== paused ? { ...t, paused } : t)))
		}

		const pauseListeners = [pause.addEventListener("pause", () => setRowPaused(true)), pause.addEventListener("resume", () => setRowPaused(false))]

		useTransfersStore.getState().setTransfers(prev => [
			...prev,
			{
				id,
				type: "copy",
				name,
				glyph,
				size: 0,
				bytesTransferred: 0,
				startedAt: Date.now(),
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
		// What the job made as it went: the fallback for "move to trash" when the SDK call rejects and
		// returns no report.
		const createdAsReported: DriveItem[] = []

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
			const bytesTransferred = effectiveBytesDone(job.counts, job.active)

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

				if (freshMaxBytes !== undefined && freshMaxBytes > maxBytes && !compositeAbort.aborted) {
					maxBytes = freshMaxBytes
					settlement = await attempt(maxBytes)
				} else if (freshMaxBytes !== undefined) {
					settlement = {
						report: settlement.report,
						maxBytes: freshMaxBytes
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

			// The final attempt's report lists what this job made, however it ended. Defensive: whether a
			// version target can appear among them is unverified. Without a report, what the callbacks saw.
			const copied = lastReport ? copiedTopLevel(lastReport) : createdAsReported
			const final = settlement

			useCopyJobsStore.getState().update(id, job => ({
				...settleCopyJob(job, final),
				created: copied
			}))

			// Nested items only reach listings as socket echoes. A socket that was down, or reconnected, at
			// any point during the job may have dropped some.
			const settledJob = getCopyJob(id)
			const socket = useSocketStore.getState()

			if (
				settledJob &&
				(settledJob.counts.dirsCreated > 0 || settledJob.counts.filesDone > 0) &&
				(socketAtStart.state !== "connected" || socket.state !== "connected" || socket.connectedAt !== socketAtStart.connectedAt)
			) {
				refetchDestination = {
					uuid: settledJob.destination.uuid
				}
			}

			return await this.settle(id)
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

				if (refetchDestination) {
					driveItemsQueryRefetchAfterSocketGap(refetchDestination.uuid)
				}
			}

			copyActivity.end()
		}
	}

	// Only top-level items; their subtrees go with them. Moved to the trash, never deleted.
	private async trashCreated(id: string): Promise<void> {
		const created = getCopyJob(id)?.created ?? []

		if (created.length === 0) {
			return
		}

		const results = await Promise.allSettled(created.map(item => trash({ item })))
		const moved = results.filter(result => result.status === "fulfilled").length

		useCopyJobsStore.getState().update(id, settled => ({
			...settled,
			trashResult: {
				moved,
				failed: results.length - moved
			}
		}))
	}

	private async settle(id: string): Promise<CopyJob | undefined> {
		const job = getCopyJob(id)

		if (!job) {
			return undefined
		}

		const finished = finishedOutcome(job)
		const row = useTransfersStore.getState().transfers.find(t => t.id === id)

		useTransfersStore.getState().setTransfers(prev => prev.filter(t => t.id !== id))

		if (finished && row) {
			useTransfersStore.getState().addFinishedTransfer({
				id,
				type: "copy",
				name: row.type === "copy" ? row.name : "",
				size: job.totals.bytes,
				bytesTransferred: job.counts.bytesDone,
				startedAt: row.startedAt,
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
				}
			})
		}

		// Honoured however the job ended: a copy that finished before the cancel reached it still made
		// what the user asked to remove.
		if (job.cancelRequest === "trash") {
			await this.trashCreated(id)
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

function copiedTopLevel(report: CopyReport): DriveItem[] {
	const targets = versionTargets(report)
	const items: DriveItem[] = []

	for (const topLevel of report.topLevel) {
		const item = createdDriveItem(topLevel.item)

		if (!targets.has(item.data.uuid)) {
			items.push(item)
		}
	}

	return items
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
		if (job.outcome.status !== "running" && !rows.has(job.id) && !choosingCancel.has(job.id)) {
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
