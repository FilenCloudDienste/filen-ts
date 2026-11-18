import type {
	AnyFile,
	ArchiveEntry,
	ArchiveEntryId,
	ArchiveFormat,
	ArchiveReader,
	EmbeddedPreviewResult,
	EntryByteAccess,
	EntryDownloadPhase,
	EntryDownloadReport,
	EntryDownloadUpdate,
	ListReport,
	ListUpdate,
	ManagedFuture
} from "@filen/sdk-rs"
import { ErrorWithDTO } from "@/lib/sdk/errors"
import { liftError } from "@/lib/sdk/jobErrors"
import { raceAbort } from "@/lib/abort"
import { log } from "@/lib/log"
import type { EntryReadPlan } from "@/lib/sdk/archiveListing"

// The SDK's archive readers this worker holds, one per archive and password the page opened. A reader reads its
// archive's index once and serves every listing, download and entry read after it from what it holds (the index, a
// tar's member table, the chunks and decoder states read last, within the client's retained budget).
//
// An entry read whole goes the cheapest way the entry allows:
// - a member of a gzip tar through range reads, which decode on from where the read before stopped (a page after a
//   page costs about the page);
// - a solid block's entry (a solid 7z's, a solid RAR's, another compressed tar's member) through an ordered pass over
//   it and the files stored after it, the window the page planned: those it decoded anyway are kept for their own
//   read (and a save), so a run of entries read one after another decodes the block about once per window;
// - anything else through a checked download of the entry alone.
//
// Lifetimes: a reader opens on its first call, under a controller of its own that every waiter shares (one leaving
// cancels nothing for the others; the last one leaving cancels the opening). Every call runs under the reader's own
// signal too, which closing it aborts, so nothing keeps fetching after a close or sign-out. A closed reader is freed
// only once its last call settled: wasm-bindgen refuses to free a value a pending call still borrows.

// A reader with no lease for this long gives up what it read ahead: the user left the entry viewer, not a page turn.
export const READ_AHEAD_IDLE_MS = 10_000

export type ReaderLike = Pick<
	ArchiveReader,
	| "format"
	| "archiveId"
	| "list"
	| "entryByteAccess"
	| "downloadEntry"
	| "readEntryRange"
	| "readEntries"
	| "writeEntryEmbeddedPreview"
	| "openNested"
	| "close"
	| "free"
>

export interface ReaderOpenRequest {
	readonly archive: AnyFile
	// Opened through the public-link client, never the session's.
	readonly anon: boolean
	readonly password: string | undefined
	readonly onUpdate: (update: ListUpdate) => void
	readonly managedFuture: ManagedFuture
}

export interface OpenedReader {
	readonly reader: ReaderLike
	// Frees the reader and whatever client handle it was opened on.
	readonly release: () => void
}

export interface NestedOpenRequest {
	readonly parent: ReaderLike
	// The entry holding the archive, as the parent reader names it.
	readonly entry: ArchiveEntryId
	// The nested archive's own.
	readonly password: string | undefined
	readonly managedFuture: ManagedFuture
}

export interface ArchiveReaderDeps {
	open: (request: ReaderOpenRequest) => Promise<OpenedReader>
	// An archive inside another's entry, read through the parent reader (ArchiveReader.openNested).
	openNested?: (request: NestedOpenRequest) => Promise<OpenedReader>
	// What every reader may hold decoded ahead, in all (readAheadBudget).
	aheadBudget: () => number
	setTimer?: (run: () => void, ms: number) => () => void
}

export interface EntryReadEvents {
	phase: (phase: EntryDownloadPhase) => void
	verified: () => void
	failed: (error: unknown) => void
}

interface Ahead {
	readonly bytes: Uint8Array
	readonly checked: boolean
}

interface Opening {
	readonly promise: Promise<OpenedReader>
	readonly controller: AbortController
	readonly listeners: Set<(update: ListUpdate) => void>
	waiters: number
}

interface Signal {
	readonly promise: Promise<void>
	readonly fire: () => void
}

function signal(): Signal {
	let fire = (): void => undefined
	const promise = new Promise<void>(resolve => {
		fire = resolve
	})

	return { promise, fire }
}

interface ReaderRecord {
	readonly id: string
	readonly archive: AnyFile
	readonly anon: boolean
	readonly password: string | undefined
	// A nested archive's: the reader it is read through, and the entry holding it there.
	readonly parent: { readonly id: string; readonly entry: ArchiveEntryId } | null
	// Aborted by close: every call's work stops.
	readonly lifetime: AbortController
	opened: OpenedReader | null
	opening: Opening | null
	closed: boolean
	released: boolean
	// Calls borrowing the reader.
	pending: number
	readonly access: Map<number, EntryByteAccess["type"]>
	readonly ahead: Map<number, Ahead>
	// Entries a running read will bring along (its window), by index: a read of one waits for it instead of decoding it
	// again.
	readonly passes: Map<number, Promise<unknown>>
	// The entries being read, by index: a second read of one shares the first.
	readonly reads: Map<number, Promise<Ahead>>
	// Solid reads running (a pass from a block's start): another waits for them rather than decode the block beside them.
	readonly solidReads: Set<Promise<unknown>>
	// Solid reads waiting, by entry index (how many): after a failed pass the earliest leads, so the others join its pass.
	readonly waiting: Map<number, number>
	// Settles when a solid read starts or a waiter leaves: a waiter deferring to an earlier one looks again.
	changed: Signal
	leases: number
	cancelIdle: (() => void) | null
}

export interface ArchiveReaders {
	register: (id: string, archive: AnyFile, anon: boolean, password: string | undefined) => void
	// The archive in `entry` of the reader `parentId`, opened through it on first use with its own `password`; closed
	// with its parent. False when the parent is closed.
	registerNested: (id: string, parentId: string, entry: ArchiveEntryId, password: string | undefined) => boolean
	has: (id: string) => boolean
	anon: (id: string) => boolean | undefined
	// What the reader's archive is, once it opened.
	format: (id: string) => ArchiveFormat | undefined
	// Never throws: a reader that a call still borrows is freed once the call settles.
	close: (id: string) => void
	// Sign-out and an account switch: every reader goes.
	clear: () => void
	// A lease of an entry starts or ends: read-ahead is kept while one is held, and a while after.
	lease: (id: string) => void
	unlease: (id: string) => void
	// What it holds decoded ahead, in bytes; 0 for none or a closed one.
	heldBytes: (id: string) => number
	list: (
		id: string,
		onBatch: ((entries: ArchiveEntry[]) => void) | null,
		onUpdate: (update: ListUpdate) => void,
		managedFuture: ManagedFuture
	) => Promise<ListReport>
	download: (
		id: string,
		entry: ArchiveEntryId,
		writer: WritableStream<Uint8Array>,
		maxSolidSkip: number,
		onProgress: (progress: { phase: EntryDownloadPhase; bytesWritten: number }) => void,
		managedFuture: ManagedFuture
	) => Promise<EntryDownloadReport>
	// Bytes `start..end` of a `mapped` or `seekable` entry, unchecked, through the reader's range read.
	readRange: (id: string, entry: ArchiveEntryId, start: number, end: number, signal: AbortSignal) => Promise<Uint8Array>
	// A `mapped` or `seekable` RAW entry's embedded preview, walked by range, written to `writer`.
	embeddedPreview: (
		id: string,
		entry: ArchiveEntryId,
		writer: WritableStream<Uint8Array>,
		signal: AbortSignal
	) => Promise<EmbeddedPreviewResult>
	// How the entry's bytes can be read, resolved once and kept with the reader.
	byteAccess: (id: string, entry: ArchiveEntryId, signal: AbortSignal) => Promise<EntryByteAccess["type"]>
	readWhole: (
		id: string,
		entry: ArchiveEntryId,
		size: number,
		plan: EntryReadPlan,
		events: EntryReadEvents,
		signal: AbortSignal
	) => Promise<Uint8Array>
}

// A writer filling one buffer of the entry's listed size, made by the first byte (a read waiting for the archive slot
// holds none); a larger entry fails rather than grow it. `closed`: the stream was closed whole.
export function entryBuffer(size: number): { writer: WritableStream<Uint8Array>; take: () => Uint8Array; closed: () => boolean } {
	let out: Uint8Array | null = null
	let offset = 0
	let done = false

	return {
		writer: new WritableStream<Uint8Array>({
			write(chunk) {
				out ??= new Uint8Array(size)

				if (offset + chunk.length > out.length) {
					throw new Error("archive entry overran its listed size")
				}

				out.set(chunk, offset)
				offset += chunk.length
			},
			close() {
				done = true
			}
		}),
		take: () => (out === null ? new Uint8Array(0) : offset === out.length ? out : out.subarray(0, offset)),
		closed: () => done
	}
}

// A read of a closed reader (sign-out, the archive left): the page shows it as a cancel, not a failure.
export function readerClosed(): Error {
	const error = new Error("archive reader is closed")

	error.name = "Cancelled"

	return error
}

function settle(report: EntryDownloadReport): boolean {
	if (report.error !== undefined) {
		throw new ErrorWithDTO(liftError(report.error))
	}

	return report.checked
}

function defaultTimer(run: () => void, ms: number): () => void {
	const timer = setTimeout(run, ms)

	return () => {
		clearTimeout(timer)
	}
}

function newRecord(
	id: string,
	archive: AnyFile,
	anon: boolean,
	password: string | undefined,
	parent: ReaderRecord["parent"]
): ReaderRecord {
	return {
		id,
		archive,
		anon,
		password,
		parent,
		lifetime: new AbortController(),
		opened: null,
		opening: null,
		closed: false,
		released: false,
		pending: 0,
		access: new Map(),
		ahead: new Map(),
		passes: new Map(),
		reads: new Map(),
		solidReads: new Set(),
		waiting: new Map(),
		changed: signal(),
		leases: 0,
		cancelIdle: null
	}
}

export function createArchiveReaders(deps: ArchiveReaderDeps): ArchiveReaders {
	const records = new Map<string, ReaderRecord>()
	const setTimer = deps.setTimer ?? defaultTimer
	// Every reader's read-ahead, oldest first, charged to one budget.
	const aheadOrder = new Map<string, { record: ReaderRecord; index: number; bytes: number }>()
	let aheadTotal = 0

	// The SDK names a nested archive's entries by an id of its own, derived from its parent's: the page names them by
	// the archive's (outermost) uuid, mapped here.
	const ownId = (record: ReaderRecord, reader: ReaderLike, entry: ArchiveEntryId): ArchiveEntryId =>
		record.parent === null ? entry : { archive: reader.archiveId as ArchiveEntryId["archive"], index: entry.index }

	const require = (id: string): ReaderRecord => {
		const record = records.get(id)

		if (record === undefined || record.closed) {
			throw readerClosed()
		}

		return record
	}

	const dropAhead = (record: ReaderRecord, index: number): Ahead | undefined => {
		const held = record.ahead.get(index)

		if (held !== undefined) {
			record.ahead.delete(index)
			aheadOrder.delete(`${record.id}#${String(index)}`)
			aheadTotal -= held.bytes.length
		}

		return held
	}

	const clearAhead = (record: ReaderRecord): void => {
		for (const index of [...record.ahead.keys()]) {
			dropAhead(record, index)
		}
	}

	const keepAhead = (record: ReaderRecord, index: number, held: Ahead): void => {
		const budget = deps.aheadBudget()

		if (record.closed || held.bytes.length > budget) {
			return
		}

		dropAhead(record, index)

		for (const { record: owner, index: kept } of aheadOrder.values()) {
			if (aheadTotal + held.bytes.length <= budget) {
				break
			}

			dropAhead(owner, kept)
		}

		record.ahead.set(index, held)
		aheadOrder.set(`${record.id}#${String(index)}`, { record, index, bytes: held.bytes.length })
		aheadTotal += held.bytes.length
	}

	// Frees the reader once: never while a call borrows it, never throwing.
	const releaseIfIdle = (record: ReaderRecord): void => {
		if (!record.closed || record.released || record.pending > 0 || record.opened === null) {
			return
		}

		record.released = true

		const opened = record.opened

		record.opened = null

		try {
			opened.release()
		} catch (e) {
			log.warn("archiveReaders", "freeing a reader failed", e)
		}
	}

	const dispose = (record: ReaderRecord): void => {
		// The archives nested in it go with it (the SDK closes their readers too).
		for (const child of [...records.values()]) {
			if (child.parent?.id === record.id) {
				records.delete(child.id)
				dispose(child)
			}
		}

		record.closed = true
		record.cancelIdle?.()
		record.cancelIdle = null
		clearAhead(record)
		record.access.clear()
		record.lifetime.abort(readerClosed())
		record.opening?.controller.abort(readerClosed())

		try {
			record.opened?.reader.close()
		} catch (e) {
			log.warn("archiveReaders", "closing a reader failed", e)
		}

		releaseIfIdle(record)
	}

	// Closes and frees a reader no call ever borrowed.
	const shut = (opened: OpenedReader): void => {
		try {
			opened.reader.close()
			opened.release()
		} catch (e) {
			log.warn("archiveReaders", "freeing a reader failed", e)
		}
	}

	// A nested archive opens through its parent's reader, borrowed for the opening.
	const openNested = (record: ReaderRecord, parent: NonNullable<ReaderRecord["parent"]>, abort: AbortSignal): Promise<OpenedReader> => {
		const parentRecord = records.get(parent.id)
		const opener = deps.openNested

		if (parentRecord === undefined || parentRecord.closed || opener === undefined) {
			return Promise.reject(readerClosed())
		}

		return borrow(
			parentRecord,
			abort,
			() => undefined,
			(reader, signal) =>
				opener({
					parent: reader,
					entry: ownId(parentRecord, reader, parent.entry),
					password: record.password,
					managedFuture: { abortSignal: signal }
				})
		)
	}

	const startOpening = (record: ReaderRecord): Opening => {
		const controller = new AbortController()
		const listeners = new Set<(update: ListUpdate) => void>()
		const managedFuture = { abortSignal: AbortSignal.any([controller.signal, record.lifetime.signal]) }
		const promise =
			record.parent === null
				? deps.open({
						archive: record.archive,
						anon: record.anon,
						password: record.password,
						onUpdate: update => {
							for (const listener of listeners) {
								listener(update)
							}
						},
						managedFuture
					})
				: openNested(record, record.parent, managedFuture.abortSignal)
		const opening: Opening = { promise, controller, listeners, waiters: 0 }

		promise.then(
			opened => {
				if (record.opening === opening) {
					record.opening = null
				}

				// An opening given up before the SDK saw it, which another opening beat: nobody holds this one.
				if (record.opened !== null) {
					shut(opened)

					return
				}

				record.opened = opened

				// Closed while it opened: nobody holds it.
				if (record.closed) {
					try {
						opened.reader.close()
					} catch (e) {
						log.warn("archiveReaders", "closing a reader failed", e)
					}

					releaseIfIdle(record)
				}
			},
			() => {
				if (record.opening === opening) {
					record.opening = null
				}
			}
		)

		return opening
	}

	// Opens the reader on first use; every caller waits on the one opening with its own cancel and hears its progress.
	// An opening every waiter left is cancelled; a caller arriving after that opens again.
	const ensureOpen = async (record: ReaderRecord, onUpdate: (update: ListUpdate) => void, signal: AbortSignal): Promise<ReaderLike> => {
		for (;;) {
			if (record.closed) {
				throw readerClosed()
			}

			if (record.opened !== null) {
				return record.opened.reader
			}

			record.opening ??= startOpening(record)

			const opening = record.opening

			opening.waiters += 1
			opening.listeners.add(onUpdate)

			try {
				// The reader kept is the one the record holds: an opening another beat is shut, not handed out.
				await raceAbort(opening.promise, signal)

				continue
			} catch (e) {
				// The opening was given up by the others, not by this caller: open again.
				if (!signal.aborted && opening.controller.signal.aborted && records.get(record.id) === record) {
					continue
				}

				throw e
			} finally {
				opening.listeners.delete(onUpdate)
				opening.waiters -= 1

				if (opening.waiters === 0 && record.opening === opening) {
					opening.controller.abort(readerClosed())
					record.opening = null
				}
			}
		}
	}

	// A call on the reader, under the caller's signal and the reader's own, counted so a close frees it only after.
	const borrow = async <T>(
		record: ReaderRecord,
		signal: AbortSignal,
		onUpdate: (update: ListUpdate) => void,
		run: (reader: ReaderLike, signal: AbortSignal) => Promise<T>
	): Promise<T> => {
		const reader = await ensureOpen(record, onUpdate, signal)

		if (record.closed) {
			throw readerClosed()
		}

		record.pending += 1

		try {
			return await run(reader, AbortSignal.any([signal, record.lifetime.signal]))
		} finally {
			record.pending -= 1
			releaseIfIdle(record)
		}
	}

	const accessOf = async (
		record: ReaderRecord,
		reader: ReaderLike,
		entry: ArchiveEntryId,
		signal: AbortSignal
	): Promise<EntryByteAccess["type"]> => {
		const known = record.access.get(entry.index)

		if (known !== undefined) {
			return known
		}

		const access = (await reader.entryByteAccess(ownId(record, reader, entry), { abortSignal: signal })).type

		if (!record.closed) {
			record.access.set(entry.index, access)
		}

		return access
	}

	const notify = (record: ReaderRecord): void => {
		const fired = record.changed

		record.changed = signal()
		fired.fire()
	}

	// Counts a solid read among the reader's waiters until the returned function is called, which tells the others.
	const enlist = (record: ReaderRecord, index: number): (() => void) => {
		record.waiting.set(index, (record.waiting.get(index) ?? 0) + 1)

		return () => {
			const left = (record.waiting.get(index) ?? 1) - 1

			if (left === 0) {
				record.waiting.delete(index)
			} else {
				record.waiting.set(index, left)
			}

			notify(record)
		}
	}

	const earlierWaiter = (record: ReaderRecord, index: number): boolean => {
		for (const waiting of record.waiting.keys()) {
			if (waiting < index) {
				return true
			}
		}

		return false
	}

	// Room for a pass's window before it starts, so what is held ahead and what the pass brings stay within the budget
	// together: this reader's files outside the window go first (the reader moved on), then those the window brings
	// again, then the oldest of any reader.
	const makeRoom = (record: ReaderRecord, plan: EntryReadPlan, asked: number): void => {
		const budget = deps.aheadBudget()
		const inWindow = new Set(plan.window.map(item => item.index))
		let coming = 0

		for (const item of plan.window) {
			if (item.index !== asked) {
				coming += item.size
			}
		}

		for (const index of [...record.ahead.keys()]) {
			if (!inWindow.has(index)) {
				dropAhead(record, index)
			}
		}

		for (const index of inWindow) {
			dropAhead(record, index)
		}

		for (const { record: owner, index } of aheadOrder.values()) {
			if (aheadTotal + coming <= budget) {
				break
			}

			dropAhead(owner, index)
		}
	}

	// The window in one ordered pass: the asked entry returned, the others it wrote kept for their own read.
	const readWindow = async (
		record: ReaderRecord,
		reader: ReaderLike,
		entry: ArchiveEntryId,
		plan: EntryReadPlan,
		events: EntryReadEvents,
		signal: AbortSignal
	): Promise<Ahead> => {
		const buffers = new Map<number, ReturnType<typeof entryBuffer>>()
		const sizes = new Map(plan.window.map(item => [item.index, item.size]))
		let phase: EntryDownloadPhase | null = null

		makeRoom(record, plan, entry.index)

		const report = await reader.readEntries({
			entries: plan.window.map(item => ownId(record, reader, { archive: entry.archive, index: item.index })),
			writerFor: (id, stated) => {
				const buffer = entryBuffer(stated === undefined ? (sizes.get(id.index) ?? 0) : Number(stated))

				buffers.set(id.index, buffer)

				return buffer.writer
			},
			maxSolidSkip: plan.windowSkip,
			onUpdate: update => {
				if (update.phase !== phase) {
					phase = update.phase
					events.phase(update.phase)
				}
			},
			managedFuture: { abortSignal: signal }
		})
		const checked = report.error === undefined && report.checked

		for (const [index, buffer] of buffers) {
			if (index !== entry.index && buffer.closed()) {
				keepAhead(record, index, { bytes: buffer.take(), checked })
			}
		}

		const own = buffers.get(entry.index)

		if (own?.closed() === true) {
			// The asked entry came whole: a failure after it costs only the rest, but may be damage worth knowing of.
			if (report.error !== undefined) {
				log.warn("archiveReaders", "a read-ahead pass ended early after its entry", liftError(report.error))
			}

			return { bytes: own.take(), checked }
		}

		if (report.error !== undefined) {
			throw new ErrorWithDTO(liftError(report.error))
		}

		throw new Error("an archive pass ended before its entry")
	}

	const readEntry = (
		record: ReaderRecord,
		entry: ArchiveEntryId,
		size: number,
		plan: EntryReadPlan,
		events: EntryReadEvents,
		signal: AbortSignal,
		// The read turned out to bring only its own entry: the files it marked are no one's to wait for.
		unmark: () => void
	): Promise<Ahead> =>
		borrow(
			record,
			signal,
			update => {
				events.phase(update.phase)
			},
			async (reader, combined) => {
				const access = await accessOf(record, reader, entry, combined)

				// A gzip tar's member decodes on from where the read before it stopped. A tar has no checksum of its members.
				if (access === "seekable" && reader.format?.type === "tar") {
					unmark()

					const buffer = entryBuffer(size)

					events.phase("reading")
					await reader.readEntryRange({
						entry: ownId(record, reader, entry),
						start: 0,
						end: size,
						writer: buffer.writer,
						managedFuture: { abortSignal: combined }
					})

					return { bytes: buffer.take(), checked: false }
				}

				if (access === "sequential" || (access === "whole" && plan.window.length > 1)) {
					return readWindow(record, reader, entry, plan, events, combined)
				}

				unmark()

				const buffer = entryBuffer(size)
				let phase: EntryDownloadPhase | null = null
				const checked = settle(
					await reader.downloadEntry({
						entry: ownId(record, reader, entry),
						writer: buffer.writer,
						maxSolidSkip: plan.maxSolidSkip,
						onUpdate: update => {
							if (update.phase !== phase) {
								phase = update.phase
								events.phase(update.phase)
							}
						},
						managedFuture: { abortSignal: combined }
					})
				)

				return { bytes: buffer.take(), checked }
			}
		)

	return {
		register: (id, archive, anon, password) => {
			if (records.has(id)) {
				return
			}

			records.set(id, newRecord(id, archive, anon, password, null))
		},
		registerNested: (id, parentId, entry, password) => {
			const parent = records.get(parentId)

			if (parent === undefined || parent.closed) {
				return false
			}

			if (!records.has(id)) {
				records.set(id, newRecord(id, parent.archive, parent.anon, password, { id: parentId, entry }))
			}

			return true
		},
		has: id => records.get(id)?.closed === false,
		anon: id => records.get(id)?.anon,
		format: id => records.get(id)?.opened?.reader.format,
		close: id => {
			const record = records.get(id)

			if (record !== undefined) {
				records.delete(id)
				dispose(record)
			}
		},
		clear: () => {
			const all = [...records.values()]

			records.clear()

			for (const record of all) {
				dispose(record)
			}
		},
		lease: id => {
			const record = records.get(id)

			if (record !== undefined) {
				record.leases += 1
				record.cancelIdle?.()
				record.cancelIdle = null
			}
		},
		unlease: id => {
			const record = records.get(id)

			if (record === undefined) {
				return
			}

			record.leases = Math.max(0, record.leases - 1)

			if (record.leases === 0 && record.cancelIdle === null) {
				record.cancelIdle = setTimer(() => {
					record.cancelIdle = null

					if (record.leases === 0) {
						clearAhead(record)
					}
				}, READ_AHEAD_IDLE_MS)
			}
		},
		heldBytes: id => {
			const record = records.get(id)
			let total = 0

			for (const held of record?.ahead.values() ?? []) {
				total += held.bytes.length
			}

			return total
		},
		list: (id, onBatch, onUpdate, managedFuture) => {
			const record = require(id)

			return borrow(record, managedFuture.abortSignal ?? new AbortController().signal, onUpdate, (reader, signal) =>
				reader.list({
					...(onBatch !== null ? { onEntriesBatch: onBatch } : {}),
					onUpdate,
					managedFuture: { ...managedFuture, abortSignal: signal }
				})
			)
		},
		download: async (id, entry, writer, maxSolidSkip, onProgress, managedFuture) => {
			const record = require(id)
			// Read ahead already (a solid block's file a pass brought): saved from what is held.
			const held = dropAhead(record, entry.index)

			if (held !== undefined) {
				const w = writer.getWriter()

				onProgress({ phase: "reading", bytesWritten: 0 })
				await w.write(held.bytes)
				await w.close()
				onProgress({ phase: "done", bytesWritten: held.bytes.length })

				return { bytesWritten: BigInt(held.bytes.length), bytesRead: 0n, checked: held.checked, error: undefined }
			}

			return borrow(
				record,
				managedFuture.abortSignal ?? new AbortController().signal,
				update => {
					onProgress({ phase: update.phase, bytesWritten: 0 })
				},
				(reader, signal) =>
					reader.downloadEntry({
						entry: ownId(record, reader, entry),
						writer,
						maxSolidSkip,
						onUpdate: (update: EntryDownloadUpdate) => {
							onProgress({ phase: update.phase, bytesWritten: Number(update.bytesWritten) })
						},
						managedFuture: { ...managedFuture, abortSignal: signal }
					})
			)
		},
		readRange: (id, entry, start, end, signal) => {
			const record = require(id)

			return borrow(
				record,
				signal,
				() => undefined,
				async (reader, combined) => {
					const buffer = entryBuffer(end - start)

					await reader.readEntryRange({
						entry: ownId(record, reader, entry),
						start,
						end,
						writer: buffer.writer,
						managedFuture: { abortSignal: combined }
					})

					return buffer.take()
				}
			)
		},
		embeddedPreview: (id, entry, writer, signal) => {
			const record = require(id)

			return borrow(
				record,
				signal,
				() => undefined,
				(reader, combined) =>
					reader.writeEntryEmbeddedPreview({
						entry: ownId(record, reader, entry),
						writer,
						managedFuture: { abortSignal: combined }
					})
			)
		},
		byteAccess: (id, entry, signal) => {
			const record = require(id)

			return borrow(
				record,
				signal,
				() => undefined,
				(reader, combined) => accessOf(record, reader, entry, combined)
			)
		},
		readWhole: async (id, entry, size, plan, events, signal) => {
			const record = require(id)
			// Decodes a solid block from its start: one such read at a time per reader, the archive slot being one anyway.
			const solid = plan.window.length > 1 || plan.maxSolidSkip > 0

			// Read ahead already, being read by another caller, or on its way in a running read: from there. A read that
			// failed or was cancelled leaves it to the first waiter to read again, which marks it for the rest; a solid read
			// waits for any other one running, then looks again, so the waiters of a failed pass never decode beside each
			// other.
			let leave: (() => void) | null = null

			try {
				for (;;) {
					const held = dropAhead(record, entry.index)

					if (held !== undefined) {
						if (held.checked) {
							events.verified()
						}

						return held.bytes
					}

					const same = record.reads.get(entry.index)

					if (same !== undefined) {
						// Its first caller takes the bytes it read (transferred to the page): this one a copy, made at once.
						const shared = await raceAbort(
							same.then(
								read => ({ bytes: read.bytes.slice(), checked: read.checked }),
								() => null
							),
							signal
						)

						if (shared !== null) {
							if (shared.checked) {
								events.verified()
							}

							return shared.bytes
						}
					} else {
						const running = record.passes.get(entry.index) ?? (solid ? record.solidReads.values().next().value : undefined)

						// An earlier entry's waiter reads first after a failed pass: its window may bring this one.
						const on = running ?? (solid && earlierWaiter(record, entry.index) ? record.changed.promise : undefined)

						if (on === undefined) {
							break
						}

						if (solid) {
							leave ??= enlist(record, entry.index)
						}

						await raceAbort(
							on.catch(() => undefined),
							signal
						)
					}

					if (record.closed) {
						throw readerClosed()
					}
				}
			} finally {
				leave?.()
			}

			let marked: number[] = plan.window.length > 1 ? plan.window.map(item => item.index).filter(index => index !== entry.index) : []
			let reading: Promise<Ahead> | null = null
			const unmark = (): void => {
				for (const index of marked) {
					if (record.passes.get(index) === reading) {
						record.passes.delete(index)
					}
				}

				marked = []
			}

			reading = readEntry(record, entry, size, plan, events, signal, unmark)
			// Marked before the read's first await: a read of a file after it, asked meanwhile, waits for what it brings.
			marked = marked.filter(index => !record.passes.has(index))

			for (const index of marked) {
				record.passes.set(index, reading)
			}

			const own = reading

			record.reads.set(entry.index, own)

			if (solid) {
				record.solidReads.add(own)
				notify(record)
			}

			try {
				const read = await own

				if (read.checked) {
					events.verified()
				}

				return read.bytes
			} catch (e) {
				events.failed(e)

				throw e
			} finally {
				unmark()
				record.solidReads.delete(own)

				if (record.reads.get(entry.index) === own) {
					record.reads.delete(entry.index)
				}
			}
		}
	}
}
