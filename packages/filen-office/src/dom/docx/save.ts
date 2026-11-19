import {
	BytePieces,
	OpcPackage,
	crc32,
	joinBytes,
	type ByteChunks,
	type ByteSource,
	type PartBytes,
	type PartChange
} from "../../core/opc/index"
import { DocxSaveError, isDocxSaveFailure } from "../../core/docx/write/failure"
import { zipDocxSave, type DocxPartChanges } from "../../core/docx/write/zip"
import type { OdtWriteNotice } from "../../core/odt/write/writer"
import type { DocxWorkerLike, DocxWorkerScope } from "./host"
import { clearTimer, setTimer } from "../platform"

// The zip half of a save (zipDocxSave: the checked parts written into the original archive, then the zip half
// of gate 2), behind one interface for both threads: in a worker (web), where deflating and checksumming a
// large part takes no time from the page, or on the calling thread (mobile's WebView, tests). The original
// file and a rewritten part's pieces (mostly views of the part it replaces) stay with the caller: the worker
// reads the ranges it needs as it writes, a copy of each, so neither is ever joined or held whole twice.

export interface DocxZipped {
	readonly bytes: Uint8Array
	// Parts rewritten or added; every other entry was copied as it was, compressed bytes included.
	readonly changedParts: readonly string[]
	readonly zipMs: number
	readonly verifyZipMs: number
	// What the file's own writer wrote otherwise than the edit has it, for the user to be told (an ODF 1.1 file's
	// comments marking points).
	readonly notices?: readonly DocxSaveNotice[]
}

export type DocxSaveNotice = OdtWriteNotice

// One open document's zip writer.
export interface DocxZipper {
	// Rejects with a DocxSaveError for a refusal, a DocxClosedError once disposed.
	zip(changes: DocxPartChanges): Promise<DocxZipped>
	// Ends the zipper; a zip under way rejects.
	dispose(): void
}

// Makes the zipper of a document from its opened package (the archive the save copies from).
export type DocxZipperFactory = (original: OpcPackage) => DocxZipper

export class DocxClosedError extends Error {
	constructor() {
		super("The document closed")
		this.name = "DocxClosedError"
	}
}

// On the calling thread, from the package the editor already opened.
export function inThreadDocxZipper(original: OpcPackage): DocxZipper {
	let disposed = false

	return {
		async zip(changes) {
			if (disposed) throw new DocxClosedError()

			const result = await zipDocxSave(original, changes)

			if (disposed) throw new DocxClosedError()
			if (result.bytes === undefined) throw new DocxSaveError("invalidPackage", "The written file is missing")

			return { bytes: result.bytes, changedParts: result.changedParts, zipMs: result.zipMs, verifyZipMs: result.verifyZipMs }
		},
		dispose() {
			disposed = true
		}
	}
}

// --- Messages ---

// A changed part: its bytes, or (a part given as pieces) its size, read from the page as the zip goes.
interface PartMessage {
	readonly name: string
	readonly bytes?: Uint8Array
	readonly size?: number
	readonly compress?: boolean
	// The CRC-32 the page computed from the bytes its part checks read (PartChange.crc32).
	readonly crc?: number
}

type ToWorker =
	| {
			readonly t: "zip"
			readonly id: number
			readonly size: number
			readonly replace: readonly PartMessage[]
			readonly add: readonly PartMessage[]
			readonly remove?: readonly string[]
	  }
	// `crc`: when asked for (`seed`), the CRC-32 of the bytes as the page read them, continued from the seed.
	| { readonly t: "read"; readonly id: number; readonly bytes?: Uint8Array; readonly crc?: number; readonly error?: string }

type FromWorker =
	| { readonly t: "read"; readonly id: number; readonly offset: number; readonly length: number; readonly seed?: number }
	// Bytes [offset, offset + length) of part `part` (index into replace, then add) of zip `zip`.
	| {
			readonly t: "piece"
			readonly id: number
			readonly zip: number
			readonly part: number
			readonly offset: number
			readonly length: number
	  }
	| {
			readonly t: "zipped"
			readonly id: number
			readonly bytes: Uint8Array
			readonly changedParts: readonly string[]
			readonly zipMs: number
			readonly verifyZipMs: number
	  }
	| { readonly t: "failed"; readonly id: number; readonly reason?: string; readonly name?: string; readonly message: string }
	// A zip under way is still being worked on (sent every ALIVE_MS).
	| { readonly t: "alive"; readonly id: number }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function parts(value: unknown, streamed: (index: number, size: number) => ByteChunks, first: number): PartChange[] | null {
	if (!Array.isArray(value)) return null

	const out: PartChange[] = []

	for (const [index, item] of (value as unknown[]).entries()) {
		if (!isRecord(item) || typeof item["name"] !== "string") return null

		const bytes = item["bytes"]
		const size = item["size"]
		const compress = item["compress"]
		const crc = item["crc"]
		const content: PartBytes | null =
			bytes instanceof Uint8Array
				? bytes
				: typeof size === "number" && Number.isSafeInteger(size) && size >= 0
					? streamed(first + index, size)
					: null

		if (content === null) return null

		out.push({
			name: item["name"],
			bytes: content,
			...(typeof compress === "boolean" ? { compress } : {}),
			...(typeof crc === "number" && Number.isInteger(crc) ? { crc32: crc >>> 0 } : {})
		})
	}

	return out
}

// Pieces read from the page at most this long.
const PIECE = 4 * 1024 * 1024
// How often a busy worker says so, and how long the page waits without hearing from it before giving up.
const ALIVE_MS = 1000
const STALL_MS = 20_000

export class DocxZipWorkerError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "DocxZipWorkerError"
	}
}

// A buffer that holds exactly `bytes`, to transfer; a view of a larger buffer is copied first.
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? (bytes as Uint8Array<ArrayBuffer>)
		: bytes.slice()
}

// Bytes [offset, offset + length) of a part, in a buffer of their own.
async function pieceOf(content: PartBytes | undefined, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
	if (content === undefined) throw new RangeError("No such part")

	const bytes = content instanceof BytePieces ? content.copy(offset, length) : (await joinBytes(content)).slice(offset, offset + length)

	if (bytes.length !== length) throw new RangeError("A piece beyond the part")

	return bytes as Uint8Array<ArrayBuffer>
}

// --- Worker side ---

// Serves zips for one document (the page makes a worker per document being edited): the original archive is
// opened once, over reads answered by the page, and kept for the next save.
export function serveDocxZipWorker(scope: DocxWorkerScope): void {
	const reads = new Map<
		number,
		{
			resolve: (read: { readonly bytes: Uint8Array; readonly crc: number | undefined }) => void
			reject: (error: Error) => void
			// For reads of the original: the seed its CRC was asked with (every such read is checked on arrival).
			seed?: number
		}
	>()
	let nextRead = 1
	let original: Promise<OpcPackage> | undefined
	const post = (message: FromWorker, transfer: readonly ArrayBuffer[] = []): void => {
		scope.post(message, transfer)
	}
	const request = (
		message: (id: number) => FromWorker,
		seed?: number
	): Promise<{ readonly bytes: Uint8Array; readonly crc: number | undefined }> => {
		const id = nextRead++

		return new Promise((resolve, reject) => {
			reads.set(id, seed === undefined ? { resolve, reject } : { resolve, reject, seed })
			post(message(id))
		})
	}
	// Every read of the original comes with the page's CRC of its own bytes, checked here before the bytes are
	// used (the directory and layout reads as much as the copies); a copy also keeps the page's CRC, so the
	// written file is checked against what the page holds, not what arrived.
	const checkedRead = async (offset: number, length: number, seed: number): Promise<{ bytes: Uint8Array; crc: number }> => {
		const read = await request(id => ({ t: "read", id, offset, length, seed }), seed)

		if (read.crc === undefined) throw new DocxSaveError("untouchedChanged", "A read of the original came without its checksum")

		return { bytes: read.bytes, crc: read.crc }
	}
	const source = (size: number): ByteSource => ({
		size,
		read: async (offset, length) => (await checkedRead(offset, length, 0)).bytes,
		readChecked: checkedRead
	})

	scope.listen(data => {
		if (!isRecord(data) || typeof data["id"] !== "number") return

		const message = data as ToWorker

		if (message.t === "read") {
			const pending = reads.get(message.id)

			reads.delete(message.id)

			if (message.bytes instanceof Uint8Array) {
				const crc = typeof message.crc === "number" ? message.crc : undefined

				if (pending?.seed !== undefined && (crc === undefined || crc32(message.bytes, pending.seed) !== crc))
					pending.reject(new DocxSaveError("untouchedChanged", "A read of the original arrived damaged"))
				else pending?.resolve({ bytes: message.bytes, crc })
			} else pending?.reject(new RangeError(message.error ?? "Read failed"))

			return
		}

		if (message.t !== "zip") return

		const id = message.id
		// A part given as pieces, pulled from the page a piece at a time (each a copy of its own).
		const streamed = (part: number, size: number): ByteChunks => ({
			length: size,
			async *chunks() {
				for (let offset = 0; offset < size; offset += PIECE) {
					const length = Math.min(PIECE, size - offset)
					const piece = (await request(read => ({ t: "piece", id: read, zip: id, part, offset, length }))).bytes

					if (piece.length !== length) throw new RangeError("A piece of a part came back short")

					yield piece
				}
			}
		})
		const replace = parts(message.replace, streamed, 0)
		const add = parts(message.add, streamed, Array.isArray(message.replace) ? message.replace.length : 0)

		const remove: unknown = message.remove ?? []

		if (
			replace === null ||
			add === null ||
			typeof message.size !== "number" ||
			!Array.isArray(remove) ||
			!remove.every((name: unknown): name is string => typeof name === "string")
		) {
			post({ t: "failed", id, message: "Malformed zip request" })

			return
		}

		// Heard by the page while this zip runs: on a timer, and from the steps that run without giving the
		// worker's event loop a turn (checking the written file in memory).
		let heard = 0
		const alive = setTimer(() => post({ t: "alive", id }), ALIVE_MS, true)
		const progress = (): void => {
			const now = Date.now()

			if (now - heard < ALIVE_MS) return

			heard = now
			post({ t: "alive", id })
		}
		const run = async (): Promise<void> => {
			const opening = (original ??= OpcPackage.open(source(message.size)))
			// One that failed to open is opened again by the next save.
			const archive = await opening.catch((error: unknown) => {
				if (original === opening) original = undefined

				throw error
			})
			// The page computed every part's CRC from the bytes its part checks read; none may be missing here.
			const result = await zipDocxSave(archive, { replace, add, remove }, { requireChecksums: true, progress })

			if (result.bytes === undefined) throw new DocxSaveError("invalidPackage", "The written file is missing")

			const bytes = own(result.bytes)

			post({ t: "zipped", id, bytes, changedParts: result.changedParts, zipMs: result.zipMs, verifyZipMs: result.verifyZipMs }, [
				bytes.buffer
			])
		}

		run()
			.catch((error: unknown) => {
				if (error instanceof DocxSaveError) post({ t: "failed", id, reason: error.reason, message: error.message })
				else if (error instanceof Error) post({ t: "failed", id, name: error.name, message: error.message })
				else post({ t: "failed", id, message: String(error) })
			})
			.finally(() => {
				clearTimer(alive, true)
			})
	})
}

// --- Caller side ---

// A worker per document, started at its first save and ended with dispose() (when the editor closes): an
// open document's later saves reuse it and the archive it opened.
// A worker that stops answering (it died without an error event, or hangs) is ended after `stallMs` without a
// message while a zip is pending: the zip rejects with a DocxZipWorkerError (the editor stays as it was,
// unsaved) and the next save starts a new worker.
export function docxZipWorker(create: () => DocxWorkerLike, options: { readonly stallMs?: number } = {}): DocxZipperFactory {
	const stallMs = options.stallMs ?? STALL_MS

	return original => {
		const source = original.zip.source
		let worker: DocxWorkerLike | undefined
		let watchdog: unknown
		let disposed = false
		let nextZip = 1
		const pending = new Map<
			number,
			{
				readonly resolve: (zipped: DocxZipped) => void
				readonly reject: (error: Error) => void
				// Changed parts in message order (replace, then add), for the worker's piece reads.
				readonly parts: readonly PartBytes[]
			}
		>()
		const failAll = (error: Error): void => {
			for (const entry of pending.values()) entry.reject(error)

			pending.clear()
			watch()
		}
		// Ends the worker (it failed or stopped answering): pending zips reject, the next save starts another.
		const drop = (current: DocxWorkerLike, error: Error): void => {
			if (worker === current) {
				worker = undefined
				current.terminate()
			}

			failAll(error)
		}
		// (Re)arms the watchdog while zips are pending.
		const watch = (): void => {
			clearTimer(watchdog)
			watchdog = undefined

			const current = worker

			if (pending.size === 0 || current === undefined) return

			watchdog = setTimer(() => {
				drop(current, new DocxZipWorkerError(`The zip worker stopped answering (nothing for ${stallMs} ms)`))
			}, stallMs)
		}
		const onMessage = (data: unknown): void => {
			if (!isRecord(data) || typeof data["id"] !== "number" || worker === undefined) return

			const message = data as FromWorker
			const current = worker

			watch()

			switch (message.t) {
				case "alive":
					return
				case "read":
					source.read(message.offset, message.length).then(
						read => {
							// A copy of just that range in a buffer of its own, moved: posting the view itself would
							// clone the whole file buffer behind it. Checksummed here when asked, from the page's own bytes.
							const seed = message.seed
							const crc = typeof seed === "number" ? crc32(read, seed) : undefined
							const bytes = read.slice()

							if (worker === current)
								current.post({ t: "read", id: message.id, bytes, ...(crc === undefined ? {} : { crc }) }, [bytes.buffer])
						},
						(error: unknown) => {
							if (worker === current)
								current.post(
									{ t: "read", id: message.id, error: error instanceof Error ? error.message : String(error) },
									[]
								)
						}
					)

					return
				case "piece": {
					const content = pending.get(message.zip)?.parts[message.part]

					void pieceOf(content, message.offset, message.length).then(
						bytes => {
							// A buffer of its own, moved to the worker.
							if (worker === current) current.post({ t: "read", id: message.id, bytes }, [bytes.buffer])
						},
						(error: unknown) => {
							if (worker === current)
								current.post(
									{ t: "read", id: message.id, error: error instanceof Error ? error.message : String(error) },
									[]
								)
						}
					)

					return
				}
				case "zipped": {
					const entry = pending.get(message.id)

					pending.delete(message.id)
					watch()

					if (!(message.bytes instanceof Uint8Array)) {
						entry?.reject(new Error("The zip worker sent no file"))

						return
					}

					entry?.resolve({
						bytes: message.bytes,
						changedParts: Array.isArray(message.changedParts)
							? message.changedParts.filter(name => typeof name === "string")
							: [],
						zipMs: typeof message.zipMs === "number" ? message.zipMs : 0,
						verifyZipMs: typeof message.verifyZipMs === "number" ? message.verifyZipMs : 0
					})

					return
				}
				case "failed": {
					const entry = pending.get(message.id)
					const text = typeof message.message === "string" ? message.message : "The zip failed"

					pending.delete(message.id)
					watch()

					if (isDocxSaveFailure(message.reason)) {
						entry?.reject(new DocxSaveError(message.reason, text))
					} else {
						const error = new Error(text)

						if (typeof message.name === "string") error.name = message.name

						entry?.reject(error)
					}

					return
				}
			}
		}

		const connect = (): DocxWorkerLike => {
			if (worker !== undefined) return worker

			const started = create()

			worker = started
			// A worker that failed (its script did not load, it crashed, a message did not arrive whole) is replaced
			// at the next save.
			started.listen(onMessage, () => {
				drop(started, new DocxZipWorkerError("The zip worker failed"))
			})

			return started
		}

		return {
			zip(changes) {
				if (disposed) return Promise.reject(new DocxClosedError())

				const target = connect()
				const id = nextZip++
				// Joined parts (small: styles, relationships...) go with the request, each copied into a buffer of its
				// own and moved; pieces stay here.
				const transfer: ArrayBuffer[] = []
				const message = (change: PartChange): PartMessage => {
					let content: { bytes: Uint8Array } | { size: number }

					if (change.bytes instanceof Uint8Array) {
						const bytes = change.bytes.slice()

						transfer.push(bytes.buffer)
						content = { bytes }
					} else {
						content = { size: change.bytes.length }
					}

					return {
						name: change.name,
						...content,
						...(change.compress === undefined ? {} : { compress: change.compress }),
						...(change.crc32 === undefined ? {} : { crc: change.crc32 })
					}
				}
				const request: ToWorker = {
					t: "zip",
					id,
					size: source.size,
					replace: changes.replace.map(message),
					add: changes.add.map(message),
					...(changes.remove === undefined || changes.remove.length === 0 ? {} : { remove: changes.remove })
				}

				return new Promise<DocxZipped>((resolve, reject) => {
					pending.set(id, { resolve, reject, parts: [...changes.replace, ...changes.add].map(change => change.bytes) })
					target.post(request, transfer)
					watch()
				})
			},
			dispose() {
				if (disposed) return

				disposed = true
				worker?.terminate()
				worker = undefined
				failAll(new DocxClosedError())
				clearTimer(watchdog)
			}
		}
	}
}
