import * as Comlink from "comlink"
import type { AnyFile, AnyLinkedDirWithContext, DirPublicLink, NonRootLinkedItem } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { pipeWorkerToSink } from "@/lib/pipeWorkerToSink"
import {
	canStreamToSw,
	discardPickedFile,
	isFsaAvailable,
	isPickerCancelled,
	pickFsaTarget,
	saveBlob,
	swTarget,
	writeBytesToPickedFile,
	type FsaSaveTarget
} from "@/features/drive/lib/saveDownload"
import { streamProducerToSw } from "@/features/drive/lib/swStreamProducer"
import { chooseDownloadStrategy, createCollectingSink, type CollectingSink } from "@/features/publicLinks/lib/download.logic"
import { previewCacheScope } from "@/features/preview/lib/accessMode"
import { joinPreviewBytes, loadPreviewBytes } from "@/features/preview/lib/previewCache"

// Effectful anon-download wiring for the public-link routes. NO authed transfers store (session-scoped
// machinery) and no session in the service worker (its wasm bundle is authed-only): FSA streams straight to a
// picked file on Chromium; elsewhere the page's own SDK streams through the service worker, which only pipes the
// bytes into the browser's download (its progress and Cancel included). Only where neither exists is the whole
// file/zip buffered in memory and saved via an anchor. Progress is reported to a caller-owned callback so the
// page renders its own inline indicator.

// loaded/total in bytes; `total` is null while there is no share to show: a zip whose size the SDK
// hasn't reported yet. A buffered file download reports nothing until it is done, since the bytes call
// behind it has no progress callback.
export type AnonDownloadProgress = (loaded: number, total: number | null) => void

export type AnonDownloadOutcome =
	{ status: "success" } | { status: "cancelled" } | { status: "too-large" } | { status: "error"; dto: ErrorDTO }

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

// Single linked file → disk. The FSA and service worker paths stream; the buffered fallback refuses a file over the in-memory
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

	const strategy = chooseDownloadStrategy({ fsaAvailable: target !== null, streamAvailable: canStreamToSw(), size })

	if (strategy.kind === "too-large") {
		return { status: "too-large" }
	}

	const transferId = crypto.randomUUID()
	const scope = previewCacheScope("anon", linkScope)
	const reportProgress = Comlink.proxy((bytes: bigint) => {
		onProgress(Number(bytes), Number(size))
	})

	try {
		const previewed = await joinPreviewBytes(scope, file.uuid)

		if (previewed !== undefined) {
			if (target !== null) {
				await writeBytesToPickedFile(target, previewed)
			} else {
				saveBlob(new Blob([previewed as BlobPart]), name)
			}

			onProgress(Number(size), Number(size))
		} else if (target !== null) {
			await pipeWorkerToSink(target.writable, transferred =>
				sdkApi.downloadLinkedFileToWriterAnon(file, transferId, transferred, reportProgress)
			)
		} else if (strategy.kind === "stream") {
			await streamProducerToSw(swTarget(name), transferId, Number(size), writable =>
				sdkApi.downloadLinkedFileToWriterAnon(file, transferId, Comlink.transfer(writable, [writable]), reportProgress)
			)
		} else {
			const bytes = await loadPreviewBytes(
				scope,
				file.uuid,
				Number(size),
				() => sdkApi.downloadLinkedFileBytesAnon(file, transferId),
				{
					store: false,
					reserve: true
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

// Whole linked directory → a single zip. `<name>.zip` mirrors old-web's naming.
export function startAnonDirZipDownload(args: {
	dir: AnyLinkedDirWithContext
	name: string
	onProgress: AnonDownloadProgress
}): Promise<AnonDownloadOutcome> {
	const { dir, name, onProgress } = args

	return startAnonZipDownload(`${name}.zip`, onProgress, (transferId, writable, progress) =>
		sdkApi.downloadLinkedDirToZipAnon(dir, transferId, writable, progress)
	)
}

// A selection of one level's files and subdirectories → a single zip, named after that level (`name`).
export function startAnonItemsZipDownload(args: {
	items: NonRootLinkedItem[]
	link: DirPublicLink
	name: string
	onProgress: AnonDownloadProgress
}): Promise<AnonDownloadOutcome> {
	const { items, link, name, onProgress } = args

	return startAnonZipDownload(`${name}.zip`, onProgress, (transferId, writable, progress) =>
		sdkApi.downloadLinkedItemsToZipAnon(items, link, transferId, writable, progress)
	)
}

type ZipProducer = (
	transferId: string,
	writable: WritableStream<Uint8Array>,
	progress: (bytesWritten: bigint, totalBytes: bigint) => void
) => Promise<void>

// FSA streams the archive to the picked file, else the service worker streams it into the browser's download; the
// fallback without either collects it in memory (createCollectingSink, cap-enforced incrementally since a zip's total
// isn't known up front, reported as "too-large" once it trips) then saves one Blob.
async function startAnonZipDownload(
	fileName: string,
	onProgress: AnonDownloadProgress,
	produce: ZipProducer
): Promise<AnonDownloadOutcome> {
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
			await pipeWorkerToSink(target.writable, transferred => produce(transferId, transferred, reportProgress))
		} else if (canStreamToSw()) {
			await streamProducerToSw(swTarget(fileName), transferId, null, writable =>
				produce(transferId, Comlink.transfer(writable, [writable]), reportProgress)
			)
		} else {
			const buffered = createCollectingSink()

			sink = buffered

			await pipeWorkerToSink(buffered.writable, transferred => produce(transferId, transferred, reportProgress))

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
