import * as Comlink from "comlink"
import type { ArchiveEntryId } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { ErrorWithDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"
import { settleGuard } from "@/lib/workers/settleGuard"
import type { ByteOrigin, EntryAccessKind } from "@/lib/sdk/byteOrigin"
import type { ListReportDTO } from "@/lib/sdk/jobErrors"
import type { EntryReadPlan, PackedEntryBatch } from "@/lib/sdk/archiveListing"
import type { ListJobEvent, ListJobParams } from "@/workers/sdk.worker"
import { acquireArchiveReader, fileTarget, type ArchiveReaderRef, type ReaderTarget } from "@/features/archive/lib/archiveReaders"
import type { EntryReaderEvents } from "@/workers/originSource"
import { listSummaryOf, type ListSummary } from "@/features/archive/lib/listingSession"
import { canReadEntry, entryKey, lonePlan, maxSolidSkipFor } from "@/features/archive/lib/entryAccess.logic"
import type { EntryStore } from "@/features/archive/lib/entryStore"

// One archive opened for listing and for reading its entries, through the SDK's archive reader it shares with every
// other caller of the same archive and password (archiveReaders.ts): the index is read once, and an entry read
// after another reuses what the reader holds.

// An entry's origin, holding a reference to its reader until released.
export interface LeasedOrigin {
	readonly origin: ByteOrigin
	readonly release: () => void
}

export interface ArchiveListOptions {
	readonly signal: AbortSignal
	// Another archive job holds the page's slot, or no longer does.
	readonly onWaiting?: (waiting: boolean) => void
}

export interface ArchiveHandle {
	// The reader's id.
	readonly id: string
	// Lists every entry into `onBatch`; rejects with the listing's error (ErrorWithDTO), or Cancelled once `signal` aborts.
	list(onBatch: (batch: PackedEntryBatch) => void, options: ArchiveListOptions): Promise<ListSummary>
	// The file entry stored at `path` ("/"-separated from the archive's root): spelled exactly, else spelled the same up
	// to ASCII case. Null when there is none.
	findByPath(store: EntryStore, path: string): number | null
	// The origin a viewer reads the listed entry at `slot` through; `events` hears its reads.
	origin(store: EntryStore, slot: number, events?: EntryReaderEvents): Promise<LeasedOrigin>
	// Drops this reference; the reader closes once the last is gone.
	release(): void
}

// What opening an archive gave: its handle, or why it cannot be opened (one inside another archive, or bytes the page
// holds, need the SDK's nested reader).
export type ArchiveHandleResult =
	{ readonly type: "opened"; readonly handle: ArchiveHandle } | { readonly type: "refused"; readonly reason: "needsArchiveReader" }

export type ArchiveRefusal = Extract<ArchiveHandleResult, { type: "refused" }>["reason"]

// Why `origin`'s archive cannot be opened; null when it can: a drive file, or a public link's.
export function archiveHandleRefusal(origin: ByteOrigin): ArchiveRefusal | null {
	return origin.kind === "file" || origin.kind === "linkedFile" ? null : "needsArchiveReader"
}

export interface ArchiveHandleDeps {
	acquireReader: (target: ReaderTarget, password: string | undefined) => ArchiveReaderRef
	listArchive: (readerId: string, jobId: string, params: ListJobParams, onEvent: (event: ListJobEvent) => void) => Promise<ListReportDTO>
	cancelJob: (jobId: string) => void
	releaseJob: (jobId: string) => void
	leaseEntry: (leaseId: string, readerId: string, plan: EntryReadPlan, events: EntryReaderEvents) => void
	releaseLease: (leaseId: string) => void
	newId: () => string
}

export const NO_EVENTS: EntryReaderEvents = {
	phase: () => undefined,
	verified: () => undefined,
	failed: () => undefined
}

export const defaultArchiveHandleDeps: ArchiveHandleDeps = {
	acquireReader: (target, password) => acquireArchiveReader(target, password),
	listArchive: (readerId, jobId, params, onEvent) => sdkApi.listArchiveReader(readerId, jobId, params, Comlink.proxy(onEvent)),
	cancelJob: jobId => {
		void sdkApi.cancelTransfer(jobId)
	},
	releaseJob: jobId => {
		void sdkApi.releaseJob(jobId)
	},
	leaseEntry: (leaseId, readerId, plan, events) => {
		sdkApi.leaseArchiveEntry(leaseId, readerId, plan, Comlink.proxy(events)).catch((e: unknown) => {
			log.warn("archiveHandle", "leasing an entry failed", e)
		})
	},
	releaseLease: leaseId => {
		sdkApi.releaseArchiveEntry(leaseId).catch((e: unknown) => {
			log.warn("archiveHandle", "releasing an entry lease failed", e)
		})
	},
	newId: () => crypto.randomUUID()
}

// The origin the lease `leaseId` (leaseEntry) names the entry `index` of the archive `archiveUuid` (its ReaderTarget's
// uuid) by. `access`: how its bytes are read (entryAccessOf); a whole read, checked, unless the reader said it maps or
// seeks.
export function entryLeaseOrigin(
	leaseId: string,
	archiveUuid: string,
	anon: boolean,
	index: number,
	size: number,
	access: EntryAccessKind = "whole"
): ByteOrigin {
	return {
		kind: "entry",
		reader: leaseId,
		entry: { archive: archiveUuid as ArchiveEntryId["archive"], index },
		size,
		access,
		anon,
		cacheKey: entryKey(archiveUuid, index)
	}
}

// How the archive's entry `index` can be read, asked of its reader for `password` (held for the call): mapped or
// seekable entries are read by range (media, a database), others whole. `signal` cancels the question and what its
// answer reads (a tar's listing, read again when the reader gave it up).
export async function entryAccessOf(
	target: ReaderTarget,
	password: string | undefined,
	index: number,
	signal?: AbortSignal
): Promise<EntryAccessKind> {
	signal?.throwIfAborted()

	const reader = acquireArchiveReader(target, password)
	const token = crypto.randomUUID()
	const cancel = (): void => {
		void sdkApi.cancelPreviewDownload(token)
	}

	signal?.addEventListener("abort", cancel, { once: true })

	try {
		return await sdkApi.archiveEntryAccess(reader.id, { archive: target.uuid as ArchiveEntryId["archive"], index }, token)
	} finally {
		signal?.removeEventListener("abort", cancel)
		reader.release()
	}
}

export interface EntryLeaseRequest {
	readonly leaseId: string
	// The archive (a file's, or one nested in it).
	readonly target: ReaderTarget
	readonly password: string | undefined
	// How its whole read goes (entryReadPlan, lonePlan).
	readonly plan: EntryReadPlan
	readonly events: EntryReaderEvents
}

// Leases an entry as `leaseId`, read whole through the reader of its archive and password as `plan` says, holding a
// reference on that reader until released. Comlink delivers calls in order, so the origin reads at once. Returns the
// release.
export function leaseEntry(request: EntryLeaseRequest, deps: ArchiveHandleDeps = defaultArchiveHandleDeps): () => void {
	const reader = deps.acquireReader(request.target, request.password)
	let leased = true
	// An event that arrives after the release (a read the worker reported before it heard of it) belongs to no lease.
	const { events } = request

	deps.leaseEntry(request.leaseId, reader.id, request.plan, {
		phase: phase => {
			if (leased) events.phase(phase)
		},
		verified: () => {
			if (leased) events.verified()
		},
		failed: error => {
			if (leased) events.failed(error)
		}
	})

	return () => {
		if (leased) {
			leased = false
			deps.releaseLease(request.leaseId)
			reader.release()
		}
	}
}

// Lowercases A–Z only: the match a name spelled differently in case gets, whatever its other letters.
function asciiLower(value: string): string {
	return value.replace(/[A-Z]/g, char => char.toLowerCase())
}

// The directory node at `path` ("" the root), each segment spelled exactly, else the same up to ASCII case; -1 when
// there is none. Not findDir, whose key folds every letter's case.
function findDirByPath(store: EntryStore, path: string): number {
	let dir = 0

	for (const segment of path === "" ? [] : path.split("/")) {
		const children = store.childDirs(dir)
		const folded = asciiLower(segment)

		dir =
			children.find(child => store.dirName(child) === segment) ??
			children.find(child => asciiLower(store.dirName(child)) === folded) ??
			-1

		if (dir === -1) {
			return -1
		}
	}

	return dir
}

function findByPath(store: EntryStore, path: string): number | null {
	const cut = path.lastIndexOf("/")
	const dir = findDirByPath(store, cut === -1 ? "" : path.slice(0, cut))

	if (dir === -1) {
		return null
	}

	const name = path.slice(cut + 1)
	const folded = asciiLower(name)
	let match: number | null = null

	for (const slot of store.childEntries(dir)) {
		if (!canReadEntry(store, slot)) {
			continue
		}

		const own = store.name(slot)

		if (own === name) {
			return slot
		}

		if (match === null && asciiLower(own) === folded) {
			match = slot
		}
	}

	return match
}

// The archive `origin` names, opened (or joined, when open already) under `password`; refused (archiveHandleRefusal),
// never thrown at the caller.
export function acquireArchiveHandle(
	origin: ByteOrigin,
	password: string | undefined,
	deps: ArchiveHandleDeps = defaultArchiveHandleDeps
): ArchiveHandleResult {
	if (origin.kind !== "file" && origin.kind !== "linkedFile") {
		return { type: "refused", reason: "needsArchiveReader" }
	}

	return { type: "opened", handle: openArchiveHandle(fileTarget(origin.file, origin.kind === "linkedFile"), password, deps) }
}

// The archive `target` names (a file's, or one held in another's entry through its parent's reader), opened or joined
// under `password`.
export function openArchiveHandle(
	target: ReaderTarget,
	password: string | undefined,
	deps: ArchiveHandleDeps = defaultArchiveHandleDeps
): ArchiveHandle {
	const reader = deps.acquireReader(target, password)
	let released = false

	const handle: ArchiveHandle = {
		id: reader.id,
		list: (onBatch, { signal, onWaiting }) => {
			const jobId = deps.newId()
			const cancel = (): void => {
				deps.cancelJob(jobId)
			}
			// An event that arrives after the report would hand its batch over a second time.
			const events = settleGuard((event: ListJobEvent) => {
				if (event.type === "entries") {
					onBatch(event.batch)
				} else {
					onWaiting?.(event.update.phase === "waitingForWorker")
				}
			})
			const listed = deps
				.listArchive(reader.id, jobId, { deliverEntries: true, keepReportEntries: false }, events.callback)
				.finally(events.settle)

			// An abort before the job started cancels it as soon as it does.
			if (signal.aborted) {
				cancel()
			} else {
				signal.addEventListener("abort", cancel, { once: true })
			}

			return listed
				.then(report => {
					if (report.error !== undefined) {
						throw new ErrorWithDTO(report.error)
					}

					return listSummaryOf(report)
				})
				.finally(() => {
					signal.removeEventListener("abort", cancel)
					// Only once the call settled: a released id would orphan a job still winding down.
					deps.releaseJob(jobId)
				})
		},
		findByPath,
		origin: (store, slot, events) => {
			if (released || !reader.isOpen()) {
				return Promise.reject(new Error("the archive handle is closed"))
			}

			const leaseId = `${reader.id}:${deps.newId()}`
			const index = store.index(slot)
			const size = store.size(slot)
			const release = leaseEntry(
				{
					leaseId,
					target,
					password: reader.password,
					plan: lonePlan(index, size, maxSolidSkipFor(store, slot)),
					events: events ?? NO_EVENTS
				},
				deps
			)

			return Promise.resolve({ origin: entryLeaseOrigin(leaseId, target.uuid, reader.anon, index, size), release })
		},
		release: () => {
			if (released) {
				return
			}

			released = true
			reader.release()
		}
	}

	return handle
}
