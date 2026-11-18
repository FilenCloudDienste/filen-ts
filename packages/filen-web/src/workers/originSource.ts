import type { AnyFile, ArchiveEntryId, EntryDownloadPhase } from "@filen/sdk-rs"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import type { AbortableReadRange } from "@/lib/media/blockCache"
import { ENTRY_RANGE_BUFFER_CAP as ENTRY_RANGE_BUFFER_BYTES } from "@/features/drive/lib/preview.logic"
import { raceAbort } from "@/lib/abort"

// The SDK worker's side of the byte layer: the only worker code that knows the origin kinds. A `bytes` origin never
// gets here; the page reads its Blob itself.

export interface OriginSource {
	readonly size: number
	read: AbortableReadRange
	// The whole origin; rejects above `cap`.
	readWhole(cap: number, signal: AbortSignal): Promise<Uint8Array>
	// Frees what the source holds (a client handle, an entry's buffer); reads after it reject.
	release(): void
}

// A client's range reads of a file, and the handle's release.
export interface FileReadClient {
	readRange(file: AnyFile, start: number, end: number, signal: AbortSignal): Promise<Uint8Array>
	release(): void
}

// What the page hears of an entry reader's whole reads: the slot wait (a phase change), a read whose checksum matched
// (only that proves the password), and a failure (a password the entry needs or refused).
export interface EntryReaderEvents {
	phase(phase: EntryDownloadPhase): void
	verified(): void
	failed(error: ErrorDTO): void
}

// An entry lease (an origin's `reader`): one entry of an archive reader, read whole through it.
export interface EntryReaderRecord {
	readonly anon: boolean
	// The entry's whole decoded bytes, checked against its checksum where the archive has one, under `signal`.
	read(entry: ArchiveEntryId, size: number, signal: AbortSignal): Promise<Uint8Array>
}

export interface OriginSourceDeps {
	// The session client; throws when signed out.
	session(): FileReadClient
	// A public link's client, freed by its release.
	linked(): FileReadClient
	entryReader(id: string): EntryReaderRecord | undefined
}

// The most an entry is buffered to serve its ranges from (preview.logic's, which the entry gates read too).
export const ENTRY_RANGE_BUFFER_CAP = Number(ENTRY_RANGE_BUFFER_BYTES)

function tooLarge(size: number, cap: number): Error {
	return new Error(`preview read of ${String(size)} bytes is above its cap of ${String(cap)}`)
}

function released(): Error {
	const error = new Error("Cancelled")

	error.name = "Cancelled"

	return error
}

function fileSource(client: FileReadClient, file: AnyFile): OriginSource {
	const size = Number(file.size)

	return {
		size,
		read: (start, end, signal) => client.readRange(file, start, end, signal),
		readWhole: (cap, signal) => (size > cap ? Promise.reject(tooLarge(size, cap)) : client.readRange(file, 0, size, signal)),
		release: () => {
			client.release()
		}
	}
}

// An entry's ranges come from one checked whole read, made on the first range read and held for the source's life. Each range is a copy: the reader receives it transferred.
function entrySource(record: EntryReaderRecord, entry: ArchiveEntryId, size: number): OriginSource {
	const lifetime = new AbortController()
	let held: Promise<Uint8Array> | null = null
	const whole = (): Promise<Uint8Array> => {
		if (held === null) {
			const load =
				size > ENTRY_RANGE_BUFFER_CAP
					? Promise.reject(tooLarge(size, ENTRY_RANGE_BUFFER_CAP))
					: record.read(entry, size, lifetime.signal)

			held = load
			// A failed load is not kept: the next read tries again.
			load.catch(() => {
				if (held === load) {
					held = null
				}
			})
		}

		return held
	}

	return {
		size,
		read: async (start, end, signal) => {
			lifetime.signal.throwIfAborted()

			const bytes = await raceAbort(whole(), signal)

			return bytes.slice(start, Math.min(end, bytes.length))
		},
		readWhole: (cap, signal) => {
			if (size > cap) {
				return Promise.reject(tooLarge(size, cap))
			}

			if (held !== null) {
				return raceAbort(held, signal).then(bytes => bytes.slice())
			}

			return record.read(entry, size, AbortSignal.any([signal, lifetime.signal]))
		},
		release: () => {
			lifetime.abort(released())
			held = null
		}
	}
}

export function originSource(o: ByteOrigin, deps: OriginSourceDeps): OriginSource {
	switch (o.kind) {
		case "file":
			return fileSource(deps.session(), o.file)
		case "linkedFile":
			return fileSource(deps.linked(), o.file)
		case "entry": {
			const record = deps.entryReader(o.reader)

			if (record === undefined) {
				throw new Error("archive reader is closed")
			}

			// A reader opened on one client is never read through the other.
			if (record.anon !== o.anon) {
				throw new Error("archive reader belongs to the other client")
			}

			return entrySource(record, o.entry, o.size)
		}
		case "bytes":
			throw new Error("a bytes origin is read on the page, never in the SDK worker")
	}
}

// The drive file behind an origin, for SDK calls that take a file (a RAW's embedded preview); null for the kinds
// that have none.
export function originFile(o: ByteOrigin): { readonly anon: boolean; readonly file: AnyFile } | null {
	switch (o.kind) {
		case "file":
			return { anon: false, file: o.file }
		case "linkedFile":
			return { anon: true, file: o.file }
		case "entry":
		case "bytes":
			return null
	}
}

// Entry leases, by the id an origin names them by.
const entryReaders = new Map<string, EntryReaderRecord>()

// `id` is the caller's own, so an origin naming it can be built before this registration lands.
export function registerEntryReader(id: string, record: EntryReaderRecord): void {
	entryReaders.set(id, record)
}

export function releaseEntryReader(id: string): void {
	entryReaders.delete(id)
}

export function entryReader(id: string): EntryReaderRecord | undefined {
	return entryReaders.get(id)
}

// Sign-out: no reader outlives the session.
export function clearEntryReaders(): void {
	entryReaders.clear()
}
