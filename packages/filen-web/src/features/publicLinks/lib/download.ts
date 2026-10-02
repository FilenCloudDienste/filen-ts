import * as Comlink from "comlink"
import type { AnyFile, AnyLinkedDirWithContext } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { pipeWorkerToSink } from "@/lib/pipeWorkerToSink"
import { discardPickedFile, isFsaAvailable, isPickerCancelled, pickFsaTarget, type FsaSaveTarget } from "@/features/drive/lib/saveDownload"
import { chooseDownloadStrategy, createCollectingSink, type CollectingSink } from "@/features/publicLinks/lib/download.logic"
import { previewCacheScope } from "@/features/preview/lib/accessMode"
import { joinPreviewBytes, loadPreviewBytes } from "@/features/preview/lib/previewCache"

// Effectful anon-download wiring for the public-link routes. NO service worker (its wasm bundle is
// authed-only) and NO authed transfers store (session-scoped machinery) — this surface is fully
// self-contained: FSA streams straight to a picked file on Chromium, else the whole file/zip is
// buffered in memory and saved via an anchor. Progress is reported to a caller-owned callback so the
// page renders its own inline indicator.

// loaded/total in bytes; `total` is null while there is no share to show: a zip whose size the SDK
// hasn't reported yet. A buffered file download reports nothing until it is done, since the bytes call
// behind it has no progress callback.
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

// Picks an FSA file off the calling user gesture. MUST be the first awaited call in a handler
// (showSaveFilePicker has to run synchronously off the gesture) — callers invoke the start* functions
// directly from the click handler, and this is their first step. Returns null when the user dismisses
// the picker (a clean no-op, never an error). A download that then fails discards the file
// (discardPickedFile), whichever step failed.
async function pickFsaFile(suggestedName: string): Promise<FsaSaveTarget | null> {
	try {
		return await pickFsaTarget(suggestedName)
	} catch (e) {
		if (isPickerCancelled(e)) {
			return null
		}

		throw e
	}
}

// Writes a buffer already in memory to the picked file.
async function writeBytes(writable: FileSystemWritableFileStream, bytes: Uint8Array): Promise<void> {
	await writable.write(bytes as Uint8Array<ArrayBuffer>)
	await writable.close()
}

// Single linked file → disk. FSA path streams; the buffered fallback refuses a file over the in-memory
// cap up front (the caller renders the "too large" note from that outcome) rather than attempting an
// allocation that would crash the tab. A file the inline preview already loaded, or is still loading,
// under this link's scope (`linkScope`, see previewCacheScope) is saved from those bytes on either path
// instead of fetched again; if that shared load is cancelled with the preview, this fetches on its own.
// Its own fetch never enters the preview cache: nothing reads a Download's bytes back, and the cache
// would hold them for the rest of the visit. The buffered one still has cached previews make way for
// it, so a large file never lands on top of a full cache, and a preview opened while it runs joins it
// instead of fetching the file a second time.
export async function startAnonFileDownload(args: {
	file: AnyFile
	name: string
	size: bigint
	linkScope: string
	onProgress: AnonDownloadProgress
}): Promise<AnonDownloadOutcome> {
	const { file, name, size, linkScope, onProgress } = args
	const fsaAvailable = isFsaAvailable()

	let target: FsaSaveTarget | null = null

	if (fsaAvailable) {
		try {
			target = await pickFsaFile(name)
		} catch (e) {
			return { status: "error", dto: asErrorDTO(e) }
		}

		if (target === null) {
			return { status: "cancelled" }
		}
	}

	const strategy = chooseDownloadStrategy({ fsaAvailable: target !== null, size })

	if (strategy.kind === "too-large") {
		return { status: "too-large" }
	}

	const transferId = crypto.randomUUID()
	const scope = previewCacheScope("anon", linkScope)

	try {
		const previewed = await joinPreviewBytes(scope, file.uuid)

		if (previewed !== undefined) {
			if (target !== null) {
				await writeBytes(target.writable, previewed)
			} else {
				saveBlob(new Blob([previewed as BlobPart]), name)
			}

			onProgress(Number(size), Number(size))
		} else if (target !== null) {
			await pipeWorkerToSink(target.writable, transferred =>
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
			const bytes = await loadPreviewBytes(
				scope,
				file.uuid,
				Number(size),
				() => sdkApi.downloadLinkedFileBytesAnon(file, transferId),
				{
					store: false
				}
			)

			saveBlob(new Blob([bytes as BlobPart]), name)
			onProgress(Number(size), Number(size))
		}
	} catch (e) {
		if (target !== null) {
			await discardPickedFile(target)
		}

		const dto = asErrorDTO(e)

		return dto.kind === "Cancelled" ? { status: "cancelled" } : { status: "error", dto }
	}

	return { status: "success" }
}

// Whole linked directory → a single zip. FSA streams the archive to the picked file; the non-FSA
// fallback collects it in memory (createCollectingSink, cap-enforced incrementally since a zip's total
// isn't known up front, reported as "too-large" once it trips) then saves one Blob. `<name>.zip` mirrors
// old-web's naming.
export async function startAnonDirZipDownload(args: {
	dir: AnyLinkedDirWithContext
	name: string
	onProgress: AnonDownloadProgress
}): Promise<AnonDownloadOutcome> {
	const { dir, name, onProgress } = args
	const fileName = `${name}.zip`
	const transferId = crypto.randomUUID()

	let target: FsaSaveTarget | null = null
	let sink: CollectingSink | null = null

	if (isFsaAvailable()) {
		try {
			target = await pickFsaFile(fileName)
		} catch (e) {
			return { status: "error", dto: asErrorDTO(e) }
		}

		if (target === null) {
			return { status: "cancelled" }
		}
	}

	const reportProgress = Comlink.proxy((bytesWritten: bigint, totalBytes: bigint) => {
		onProgress(Number(bytesWritten), totalBytes > 0n ? Number(totalBytes) : null)
	})

	try {
		if (target !== null) {
			await pipeWorkerToSink(target.writable, transferred =>
				sdkApi.downloadLinkedDirToZipAnon(dir, transferId, transferred, reportProgress)
			)
		} else {
			const buffered = createCollectingSink()

			sink = buffered

			await pipeWorkerToSink(buffered.writable, transferred =>
				sdkApi.downloadLinkedDirToZipAnon(dir, transferId, transferred, reportProgress)
			)

			saveBlob(await buffered.done, fileName)
		}
	} catch (e) {
		if (target !== null) {
			await discardPickedFile(target)
		}

		if (sink?.capExceeded() === true) {
			return { status: "too-large" }
		}

		const dto = asErrorDTO(e)

		return dto.kind === "Cancelled" ? { status: "cancelled" } : { status: "error", dto }
	}

	return { status: "success" }
}
