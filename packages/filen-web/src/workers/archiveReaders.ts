import type {
	AnyFile,
	ArchiveEntry,
	ArchiveEntryId,
	ArchiveReader,
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
import { READ_AHEAD_MAX_BYTES, READ_AHEAD_MAX_ENTRIES, type EntryReadPlan } from "@/lib/sdk/archiveListing"

// The SDK's archive readers this worker holds, one per archive and password the page opened. A reader reads its
// archive's index once and serves every listing, download and entry read after it from what it holds (the index, a
// tar's member table, the chunks and decoder states read last, within the client's retained budget).
//
// An entry read whole goes the cheapest way the entry allows:
// - a member of a gzip tar through range reads, which decode on from where the read before stopped (a page after a
//   page costs about the page);
// - a solid block's entry (a solid 7z's, a solid RAR's, another compressed tar's member) through an ordered pass over
//   it and the files stored after it, the window the page planned: those it decoded anyway are kept for their own
//   read, so a run of entries read one after another decodes the block about once per window instead of once per
//   entry;
// - anything else through a checked download of the entry alone.

export type ReaderLike = Pick<
	ArchiveReader,
	"format" | "list" | "entryByteAccess" | "downloadEntry" | "readEntryRange" | "readEntries" | "close" | "free"
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

export interface ArchiveReaderDeps {
	open: (request: ReaderOpenRequest) => Promise<OpenedReader>
}

export interface EntryReadEvents {
	phase: (phase: EntryDownloadPhase) => void
	verified: () => void
	failed: (error: unknown) => void
}

interface ReaderRecord {
	readonly archive: AnyFile
	readonly anon: boolean
	readonly password: string | undefined
	opened: OpenedReader | null
	opening: Promise<OpenedReader> | null
	closed: boolean
	readonly access: Map<number, EntryByteAccess["type"]>
	readonly ahead: Map<number, Uint8Array>
	aheadBytes: number
	// Entries a running read may bring along (its window), by index: a read of one waits for it instead of decoding it
	// again.
	readonly passes: Map<number, Promise<unknown>>
}

export interface ArchiveReaders {
	register: (id: string, archive: AnyFile, anon: boolean, password: string | undefined) => void
	has: (id: string) => boolean
	anon: (id: string) => boolean | undefined
	close: (id: string) => void
	// Sign-out: every reader goes.
	clear: () => void
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

function closedError(): Error {
	return new Error("archive reader is closed")
}

function settle(report: EntryDownloadReport): boolean {
	if (report.error !== undefined) {
		throw new ErrorWithDTO(liftError(report.error))
	}

	return report.checked
}

export function createArchiveReaders(deps: ArchiveReaderDeps): ArchiveReaders {
	const records = new Map<string, ReaderRecord>()

	const require = (id: string): ReaderRecord => {
		const record = records.get(id)

		if (record === undefined || record.closed) {
			throw closedError()
		}

		return record
	}

	const dispose = (record: ReaderRecord): void => {
		record.closed = true
		record.ahead.clear()
		record.aheadBytes = 0
		record.access.clear()

		const opened = record.opened

		record.opened = null

		if (opened !== null) {
			opened.reader.close()
			opened.release()
		}
	}

	// Opens the reader on first use; later callers share the opening. One that fails (a password the index needs, a
	// cancel) is dropped, so the next call opens again.
	const ensureOpen = async (
		record: ReaderRecord,
		onUpdate: (update: ListUpdate) => void,
		managedFuture: ManagedFuture
	): Promise<ReaderLike> => {
		if (record.opened !== null) {
			return record.opened.reader
		}

		if (record.opening === null) {
			const opening = deps.open({ archive: record.archive, anon: record.anon, password: record.password, onUpdate, managedFuture })

			record.opening = opening
			opening.then(
				opened => {
					record.opening = null

					// Closed while it opened: nobody holds it.
					if (record.closed) {
						opened.reader.close()
						opened.release()
					} else {
						record.opened = opened
					}
				},
				() => {
					if (record.opening === opening) {
						record.opening = null
					}
				}
			)
		}

		const opened = await record.opening

		if (record.closed) {
			throw closedError()
		}

		return opened.reader
	}

	const keepAhead = (record: ReaderRecord, index: number, bytes: Uint8Array): void => {
		if (record.closed || bytes.length > READ_AHEAD_MAX_BYTES) {
			return
		}

		const previous = record.ahead.get(index)

		if (previous !== undefined) {
			record.aheadBytes -= previous.length
			record.ahead.delete(index)
		}

		// Oldest first: a Map iterates in insertion order.
		for (const [held, kept] of record.ahead) {
			if (record.aheadBytes + bytes.length <= READ_AHEAD_MAX_BYTES && record.ahead.size < READ_AHEAD_MAX_ENTRIES) {
				break
			}

			record.ahead.delete(held)
			record.aheadBytes -= kept.length
		}

		record.ahead.set(index, bytes)
		record.aheadBytes += bytes.length
	}

	const takeAhead = (record: ReaderRecord, index: number): Uint8Array | undefined => {
		const held = record.ahead.get(index)

		if (held !== undefined) {
			record.ahead.delete(index)
			record.aheadBytes -= held.length
		}

		return held
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

		const access = (await reader.entryByteAccess(entry, { abortSignal: signal })).type

		if (!record.closed) {
			record.access.set(entry.index, access)
		}

		return access
	}

	// The window in one ordered pass: the asked entry returned, the others it wrote kept for their own read.
	const readWindow = async (
		record: ReaderRecord,
		reader: ReaderLike,
		entry: ArchiveEntryId,
		plan: EntryReadPlan,
		events: EntryReadEvents,
		signal: AbortSignal
	): Promise<{ bytes: Uint8Array; checked: boolean }> => {
		const buffers = new Map<number, ReturnType<typeof entryBuffer>>()
		const sizes = new Map(plan.window.map(item => [item.index, item.size]))
		let phase: EntryDownloadPhase | null = null

		const pass = reader.readEntries({
			entries: plan.window.map(item => ({ archive: entry.archive, index: item.index })),
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

		const report = await pass

		for (const [index, buffer] of buffers) {
			if (index !== entry.index && buffer.closed()) {
				keepAhead(record, index, buffer.take())
			}
		}

		const own = buffers.get(entry.index)

		// The asked entry came whole: a failure after it (past the window's first entry) costs only the rest.
		if (own?.closed() === true) {
			if (report.error !== undefined) {
				liftError(report.error)
			}

			return { bytes: own.take(), checked: report.error === undefined && report.checked }
		}

		if (report.error !== undefined) {
			throw new ErrorWithDTO(liftError(report.error))
		}

		throw new Error("an archive pass ended before its entry")
	}

	const readEntry = async (
		record: ReaderRecord,
		entry: ArchiveEntryId,
		size: number,
		plan: EntryReadPlan,
		events: EntryReadEvents,
		signal: AbortSignal
	): Promise<{ bytes: Uint8Array; checked: boolean }> => {
		const reader = await ensureOpen(
			record,
			update => {
				events.phase(update.phase)
			},
			{ abortSignal: signal }
		)
		const access = await accessOf(record, reader, entry, signal)

		// A gzip tar's member decodes on from where the read before it stopped. A tar has no checksum of its members.
		if (access === "seekable" && reader.format?.type === "tar") {
			const buffer = entryBuffer(size)

			events.phase("reading")
			await reader.readEntryRange({ entry, start: 0, end: size, writer: buffer.writer, managedFuture: { abortSignal: signal } })

			return { bytes: buffer.take(), checked: false }
		}

		if (access === "sequential" || (access === "whole" && plan.window.length > 1)) {
			return readWindow(record, reader, entry, plan, events, signal)
		}

		const buffer = entryBuffer(size)
		let phase: EntryDownloadPhase | null = null
		const checked = settle(
			await reader.downloadEntry({
				entry,
				writer: buffer.writer,
				maxSolidSkip: plan.maxSolidSkip,
				onUpdate: update => {
					if (update.phase !== phase) {
						phase = update.phase
						events.phase(update.phase)
					}
				},
				managedFuture: { abortSignal: signal }
			})
		)

		return { bytes: buffer.take(), checked }
	}

	return {
		register: (id, archive, anon, password) => {
			if (records.has(id)) {
				return
			}

			records.set(id, {
				archive,
				anon,
				password,
				opened: null,
				opening: null,
				closed: false,
				access: new Map(),
				ahead: new Map(),
				aheadBytes: 0,
				passes: new Map()
			})
		},
		has: id => records.get(id)?.closed === false,
		anon: id => records.get(id)?.anon,
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
		list: async (id, onBatch, onUpdate, managedFuture) => {
			const record = require(id)
			const reader = await ensureOpen(record, onUpdate, managedFuture)

			return reader.list({ ...(onBatch !== null ? { onEntriesBatch: onBatch } : {}), onUpdate, managedFuture })
		},
		download: async (id, entry, writer, maxSolidSkip, onProgress, managedFuture) => {
			const record = require(id)
			const reader = await ensureOpen(
				record,
				update => {
					onProgress({ phase: update.phase, bytesWritten: 0 })
				},
				managedFuture
			)

			return reader.downloadEntry({
				entry,
				writer,
				maxSolidSkip,
				onUpdate: (update: EntryDownloadUpdate) => {
					onProgress({ phase: update.phase, bytesWritten: Number(update.bytesWritten) })
				},
				managedFuture
			})
		},
		readWhole: async (id, entry, size, plan, events, signal) => {
			const record = require(id)
			let held = takeAhead(record, entry.index)

			// A pass already on its way to it: its bytes come with that pass.
			const running = held === undefined ? record.passes.get(entry.index) : undefined

			if (running !== undefined) {
				await running.catch(() => undefined)
				held = takeAhead(record, entry.index)
			}

			if (held !== undefined) {
				return held
			}

			const reading = readEntry(record, entry, size, plan, events, signal)
			// Marked before the read's first await: a read of a file after it, asked meanwhile, waits for what it brings.
			const marked = plan.window.filter(item => item.index !== entry.index && !record.passes.has(item.index))

			for (const item of marked) {
				record.passes.set(item.index, reading)
			}

			try {
				const read = await reading

				if (read.checked) {
					events.verified()
				}

				return read.bytes
			} catch (e) {
				events.failed(e)

				throw e
			} finally {
				for (const item of marked) {
					if (record.passes.get(item.index) === reading) {
						record.passes.delete(item.index)
					}
				}
			}
		}
	}
}
