import * as Comlink from "comlink"
import type { AnyItemWithContext, CopyEntry } from "@filen/sdk-rs"
import {
	applyCopyUpdate,
	copyJobShownBytes,
	copyMaxBytes,
	driveItemName,
	formatBytes,
	isQuotaPreflightFailure,
	settleCopyJob,
	type QuotaCheckDeps
} from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { runOp } from "@/lib/actions/outcome"
import { asErrorDTO, plainErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { CopyReportDTO } from "@/lib/sdk/jobErrors"
import type { CopyJobEvent } from "@/workers/sdk.worker"
import { narrowItem, narrowToSdkItems, type DriveItem } from "@/features/drive/lib/item"
import { normalizeParentUuid } from "@/features/drive/queries/drive"
import { currentRootUuid, trashItems } from "@/features/drive/lib/actions"
import { type BulkOutcome } from "@/lib/actions/bulk"
import { flushDeferredRecents } from "@/features/drive/lib/socketHandlers"
import { accountQuotaDeps, addAccountStorageUsed } from "@/features/drive/lib/quota"
import { invalidateUploadedDirectorySizes } from "@/features/drive/lib/upload"
import {
	addTrashOutcome,
	directoriesBetween,
	patchJobCreatedItem,
	pruneSettledDriveJobs,
	readFreshAccount,
	STOPPED
} from "@/features/drive/lib/driveJobs"
import {
	canRetryCopy,
	copiedFileThumbnails,
	copiedTopLevel,
	copyGlyphForEntries,
	copyGlyphForItems,
	copyReportInput,
	copyUpdateInput,
	createCopyJob,
	isCopyTrashPending,
	retryEntries,
	type CopyDestination,
	type CopyJob,
	type CopyJobGlyph,
	type CopySettlement
} from "@/features/drive/lib/copy.logic"
import { reuseCopiedThumbnails } from "@/features/drive/lib/thumbnails"
import type { ThumbnailCopy } from "@/features/drive/lib/thumbnails.logic"
import { useTransfersStore, type TransfersStore } from "@/features/transfers/store/useTransfersStore"
import { getCopyJob, jobsAccess, useDriveJobsStore, type JobsAccess } from "@/features/transfers/store/useDriveJobsStore"

// A copy runs as one SDK job with one transfers row, however many items it holds. The SDK owns the
// scan, concurrency, retries and share/link propagation; this only feeds its progress into the stores
// and patches the destination listing with the top-level items it creates. Nested items reach the
// listings through the socket's own create events, so they are never inserted twice.

// "linked" carries SDK items as they came from a public link (a LinkedFile, or a linked directory with
// its link); they have no DriveItem shape to narrow from.
export type CopySource =
	| { kind: "items"; items: DriveItem[]; destinationUuid: string | null }
	| { kind: "linked"; items: AnyItemWithContext[]; destinationUuid: string | null }
	| { kind: "entries"; entries: CopyEntry[] }

type OnCopyEvent = (event: CopyJobEvent) => void

export interface RunCopyDeps {
	copyItems: (
		id: string,
		items: AnyItemWithContext[],
		destinationUuid: string | null,
		maxBytes: number | undefined,
		onEvent: OnCopyEvent
	) => Promise<CopyReportDTO>
	copyItemsTo: (id: string, entries: CopyEntry[], maxBytes: number | undefined, onEvent: OnCopyEvent) => Promise<CopyReportDTO>
	// Frees the worker's stop and pause for the job, which span its calls.
	release: (id: string) => void
	transfers: Pick<TransfersStore, "add" | "setProgress" | "setSize" | "setPaused" | "settle" | "remove">
	jobs: JobsAccess<CopyJob>
	account: QuotaCheckDeps
	patchCreated: (item: DriveItem) => void
	trash: (items: DriveItem[]) => Promise<BulkOutcome<DriveItem>>
	// `written` names the directories below the destination the job wrote into or created.
	settled: (job: CopyJob, written: readonly string[]) => void
	// Optional so tests that don't care about thumbnails omit it: gives each copied file its source's
	// cached thumbnail instead of letting its row generate one from the new copy.
	reuseThumbnails?: (copies: ThumbnailCopy[]) => void
}

export interface CopyJobRequest {
	id: string
	source: CopySource
	destination: CopyDestination
	itemCount: number
	name: string
	glyph: CopyJobGlyph
}

async function attempt(
	deps: RunCopyDeps,
	id: string,
	source: CopySource,
	maxBytes: number | undefined,
	onEvent: OnCopyEvent
): Promise<CopySettlement> {
	try {
		const report =
			source.kind === "entries"
				? await runOp(deps.copyItemsTo(id, source.entries, maxBytes, onEvent))
				: await runOp(
						deps.copyItems(
							id,
							source.kind === "items" ? narrowToSdkItems(source.items) : source.items,
							source.destinationUuid,
							maxBytes,
							onEvent
						)
					)

		return { report: copyReportInput(report), maxBytes }
	} catch (e) {
		return { error: asErrorDTO(e) }
	}
}

function quotaExceededDTO(neededBytes: number, freeBytes: number): ErrorDTO {
	return plainErrorDTO(i18n.t("transfers:transfersCopyQuotaExceeded", { needed: formatBytes(neededBytes), free: formatBytes(freeBytes) }))
}

function trashFailedDTO(count: number): ErrorDTO {
	return plainErrorDTO(i18n.t("transfers:transfersCopyTrashFailedItems", { count }))
}

// Outside runCopyJob, so the report isn't kept alive by the callbacks the worker may still hold.
function settleJob(jobs: RunCopyDeps["jobs"], id: string, settlement: CopySettlement, delivered: readonly DriveItem[]): void {
	jobs.update(id, job => {
		const settled = settleCopyJob(job, settlement)

		// Only "move copied items to trash" reads what the job made.
		return { ...settled, created: settled.cancelRequest === "trash" ? copiedTopLevel(settlement, delivered) : [] }
	})
}

function settleRow(transfers: RunCopyDeps["transfers"], id: string, job: CopyJob): void {
	// Copies the stop asked to trash that are still at the destination: the row stays, as an error, and
	// reopens the card that says so.
	if (job.trashResult !== null && job.trashResult.failed > 0) {
		transfers.settle(id, "error", trashFailedDTO(job.trashResult.failed))

		return
	}

	const { outcome } = job

	// The stop reached the copy only after it had finished, and moved every copy it made to the trash:
	// undone, it leaves no row, as when the stop came first. A failed copy keeps its error.
	if (job.trashResult !== null && (outcome.status === "done" || outcome.status === "doneWithFailures")) {
		transfers.settle(id, "cancelled")
		transfers.remove(id)

		return
	}

	switch (outcome.status) {
		case "running":
		case "done":
			transfers.settle(id, "done")

			break
		case "doneWithFailures":
			transfers.settle(id, "completedWithErrors")

			break
		case "cancelled":
			transfers.settle(id, "cancelled")
			transfers.remove(id)

			break
		case "quotaExceeded":
			transfers.settle(id, "error", quotaExceededDTO(outcome.neededBytes, outcome.freeBytes))

			break
		case "failed":
			transfers.settle(id, "error", outcome.error)

			break
	}
}

// Never throws: every way a job can end is an outcome on its job. Resolves undefined only if the job
// was dropped from the store meanwhile.
export async function runCopyJob(deps: RunCopyDeps, request: CopyJobRequest): Promise<CopyJob | undefined> {
	const { id, source, destination, itemCount, name, glyph } = request
	const row: Parameters<RunCopyDeps["transfers"]["add"]>[0] = {
		id,
		direction: "copy",
		name,
		size: 0,
		bytesTransferred: 0,
		status: "copying",
		// Keyed as the destination's listing is (null for the root), so its pending row finds it.
		parentUuid: normalizeParentUuid(destination.uuid, currentRootUuid()),
		startedAt: Date.now()
	}

	deps.jobs.put(createCopyJob(id, destination, itemCount, glyph))
	deps.transfers.add(row)

	let rowSize = 0
	// The job as it settled, and whether from a report. An event can still arrive after that: a call
	// that rejected past its cancel grace still delivers what it had queued. A created item is then only
	// patched in, or goes straight to the trash when the stop asked for that; an update adds only what
	// the settle left out.
	let settledJob: CopyJob | undefined
	let settledFromReport = false
	// The top-level items delivered before the settle, kept here rather than on the job: a store write
	// per item would copy the whole list each time. Only the settle reads them.
	let delivered: DriveItem[] = []
	// Every copy handed to the trash: one both in the report and delivered late goes once.
	const trashing = new Set<string>()

	const trashLate = async (item: DriveItem): Promise<void> => {
		if (trashing.has(item.data.uuid)) {
			return
		}

		trashing.add(item.data.uuid)

		const outcome = await deps.trash([item])
		const current = deps.jobs.get(id)

		// While the stop's own batch is still moving, that batch settles the row, this one's result included.
		if (outcome.failed.length === 0 || (current !== undefined && isCopyTrashPending(current))) {
			deps.jobs.update(id, job => ({ ...job, trashResult: addTrashOutcome(job.trashResult, outcome) }))

			return
		}

		// Left at the destination: a job dropped meanwhile comes back, with the row that says so.
		const base = deps.jobs.get(id) ?? (settledJob === undefined ? undefined : { ...settledJob, cardVisible: false })

		if (base === undefined) {
			return
		}

		const job: CopyJob = { ...base, created: [], trashResult: addTrashOutcome(base.trashResult, outcome) }

		deps.jobs.put(job)
		deps.transfers.remove(id)
		deps.transfers.add({ ...row, size: job.totals.bytes, bytesTransferred: job.counts.bytesDone })
		settleRow(deps.transfers, id, job)
	}

	const onEvent: OnCopyEvent = event => {
		if (event.type === "created") {
			// Before the patch, whose row asks for its thumbnail on the next commit. Its fileDone can come
			// after this event.
			if (event.item.item.type === "file") {
				deps.reuseThumbnails?.([{ from: event.item.sourceUuid, to: event.item.item.uuid }])
			}

			const item = narrowItem(event.item.item)

			deps.patchCreated(item)

			if (settledJob === undefined) {
				delivered.push(item)
			} else if (settledJob.cancelRequest === "trash") {
				void trashLate(item)
			}

			return
		}

		deps.reuseThumbnails?.(copiedFileThumbnails(event.update.events))

		const update = copyUpdateInput(event.update)

		// A report already lists the failures and renames its updates carried, but not their propagation
		// failures.
		if (settledJob !== undefined) {
			deps.jobs.update(id, job => {
				const merged = applyCopyUpdate(job, update)

				return settledFromReport
					? { ...job, propagationFailedCount: merged.propagationFailedCount }
					: {
							...job,
							failures: merged.failures,
							renamedCount: merged.renamedCount,
							savedAsVersionCount: merged.savedAsVersionCount,
							propagationFailedCount: merged.propagationFailedCount
						}
			})

			return
		}

		deps.jobs.update(id, job => applyCopyUpdate(job, update))

		const job = deps.jobs.get(id)

		if (job === undefined) {
			return
		}

		// The total grows while the scan finds more to copy.
		if (job.totals.bytes !== rowSize) {
			rowSize = job.totals.bytes
			deps.transfers.setSize(id, rowSize)
		}

		deps.transfers.setProgress(id, copyJobShownBytes(job))
	}

	const cancelRequested = (): boolean => deps.jobs.get(id)?.cancelRequest != null
	let maxBytes = copyMaxBytes(deps.account.cached())
	let settlement = await attempt(deps, id, source, maxBytes, onEvent)

	// A cached figure can predate a delete made elsewhere, so a pre-flight refusal reads it once fresh
	// and runs again only if that frees enough to matter to the SDK's own check.
	if ("report" in settlement && isQuotaPreflightFailure(settlement.report) && maxBytes !== undefined && !cancelRequested()) {
		const freshMaxBytes = copyMaxBytes(await readFreshAccount(deps.account))

		if (freshMaxBytes !== undefined && freshMaxBytes > maxBytes && !cancelRequested()) {
			maxBytes = freshMaxBytes
			settlement = await attempt(deps, id, source, maxBytes, onEvent)
		} else if (freshMaxBytes !== undefined && freshMaxBytes <= maxBytes) {
			// Never a figure the SDK's own check didn't refuse.
			settlement = { report: settlement.report, maxBytes: freshMaxBytes }
		}
	}

	// Refused before anything was written, by a job stopped meanwhile: it ends as the stop it was.
	if ("report" in settlement && isQuotaPreflightFailure(settlement.report) && cancelRequested()) {
		settlement = { ...settlement, report: { ...settlement.report, error: STOPPED } }
	}

	deps.release(id)
	settleJob(deps.jobs, id, settlement, delivered)

	const written = writtenDirectories(source, destination.uuid, delivered)

	// Let go of them: the worker may still hold the callbacks.
	delivered = []

	settledJob = deps.jobs.get(id)
	settledFromReport = "report" in settlement

	if (settledJob === undefined) {
		return undefined
	}

	deps.transfers.setSize(id, settledJob.totals.bytes)
	deps.transfers.setProgress(id, settledJob.counts.bytesDone)

	// Honoured however the job ended: a copy that finished before the cancel reached it still made what
	// the user asked to remove. Only top-level items are trashed; their subtrees go with them. The row
	// stays active until then, which also keeps the tab from closing on the trash, but nothing on it is
	// paused any more.
	if (settledJob.created.length > 0) {
		deps.transfers.setPaused(id, false)

		for (const item of settledJob.created) {
			trashing.add(item.data.uuid)
		}

		const outcome = await deps.trash(settledJob.created)

		deps.jobs.update(id, job => ({ ...job, created: [], trashResult: addTrashOutcome(job.trashResult, outcome) }))
		settledJob = deps.jobs.get(id) ?? { ...settledJob, created: [], trashResult: addTrashOutcome(settledJob.trashResult, outcome) }
	}

	const job = settledJob

	settleRow(deps.transfers, id, job)
	deps.settled(job, written)

	return job
}

function copyRowName(itemCount: number, firstName: string): string {
	return itemCount === 1 ? firstName : i18n.t("transfers:transfersCopyRowName", { count: itemCount })
}

// The directories below the destination whose recursive size the job moved: the top-level directories it
// created, and for a retry every directory from where each item was meant to land up to the destination.
function writtenDirectories(source: CopySource, destinationUuid: string | null, delivered: readonly DriveItem[]): string[] {
	const created = delivered.flatMap(item => (item.type === "directory" ? [item.data.uuid] : []))

	return source.kind === "entries"
		? directoriesBetween(
				source.entries.map(entry => entry.destination),
				destinationUuid,
				created
			)
		: created
}

// No toast: the card, or the transfers row, shows how the copy ended.
function afterCopySettled(job: CopyJob, written: readonly string[]): void {
	flushDeferredRecents()

	if (job.counts.bytesDone > 0) {
		addAccountStorageUsed(BigInt(job.counts.bytesDone), { readNow: true })
	}

	if (job.counts.dirsCreated > 0 || job.counts.filesDone > 0) {
		invalidateUploadedDirectorySizes(job.destination.uuid, written)
	}

	pruneSettledDriveJobs()
}

export const defaultCopyDeps: RunCopyDeps = {
	copyItems: (id, items, destinationUuid, maxBytes, onEvent) =>
		sdkApi.copyItems(id, items, destinationUuid, maxBytes, Comlink.proxy(onEvent)),
	copyItemsTo: (id, entries, maxBytes, onEvent) => sdkApi.copyItemsTo(id, entries, maxBytes, Comlink.proxy(onEvent)),
	release: id => {
		void sdkApi.releaseJob(id)
	},
	transfers: useTransfersStore.getState(),
	jobs: jobsAccess("copy"),
	account: accountQuotaDeps,
	patchCreated: patchJobCreatedItem,
	trash: trashItems,
	settled: afterCopySettled,
	reuseThumbnails: reuseCopiedThumbnails
}

// Starts the copy and returns its job id at once; the job outlives whatever started it. The UI shows its
// card (features/transfers/lib/copyToast.tsx's startCopyWithCard), keeping this module free of it.
export function startCopy(items: DriveItem[], destination: CopyDestination): string | null {
	const first = items[0]

	if (first === undefined) {
		return null
	}

	const id = crypto.randomUUID()

	void runCopyJob(defaultCopyDeps, {
		id,
		source: { kind: "items", items, destinationUuid: destination.uuid },
		destination,
		itemCount: items.length,
		name: copyRowName(items.length, driveItemName(first)),
		glyph: copyGlyphForItems(items)
	})

	return id
}

// Saves what a public link points at (the whole linked file or directory) into the caller's own drive.
export function startLinkedCopy(item: AnyItemWithContext, name: string, glyph: CopyJobGlyph, destination: CopyDestination): string {
	const id = crypto.randomUUID()

	void runCopyJob(defaultCopyDeps, {
		id,
		source: { kind: "linked", items: [item], destinationUuid: destination.uuid },
		destination,
		itemCount: 1,
		name,
		glyph
	})

	return id
}

// A new job for what the given one could not copy, each item back into the directory it was meant for.
// It supersedes the given one, which would only copy the same items again: that one offers no retry
// any more and loses its row, so it goes once its card does. A row reporting copies its stop couldn't
// move to the trash stays, as nothing else says they are still at the destination.
export function retryFailedCopy(jobId: string): string | null {
	const job = getCopyJob(jobId)
	const first = job?.retryable[0]

	if (job === undefined || first === undefined || !canRetryCopy(job)) {
		return null
	}

	const id = crypto.randomUUID()

	const entries = retryEntries(job.retryable)

	void runCopyJob(defaultCopyDeps, {
		id,
		source: { kind: "entries", entries },
		destination: job.destination,
		itemCount: job.retryable.length,
		name: copyRowName(job.retryable.length, first.info.destName),
		glyph: copyGlyphForEntries(entries)
	})

	useDriveJobsStore.getState().update("copy", jobId, retried => ({ ...retried, retryable: [] }))

	if ((job.trashResult?.failed ?? 0) === 0) {
		useTransfersStore.getState().remove(jobId)
	}

	pruneSettledDriveJobs()

	return id
}
