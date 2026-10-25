import { writeZip, type ByteChunks, type ByteSink } from "@filen/office/core/opc"
import { macrotaskYield } from "@filen/office/dom/docx"
import { convertedCopyName } from "@/features/drive/lib/copyName"
import {
	activeServiceWorker,
	assertSwControlled,
	canTransferStreams,
	discardPickedFile,
	isFsaAvailable,
	saveStreamDownload,
	triggerSwStreamDownload,
	type FsaSaveTarget,
	type SwSaveTarget
} from "@/features/drive/lib/saveDownload"

// The PDFs of a bulk Download as, delivered as the drive's Download delivers several files: one zip, saved through
// the same targets (the picked file, else the service worker's streamed download), so no browser limit on
// downloads started without a click can drop any of them. The archive is written as the PDFs are made, each PDF
// streamed into it and let go before the next is made: one PDF is held at a time. PDFs are compressed already, so
// the entries are stored. Only where neither target exists is the archive gathered into a Blob first.

export interface ZipFile {
	readonly name: string
	readonly blob: Blob
	readonly modified: Date
}

// Where the archive goes, and its sink: `close` after the archive's last byte, `fail` when it cannot be finished.
export interface ZipDelivery {
	readonly sink: ByteSink
	// Settles once the archive is saved (the browser's download finished, the picked file closed).
	readonly saved: () => Promise<void>
	readonly fail: (error: unknown) => Promise<void>
}

const SLICE_MS = 10
// Written bytes gathered into one Blob part this large, where the archive is gathered (the browser holds Blob
// data, not the page's heap).
const PART = 8 * 1024 * 1024

function blobChunks(blob: Blob): ByteChunks {
	return {
		length: blob.size,
		async *chunks() {
			const reader = blob.stream().getReader()
			let done = false

			try {
				for (;;) {
					const next = await reader.read()

					if (next.done) {
						done = true

						return
					}

					yield next.value
				}
			} finally {
				if (!done) await reader.cancel()

				reader.releaseLock()
			}
		}
	}
}

// Writes the archive of `files` (asked for one at a time, each once the one before is written) into `sink`.
export async function writeZipOf(files: AsyncIterable<ZipFile>, sink: ByteSink): Promise<void> {
	async function* items() {
		for await (const file of files) {
			yield { kind: "data" as const, name: file.name, bytes: blobChunks(file.blob), compress: false, modified: file.modified }
		}
	}

	await writeZip({ items: items() }, null, sink, {
		slicing: { pause: macrotaskYield(), sliceMs: SLICE_MS, now: () => performance.now() }
	})
}

function fsaDelivery(save: FsaSaveTarget): ZipDelivery {
	return {
		sink: {
			write: chunk => save.writable.write(chunk as Uint8Array<ArrayBuffer>),
			close: () => save.writable.close()
		},
		saved: () => Promise.resolve(),
		// The picked file goes with an archive that was not finished.
		fail: () => discardPickedFile(save)
	}
}

// The service worker pipes the stream into the browser's download (no length: the archive is made as it streams).
// The download starts with the archive's first bytes. A write waits for the browser to read; the run's Cancel
// (`signal`) or the download ending first (`onEnded`: failed, stalled, or the browser's own Cancel) stops the pipe,
// and every write waiting then rejects, so the run always ends.
function swDelivery(save: SwSaveTarget, signal: AbortSignal, onEnded: (error: unknown) => void): ZipDelivery {
	// Room for one chunk.
	const pipe = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, { highWaterMark: 1 })
	const writer = pipe.writable.getWriter()
	let delivered: Promise<void> | null = null
	let stop: (reason: unknown) => void = () => undefined
	const stopped = new Promise<never>((_resolve, reject) => {
		stop = reject
	})

	stopped.catch(() => undefined)

	const halt = (reason: unknown): void => {
		stop(reason)
		void writer.abort(reason).catch(() => undefined)
	}
	const onAbort = (): void => {
		halt(signal.reason)
	}

	signal.addEventListener("abort", onAbort, { once: true })

	// The worker has taken the download's navigation. Until then the first write waits: WebKit stops the page's
	// requests in flight when it navigates, and the next file's read would be one of them.
	let markStarted: () => void = () => undefined
	const started = new Promise<void>(resolve => {
		markStarted = resolve
	})
	const start = (): void => {
		if (delivered !== null) return

		delivered = triggerSwStreamDownload(
			save,
			crypto.randomUUID(),
			pipe.readable,
			null,
			() => {
				onEnded(new DOMException("Cancelled", "AbortError"))
			},
			markStarted
		)
		delivered.then(
			() => {
				signal.removeEventListener("abort", onAbort)
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort)
				onEnded(error)
				halt(error)
			}
		)
	}

	return {
		sink: {
			write: chunk => {
				start()

				return Promise.race([Promise.all([writer.write(chunk), started]), stopped]).then(() => undefined)
			},
			close: () => Promise.race([writer.close(), stopped])
		},
		saved: () => (delivered === null ? Promise.resolve() : Promise.race([delivered, stopped])),
		// The aborted pipe errors the browser's download; how the worker reports that is not waited for.
		fail: error => {
			signal.removeEventListener("abort", onAbort)
			halt(error)

			return Promise.resolve()
		}
	}
}

// Gathered into a Blob, downloaded once whole (`download`): where no file can be picked and no stream handed to
// the service worker.
function memoryDelivery(name: string, download: (name: string, blob: Blob) => void): ZipDelivery {
	const parts: Blob[] = []
	let pending: Uint8Array<ArrayBuffer>[] = []
	let size = 0
	const flush = (): void => {
		if (pending.length > 0) parts.push(new Blob(pending))

		pending = []
		size = 0
	}

	return {
		sink: {
			write(chunk) {
				// The writer never touches a chunk again once written (ByteSink).
				pending.push(chunk as Uint8Array<ArrayBuffer>)
				size += chunk.length

				if (size >= PART) flush()

				return Promise.resolve()
			},
			close() {
				flush()
				download(name, new Blob(parts, { type: "application/zip" }))

				return Promise.resolve()
			}
		},
		saved: () => Promise.resolve(),
		fail: () => {
			parts.length = 0
			pending = []

			return Promise.resolve()
		}
	}
}

// Where a bulk run's archive goes. Call it synchronously off the click: the save picker needs the gesture. Rejects
// when the user dismisses the picker (isPickerCancelled).
export async function zipDelivery(
	name: string,
	signal: AbortSignal,
	onEnded: (error: unknown) => void,
	download: (name: string, blob: Blob) => void
): Promise<ZipDelivery> {
	if (isFsaAvailable()) {
		const save = await saveStreamDownload(name)

		if (save.kind === "fsa") return fsaDelivery(save)
	}

	if (!canTransferStreams()) {
		return memoryDelivery(name, download)
	}

	// The worker must control the page and be running before anything is exported: an uncontrolled page (after a
	// hard reload) fails now, with the reload message, not after the first PDF. The stream needs no session.
	assertSwControlled()
	await activeServiceWorker()

	const save = await saveStreamDownload(name)

	return save.kind === "fsa" ? fsaDelivery(save) : swDelivery(save, signal, onEnded)
}

// The entries' names, one at a time: each file's own stem, numbered as a converted copy is when another entry
// already took it (names compared without case, as the drive and the systems the archive is opened on compare them);
// path separators are no part of a name in an archive.
export function zipEntryNamer(extension: string): (original: string) => Promise<string> {
	const taken = new Set<string>()

	return async original => {
		const name = await convertedCopyName(original.replace(/[/\\]/gu, "_"), extension, candidate =>
			Promise.resolve(taken.has(candidate.toLowerCase()))
		)

		taken.add(name.toLowerCase())

		return name
	}
}
