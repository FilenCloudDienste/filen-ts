import * as Comlink from "comlink"
import type { CopyEntry, CopyItem, CopyReport } from "@filen/sdk-rs"
import {
	applyCopyCreated,
	applyCopyUpdate,
	copyMaxBytes,
	driveItemName,
	formatBytes,
	isQuotaPreflightFailure,
	settleCopyJob,
	type QuotaCheckDeps,
	type StorageCounters
} from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { runOp } from "@/lib/actions/outcome"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { CopyJobEvent } from "@/workers/sdk.worker"
import { narrowItem, narrowToSdkItems, upsertDriveItem, type DriveItem } from "@/features/drive/lib/item"
import { driveListingQueryUpdate, invalidateDirectorySize, normalizeParentUuid } from "@/features/drive/queries/drive"
import { currentRootUuid, trashItems } from "@/features/drive/lib/actions"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import { flushDeferredRecents } from "@/features/drive/lib/socketHandlers"
import { accountQuotaDeps, addAccountStorageUsed } from "@/features/drive/lib/quota"
import {
	copyGlyphForEntries,
	copyGlyphForItems,
	copyReportInput,
	copyUpdateInput,
	createCopyJob,
	retryEntries,
	type CopyDestination,
	type CopyJob,
	type CopyJobGlyph,
	type CopyJobOutcome,
	type CopySettlement
} from "@/features/drive/lib/copy.logic"
import { useTransfersStore, type TransfersStore } from "@/features/transfers/store/useTransfersStore"
import { getCopyJob, useCopyJobsStore, type CopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"

// A copy runs as one SDK job with one transfers row, however many items it holds. The SDK owns the
// scan, concurrency, retries and share/link propagation; this only feeds its progress into the stores
// and patches the destination listing with the top-level items it creates. Nested items reach the
// listings through the socket's own create events, so they are never inserted twice.

// "linked" carries SDK items as they came from a public link (a LinkedFile, or a linked directory with
// its link); they have no DriveItem shape to narrow from.
export type CopySource =
	| { kind: "items"; items: DriveItem[]; destinationUuid: string | null }
	| { kind: "linked"; items: CopyItem[]; destinationUuid: string | null }
	| { kind: "entries"; entries: CopyEntry[] }

type OnCopyEvent = (event: CopyJobEvent) => void

export interface RunCopyDeps {
	copyItems: (
		id: string,
		items: CopyItem[],
		destinationUuid: string | null,
		maxBytes: number | undefined,
		onEvent: OnCopyEvent
	) => Promise<CopyReport>
	copyItemsTo: (id: string, entries: CopyEntry[], maxBytes: number | undefined, onEvent: OnCopyEvent) => Promise<CopyReport>
	transfers: Pick<TransfersStore, "add" | "setProgress" | "setSize" | "settle" | "remove">
	jobs: Pick<CopyJobsStore, "put" | "update"> & { get: (id: string) => CopyJob | undefined }
	account: QuotaCheckDeps
	patchCreated: (item: DriveItem) => void
	trash: (items: DriveItem[]) => Promise<BulkOutcome<DriveItem>>
	settled: (job: CopyJob) => void
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

async function readFreshAccount(account: QuotaCheckDeps): Promise<StorageCounters | undefined> {
	try {
		return await account.fetchFresh()
	} catch {
		return undefined
	}
}

function quotaExceededDTO(freeBytes: number): ErrorDTO {
	const message = i18n.t("transfers:transfersCopyQuotaExceeded", { free: formatBytes(freeBytes) })

	return { species: "plain", message, label: message }
}

function settleRow(transfers: RunCopyDeps["transfers"], id: string, outcome: CopyJobOutcome): void {
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
			transfers.settle(id, "error", quotaExceededDTO(outcome.freeBytes))

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

	deps.jobs.put(createCopyJob(id, destination, itemCount, glyph))
	deps.transfers.add({
		id,
		direction: "copy",
		name,
		size: 0,
		bytesTransferred: 0,
		status: "copying",
		parentUuid: destination.uuid,
		startedAt: Date.now()
	})

	let rowSize = 0

	const onEvent: OnCopyEvent = event => {
		if (event.type === "created") {
			const item = narrowItem(event.item.item)

			deps.jobs.update(id, job => applyCopyCreated(job, item))
			deps.patchCreated(item)

			return
		}

		deps.jobs.update(id, job => applyCopyUpdate(job, copyUpdateInput(event.update)))

		const job = deps.jobs.get(id)

		if (job === undefined) {
			return
		}

		// The total grows while the scan finds more to copy.
		if (job.totals.bytes !== rowSize) {
			rowSize = job.totals.bytes
			deps.transfers.setSize(id, rowSize)
		}

		deps.transfers.setProgress(id, job.counts.bytesDone)
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
		} else if (freshMaxBytes !== undefined) {
			settlement = { report: settlement.report, maxBytes: freshMaxBytes }
		}
	}

	deps.jobs.update(id, job => settleCopyJob(job, settlement))

	const job = deps.jobs.get(id)

	if (job === undefined) {
		return undefined
	}

	deps.transfers.setSize(id, job.totals.bytes)
	deps.transfers.setProgress(id, job.counts.bytesDone)
	settleRow(deps.transfers, id, job.outcome)

	// Honoured however the job ended: a copy that finished before the cancel reached it still made
	// what the user asked to remove. Only top-level items are trashed; their subtrees go with them.
	const trashed = job.cancelRequest === "trash" && job.created.length > 0 ? await deps.trash(job.created) : null

	if (trashed !== null) {
		deps.jobs.update(id, settled => ({ ...settled, trashResult: { moved: trashed.succeeded.length, failed: trashed.failed.length } }))
	}

	const settled = deps.jobs.get(id) ?? job

	deps.settled(settled)

	return settled
}

// A settled job stays while its card shows or its transfers row can reopen the card.
export function pruneSettledCopyJobs(): void {
	const rows = new Set(useTransfersStore.getState().transfers.map(transfer => transfer.id))

	for (const job of Object.values(useCopyJobsStore.getState().jobs)) {
		if (job.outcome.status !== "running" && !job.cardVisible && !rows.has(job.id)) {
			useCopyJobsStore.getState().remove(job.id)
		}
	}
}

function copyRowName(itemCount: number, firstName: string): string {
	return itemCount === 1 ? firstName : i18n.t("transfers:transfersCopyRowName", { count: itemCount })
}

// The destination listing is usually the one on screen; one nobody has read is left to its first read.
function patchCopiedItem(item: DriveItem): void {
	driveListingQueryUpdate(normalizeParentUuid(item.data.parent, currentRootUuid()), prev => upsertDriveItem(prev, item))
}

// No toast: the card, or the transfers row, shows how the copy ended.
function afterCopySettled(job: CopyJob): void {
	flushDeferredRecents()

	if (job.counts.bytesDone > 0) {
		addAccountStorageUsed(BigInt(job.counts.bytesDone))
	}

	if (job.counts.dirsCreated > 0 || job.counts.filesDone > 0) {
		invalidateDirectorySize(job.destination.uuid)
	}

	pruneSettledCopyJobs()
}

export const defaultCopyDeps: RunCopyDeps = {
	copyItems: (id, items, destinationUuid, maxBytes, onEvent) =>
		sdkApi.copyItems(id, items, destinationUuid, maxBytes, Comlink.proxy(onEvent)),
	copyItemsTo: (id, entries, maxBytes, onEvent) => sdkApi.copyItemsTo(id, entries, maxBytes, Comlink.proxy(onEvent)),
	transfers: useTransfersStore.getState(),
	jobs: { ...useCopyJobsStore.getState(), get: getCopyJob },
	account: accountQuotaDeps,
	patchCreated: patchCopiedItem,
	trash: trashItems,
	settled: afterCopySettled
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
export function startLinkedCopy(item: CopyItem, name: string, glyph: CopyJobGlyph, destination: CopyDestination): string {
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
export function retryFailedCopy(jobId: string): string | null {
	const job = getCopyJob(jobId)
	const first = job?.retryable[0]

	if (job === undefined || first === undefined) {
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

	return id
}

// The job settles as cancelled through its own report; trashCopied then moves its top-level items to
// the trash (never a permanent delete).
export function requestCopyCancel(jobId: string, options: { trashCopied: boolean }): void {
	if (getCopyJob(jobId)?.outcome.status !== "running") {
		return
	}

	useCopyJobsStore.getState().update(jobId, job => ({ ...job, cancelRequest: options.trashCopied ? "trash" : "keep" }))
	void sdkApi.cancelCopy(jobId)
}
