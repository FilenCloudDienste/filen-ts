import * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { ErrorWithDTO } from "@/lib/sdk/errors"
import { originKey, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import type { ListReportDTO } from "@/lib/sdk/jobErrors"
import type { PackedEntryBatch } from "@/lib/sdk/archiveListing"
import type { ListJobEvent, ListJobParams } from "@/workers/sdk.worker"
import type { EntryReaderEvents } from "@/workers/originSource"
import { registerPreviewDisposer } from "@/lib/workers/previewDisposers"
import { listSummaryOf, type ListSummary } from "@/features/archive/lib/listingSession"
import { canReadEntry, entryKey, maxSolidSkipFor } from "@/features/archive/lib/entryAccess.logic"
import type { EntryStore } from "@/features/archive/lib/entryStore"

// One archive opened for listing and for reading its entries, shared by every viewer of the same archive. Until the
// SDK has archive readers, a handle lists through listArchive and reads an entry whole through an entry reader
// (openEntryReader), so each call reads the archive's index again; its callers stay as they are once it holds one.

// An entry's origin, holding a reference to its handle until released.
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
	readonly id: string
	// Lists every entry into `onBatch`; rejects with the listing's error (ErrorWithDTO), or Cancelled once `signal` aborts.
	list(onBatch: (batch: PackedEntryBatch) => void, options: ArchiveListOptions): Promise<ListSummary>
	// The file entry stored at `path` ("/"-separated from the archive's root): spelled exactly, else spelled the same up
	// to ASCII case. Null when there is none.
	findByPath(store: EntryStore, path: string): number | null
	// The origin a viewer reads the listed entry at `slot` through; `events` hears its reads.
	origin(store: EntryStore, slot: number, events?: EntryReaderEvents): Promise<LeasedOrigin>
	// Drops this reference; the archive closes with the last one.
	release(): void
}

export interface ArchiveHandleDeps {
	listArchive: (
		jobId: string,
		params: ListJobParams,
		password: string | undefined,
		onEvent: (event: ListJobEvent) => void
	) => Promise<ListReportDTO>
	cancelJob: (jobId: string) => void
	releaseJob: (jobId: string) => void
	openEntryReader: (
		readerId: string,
		archive: AnyFile,
		password: string | undefined,
		solidSkips: ReadonlyMap<number, number>,
		events: EntryReaderEvents
	) => void
	releaseEntryReader: (readerId: string) => void
	newId: () => string
}

const NO_EVENTS: EntryReaderEvents = {
	phase: () => undefined,
	verified: () => undefined,
	failed: () => undefined
}

export const defaultArchiveHandleDeps: ArchiveHandleDeps = {
	listArchive: (jobId, params, password, onEvent) => sdkApi.listArchive(jobId, params, password, Comlink.proxy(onEvent)),
	cancelJob: jobId => {
		void sdkApi.cancelTransfer(jobId)
	},
	releaseJob: jobId => {
		void sdkApi.releaseJob(jobId)
	},
	openEntryReader: (readerId, archive, password, solidSkips, events) => {
		void sdkApi.openEntryReader(readerId, archive, password, solidSkips, Comlink.proxy(events))
	},
	releaseEntryReader: readerId => {
		void sdkApi.releaseEntryReader(readerId)
	},
	newId: () => crypto.randomUUID()
}

// One open archive and everything reading through it: the handles acquired on it and the leases they gave out.
interface OpenArchive {
	readonly id: string
	readonly key: string
	readonly file: AnyFile
	refs: number
	readonly leases: Set<() => void>
	unregister: () => void
}

const openArchives = new Map<string, OpenArchive>()

// Lowercases A–Z only: the match a name spelled differently in case gets, whatever its other letters.
function asciiLower(value: string): string {
	return value.replace(/[A-Z]/g, char => char.toLowerCase())
}

function findByPath(store: EntryStore, path: string): number | null {
	const cut = path.lastIndexOf("/")
	const dir = cut === -1 ? 0 : store.findDir(path.slice(0, cut))

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

function closeArchive(open: OpenArchive): void {
	openArchives.delete(open.key)
	open.unregister()

	for (const release of [...open.leases]) {
		release()
	}
}

// The archive `origin` names, opened (or joined, when open already) under `password`. Only a drive file opens before
// the SDK has archive readers: a public link's archive, and one inside another, need one.
export function acquireArchiveHandle(
	origin: ByteOrigin,
	password: string | undefined,
	deps: ArchiveHandleDeps = defaultArchiveHandleDeps
): ArchiveHandle {
	if (origin.kind !== "file") {
		throw new Error(`a ${origin.kind} origin's archive needs the SDK's archive reader`)
	}

	const key = `${origin.kind}:${originKey(origin)}`
	let open = openArchives.get(key)

	if (open === undefined) {
		const created: OpenArchive = { id: deps.newId(), key, file: origin.file, refs: 0, leases: new Set(), unregister: () => undefined }

		created.unregister = registerPreviewDisposer("archiveHandle", () => {
			created.unregister = () => undefined
			closeArchive(created)
		})
		openArchives.set(key, created)
		open = created
	}

	const archive = open
	let released = false

	archive.refs += 1

	const unref = (): void => {
		archive.refs -= 1

		if (archive.refs === 0 && openArchives.get(archive.key) === archive) {
			closeArchive(archive)
		}
	}

	return {
		id: archive.id,
		list: (onBatch, { signal, onWaiting }) => {
			const jobId = deps.newId()
			const cancel = (): void => {
				deps.cancelJob(jobId)
			}
			const listed = deps.listArchive(
				jobId,
				{ archive: archive.file, skipMacMetadata: true, deliverEntries: true, keepReportEntries: false },
				password,
				event => {
					if (event.type === "entries") {
						onBatch(event.batch)
					} else {
						onWaiting?.(event.update.phase === "waitingForWorker")
					}
				}
			)

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
			if (released || openArchives.get(archive.key) !== archive) {
				return Promise.reject(new Error("the archive handle is closed"))
			}

			const index = store.index(slot)
			const readerId = `${archive.id}:${deps.newId()}`
			let leased = true

			const end = (): void => {
				if (!leased) {
					return
				}

				leased = false
				archive.leases.delete(end)
				deps.releaseEntryReader(readerId)
				unref()
			}

			archive.refs += 1
			archive.leases.add(end)
			deps.openEntryReader(readerId, archive.file, password, new Map([[index, maxSolidSkipFor(store, slot)]]), events ?? NO_EVENTS)

			return Promise.resolve({
				origin: {
					kind: "entry",
					reader: readerId,
					entry: { archive: archive.file.uuid, index },
					size: store.size(slot),
					access: "whole",
					anon: false,
					cacheKey: entryKey(archive.file.uuid, index)
				},
				release: end
			})
		},
		release: () => {
			if (released) {
				return
			}

			released = true
			unref()
		}
	}
}
