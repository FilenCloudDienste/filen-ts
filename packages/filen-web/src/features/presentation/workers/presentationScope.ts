import { crc32 } from "@filen/office/core/opc"
import {
	servePresentationWorker,
	type CopyPass,
	type PresentationWorkerOptions,
	type PresentationWorkerScope,
	type RemoteByteSource,
	type SourceSpec,
	type ToPresentationWorker
} from "@filen/office/dom/presentation"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { BlockCache, MAX_RUN_BLOCKS } from "@/lib/media/blockCache"
import { closeRangePort, rangePortReader, type RangePortReader } from "@/lib/media/rangePort"

// The presentation worker's server (presentation.worker.ts runs it on its scope): the engine's host with the web's
// range source. A drive file is read through a
// range port to the SDK worker, in 1 MiB blocks held in a small LRU, so a deck of any size costs a bounded amount of
// memory; archive entries arrive as bytes.

// Resident blocks per open deck (1 MiB each): the central directory, the parts being parsed and a picture or two.
export const DECK_BLOCK_CAPACITY = 24

// A save's copies are read in blocks of this many bytes: one range request each, whose 1 MiB chunks the SDK downloads
// in parallel (as the block cache's longest run).
export const COPY_BLOCK_BYTES = MAX_RUN_BLOCKS * BLOCK_BYTES

interface RangeDeck {
	readonly cache: BlockCache
	close(): void
}

type ReadChecked = (start: number, end: number, crc: number, signal: AbortSignal) => Promise<{ bytes: Uint8Array; crc: number }>

// A save's copies in file order, each COPY_BLOCK_BYTES block of the file fetched once and held only while the copies
// are in it: about the file's size downloaded, in as few requests as the SDK's chunking allows. The server checksums
// each block where it lives and the block is checked on arrival; the copies' own CRCs are then taken here from the
// checked block. A copy behind the held block (out of file order) fetches its block again.
//
// The writer reads each copied entry's local header (a plain read) just before its bytes: a plain read inside the
// held block, or where the last copy ended, is served here too, so the viewer's block cache does not download the
// same bytes again in 1 MiB blocks. Any other plain read (the viewer's) is not the pass's.
class CopyBlocks implements CopyPass {
	private readonly size: number
	private readonly readChecked: ReadChecked
	private readonly abort = new AbortController()
	private held: { readonly index: number; readonly bytes: Promise<Uint8Array> } | undefined
	// Where the last read of the pass ended; the file's start before the first (where its first entry is).
	private cursor = 0
	private downloaded = 0

	public constructor(size: number, readChecked: ReadChecked) {
		this.size = size
		this.readChecked = readChecked
	}

	public async read(offset: number, length: number, crc: number): Promise<{ bytes: Uint8Array; crc: number }> {
		const end = offset + length
		const pieces: Uint8Array[] = []
		let running = crc

		for (let at = offset; at < end;) {
			const index = Math.floor(at / COPY_BLOCK_BYTES)
			const start = index * COPY_BLOCK_BYTES
			const block = await this.block(index)
			const to = Math.min(end, start + block.length)
			const piece = block.subarray(at - start, to - start)

			running = crc32(piece, running)
			pieces.push(piece)
			at = to
		}

		this.cursor = end

		return { bytes: pieces.length === 1 ? (pieces[0] ?? new Uint8Array(0)) : joined(pieces, length), crc: running }
	}

	// A plain read when it is the pass's (see above), else undefined.
	public plain(offset: number, length: number): Promise<Uint8Array> | undefined {
		const held = this.held
		const inside =
			held !== undefined &&
			length > 0 &&
			Math.floor(offset / COPY_BLOCK_BYTES) === held.index &&
			Math.floor((offset + length - 1) / COPY_BLOCK_BYTES) === held.index

		if (!inside && offset !== this.cursor) return undefined

		return this.read(offset, length, 0).then(read => read.bytes)
	}

	public end(): number {
		this.abort.abort()
		this.held = undefined

		return this.downloaded
	}

	private block(index: number): Promise<Uint8Array> {
		if (this.held?.index === index) return this.held.bytes

		const start = index * COPY_BLOCK_BYTES
		const end = Math.min(this.size, start + COPY_BLOCK_BYTES)
		const bytes = this.readChecked(start, end, 0, this.abort.signal).then(read => {
			// Every byte the network carried counts, whatever is wrong with it.
			this.downloaded += read.bytes.length

			if (read.bytes.length !== end - start) {
				throw new Error(`short range read: ${String(read.bytes.length)} of ${String(end - start)} bytes`)
			}

			if (crc32(read.bytes, 0) !== read.crc) throw new Error(`the range at ${String(start)} arrived damaged`)

			return read.bytes
		})

		this.held = { index, bytes }

		return bytes
	}
}

function joined(pieces: readonly Uint8Array[], length: number): Uint8Array {
	const out = new Uint8Array(length)
	let at = 0

	for (const piece of pieces) {
		out.set(piece, at)
		at += piece.length
	}

	return out
}

// A ByteSource over a range port: every read goes through the deck's block cache. A checked port (the SDK worker's
// range server checksums its bytes) also serves readChecked: in a save's copy pass (beginCopies) from that pass's
// blocks, otherwise straight from the port; neither goes through the viewer's cache, whose blocks they would evict.
// The port's reader is made on the first read, so a source closed unread (close()) only shuts the serving side down.
export function rangeByteSource(spec: Extract<SourceSpec, { kind: "range" }>, decks: Map<unknown, RangeDeck>): RemoteByteSource {
	const port = spec.port as MessagePort
	const abort = new AbortController()
	let reader: RangePortReader | undefined
	let closed = false
	const readerOf = (): RangePortReader => {
		if (closed) throw new Error("the deck's range source is closed")

		reader ??= rangePortReader(port)

		return reader
	}
	const cache = new BlockCache(
		spec.size,
		(start, end, signal) => readerOf().readRange(start, end, AbortSignal.any([signal, abort.signal])),
		{
			capacity: DECK_BLOCK_CAPACITY
		}
	)
	const close = (): void => {
		if (closed) return

		closed = true
		abort.abort()
		cache.dispose()

		if (decks.get(spec.port)?.cache === cache) decks.delete(spec.port)

		if (reader === undefined) closeRangePort(port)
		else reader.close()
	}

	decks.set(spec.port, { cache, close })

	const outside = (offset: number, length: number): boolean => offset < 0 || length < 0 || offset + length > spec.size
	// The save's copy pass while one runs (a checked source only).
	let pass: CopyBlocks | undefined
	const source: RemoteByteSource = {
		size: spec.size,
		read(offset, length) {
			if (outside(offset, length)) return Promise.reject(new RangeError("Read outside the source"))

			return pass?.plain(offset, length) ?? Promise.resolve(cache.read(offset, offset + length))
		},
		close
	}

	if (!spec.checked) {
		return source
	}

	const checked: ReadChecked = (start, end, crc, signal) =>
		readerOf().readChecked(start, end, crc, AbortSignal.any([signal, abort.signal]))

	return {
		...source,
		readChecked(offset, length, crc) {
			if (outside(offset, length)) return Promise.reject(new RangeError("Read outside the source"))

			if (pass !== undefined) return pass.read(offset, length, crc)

			return checked(offset, offset + length, crc, abort.signal)
		},
		beginCopies() {
			const copies = new CopyBlocks(spec.size, checked)

			pass = copies

			return {
				end: () => {
					if (pass === copies) pass = undefined

					return copies.end()
				}
			}
		}
	}
}

function isMessage(data: unknown): data is ToPresentationWorker {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as { s?: unknown }).s === "number" &&
		typeof (data as { t?: unknown }).t === "string"
	)
}

// Serves the protocol on `scope` (the engine's host, with the realm in `options`). A deck's port, block cache and
// reader go when its session is disposed or the same session id opens another source.
export function servePresentationDeckWorker(
	scope: PresentationWorkerScope,
	options: Omit<PresentationWorkerOptions, "rangeSource"> = {}
): () => void {
	const decks = new Map<unknown, RangeDeck>()
	// The range port each session opened with.
	const ports = new Map<number, unknown>()
	const release = (s: number): void => {
		const port = ports.get(s)

		ports.delete(s)

		if (port === undefined) return

		const deck = decks.get(port)

		deck?.close()
	}
	const watch = (event: { readonly data: unknown }): void => {
		const message: unknown = event.data

		if (!isMessage(message)) return

		if (message.t === "dispose") release(message.s)
		else if (message.t === "open") {
			release(message.s)

			if (message.source.kind === "range") ports.set(message.s, message.source.port)
		} else if (message.t === "call" && message.method === "commitSaved") {
			// The session moves onto the saved file's port: the old file's reader goes (its reads are held, then served
			// from the saved file by the rebase), the new port is the session's from now on. A save kept in memory closes
			// that port unread (its source's close()), so its reader is never made.
			release(message.s)
			ports.set(message.s, message.args[0].port)
		}
	}
	// Seen before the server handles the message, so a reopen releases the old source first.
	scope.addEventListener("message", watch)

	const stop = servePresentationWorker(scope, { ...options, rangeSource: spec => rangeByteSource(spec, decks) })

	return () => {
		stop()
		scope.removeEventListener("message", watch)

		for (const s of [...ports.keys()]) release(s)
	}
}
