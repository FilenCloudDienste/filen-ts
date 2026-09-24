import * as Comlink from "comlink"
import type { AnyFile, AnyLinkedDirWithContext } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { isFsaAvailable, isPickerCancelled } from "@/features/drive/lib/saveDownload"
import { chooseDownloadStrategy, createCollectingSink } from "@/features/publicLinks/lib/download.logic"
import { previewCacheScope } from "@/features/preview/lib/accessMode"
import { joinPreviewBytes, reservePreviewRoom } from "@/features/preview/lib/previewCache"

// Effectful anon-download wiring for the public-link routes. NO service worker (its wasm bundle is
// authed-only) and NO authed transfers store (session-scoped machinery) — this surface is fully
// self-contained: FSA streams straight to a picked file on Chromium, else the whole file/zip is
// buffered in memory and saved via an anchor. Progress is reported to a caller-owned callback so the
// page renders its own inline indicator.

// loaded/total in bytes; `total` is null only for the brief pre-first-progress window of a zip whose
// size the SDK hasn't reported yet.
export type AnonDownloadProgress = (loaded: number, total: number | null) => void

export type AnonDownloadOutcome =
	{ status: "success" } | { status: "cancelled" } | { status: "too-large" } | { status: "error"; dto: ErrorDTO }

// Saves a fully-buffered blob via a transient anchor. The object URL is revoked after a delay so the
// browser has grabbed the download before it is released (an immediate revoke cancels the save in some
// browsers).
function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement("a")

	anchor.href = url
	anchor.download = name
	document.body.appendChild(anchor)
	anchor.click()
	anchor.remove()

	setTimeout(() => {
		URL.revokeObjectURL(url)
	}, 10_000)
}

// Picks an FSA writable off the calling user gesture. MUST be the first awaited call in a handler
// (showSaveFilePicker has to run synchronously off the gesture) — callers invoke the start* functions
// directly from the click handler, and this is their first step. Returns null when the user dismisses
// the picker (a clean no-op, never an error).
async function pickFsaWritable(suggestedName: string): Promise<FileSystemWritableFileStream | null> {
	const picker = window.showSaveFilePicker

	if (picker === undefined) {
		return null
	}

	try {
		const handle = await picker({ suggestedName })

		return await handle.createWritable()
	} catch (e) {
		if (isPickerCancelled(e)) {
			return null
		}

		throw e
	}
}

// Bridges a worker stream to a main-thread destination: a TransformStream's writable end is transferred
// into the worker (the SDK pushes decrypted bytes into it), its readable end piped to the destination
// sink here. COORDINATED TEARDOWN mirrors the authed downloadViaFsa: a rejected worker call aborts the
// pipe too, so a consumer never hangs on an open-but-abandoned stream; the success path awaits the raw
// pipe result so a close/flush failure (disk full, revoked handle) rejects rather than looking done.
async function pipeWorkerToSink(
	destination: WritableStream<Uint8Array>,
	run: (transferred: WritableStream<Uint8Array>) => Promise<void>
): Promise<void> {
	const transform = new TransformStream<Uint8Array, Uint8Array>()
	const teardown = new AbortController()
	const sinkDone = transform.readable.pipeTo(destination, { signal: teardown.signal })

	try {
		await run(Comlink.transfer(transform.writable, [transform.writable]))
	} catch (e) {
		teardown.abort()
		await sinkDone.catch(() => undefined)

		throw e
	}

	await sinkDone
}

// Writes a buffer already in memory to the picked file; an aborted write leaves no partial file behind.
async function writeBytes(writable: FileSystemWritableFileStream, bytes: Uint8Array): Promise<void> {
	try {
		await writable.write(bytes as Uint8Array<ArrayBuffer>)
		await writable.close()
	} catch (e) {
		await writable.abort().catch(() => undefined)

		throw e
	}
}

// Single linked file → disk. FSA path streams; the buffered fallback refuses a file over the in-memory
// cap up front (the caller renders the "too large" note from that outcome) rather than attempting an
// allocation that would crash the tab. A file the inline preview already loaded, or is still loading,
// under this link's scope (`linkScope`, see previewCacheScope) is saved from those bytes on either path
// instead of fetched again; if that shared load is cancelled with the preview, this fetches on its own.
// Its own fetch never enters the preview cache: nothing reads a Download's bytes back, and the cache
// would hold them for the rest of the visit. The buffered one still has cached previews make way for
// it, so a large file never lands on top of a full cache.
export async function startAnonFileDownload(args: {
	file: AnyFile
	name: string
	size: bigint
	linkScope: string
	onProgress: AnonDownloadProgress
}): Promise<AnonDownloadOutcome> {
	const { file, name, size, linkScope, onProgress } = args
	const fsaAvailable = isFsaAvailable()

	let writable: FileSystemWritableFileStream | null = null

	if (fsaAvailable) {
		try {
			writable = await pickFsaWritable(name)
		} catch (e) {
			return { status: "error", dto: asErrorDTO(e) }
		}

		if (writable === null) {
			return { status: "cancelled" }
		}
	}

	const strategy = chooseDownloadStrategy({ fsaAvailable: writable !== null, size })

	if (strategy.kind === "too-large") {
		return { status: "too-large" }
	}

	const transferId = crypto.randomUUID()
	const scope = previewCacheScope("anon", linkScope)

	try {
		if (writable === null) {
			onProgress(0, Number(size))
		}

		const previewed = await joinPreviewBytes(scope, file.uuid)

		if (previewed !== undefined) {
			if (writable !== null) {
				await writeBytes(writable, previewed)
			} else {
				saveBlob(new Blob([previewed as BlobPart]), name)
			}

			onProgress(Number(size), Number(size))
		} else if (writable !== null) {
			const fsaWritable = writable

			await pipeWorkerToSink(fsaWritable, transferred =>
				sdkApi.downloadLinkedFileToWriterAnon(
					file,
					transferId,
					transferred,
					Comlink.proxy((bytes: bigint) => {
						onProgress(Number(bytes), Number(size))
					})
				)
			)
		} else {
			reservePreviewRoom(Number(size))

			const bytes = await sdkApi.downloadLinkedFileBytesAnon(file, transferId)

			saveBlob(new Blob([bytes as BlobPart]), name)
			onProgress(Number(size), Number(size))
		}
	} catch (e) {
		const dto = asErrorDTO(e)

		return dto.kind === "Cancelled" ? { status: "cancelled" } : { status: "error", dto }
	}

	return { status: "success" }
}

// Whole linked directory → a single zip. FSA streams the archive to the picked file; the non-FSA
// fallback collects it in memory (createCollectingSink, cap-enforced incrementally since a zip's total
// isn't known up front) then saves one Blob. `<name>.zip` mirrors old-web's naming.
export async function startAnonDirZipDownload(args: {
	dir: AnyLinkedDirWithContext
	name: string
	onProgress: AnonDownloadProgress
}): Promise<AnonDownloadOutcome> {
	const { dir, name, onProgress } = args
	const fileName = `${name}.zip`
	const transferId = crypto.randomUUID()

	let fsaWritable: FileSystemWritableFileStream | null = null

	if (isFsaAvailable()) {
		try {
			fsaWritable = await pickFsaWritable(fileName)
		} catch (e) {
			return { status: "error", dto: asErrorDTO(e) }
		}

		if (fsaWritable === null) {
			return { status: "cancelled" }
		}
	}

	const reportProgress = Comlink.proxy((bytesWritten: bigint, totalBytes: bigint) => {
		onProgress(Number(bytesWritten), totalBytes > 0n ? Number(totalBytes) : null)
	})

	try {
		if (fsaWritable !== null) {
			const destination = fsaWritable

			await pipeWorkerToSink(destination, transferred =>
				sdkApi.downloadLinkedDirToZipAnon(dir, transferId, transferred, reportProgress)
			)
		} else {
			const sink = createCollectingSink()

			await pipeWorkerToSink(sink.writable, transferred =>
				sdkApi.downloadLinkedDirToZipAnon(dir, transferId, transferred, reportProgress)
			)

			saveBlob(await sink.done, fileName)
		}
	} catch (e) {
		const dto = asErrorDTO(e)

		return dto.kind === "Cancelled" ? { status: "cancelled" } : { status: "error", dto }
	}

	return { status: "success" }
}
