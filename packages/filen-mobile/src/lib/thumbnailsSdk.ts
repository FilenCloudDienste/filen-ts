import * as FileSystem from "expo-file-system"
import { MakeThumbnailInMemoryResult_Tags, ManagedFuture, type AnyFile, type MakeThumbnailInMemoryResult } from "@filen/sdk-rs"
import { run } from "@filen/utils"
import auth from "@/lib/auth"
import { toSignalOpts, wrapAbortSignalForSdk, disposeSdkAbortSignal } from "@/lib/signals"
import { abortError } from "@/lib/thumbnailsHelpers"
import logger from "@/lib/logger"

// The SDK request box (Contain, never upscaled). 384 wide is sized to the tiles that actually render
// it: the photos grid divides the screen by a 1-5 tiles-per-row setting, so a tile reaches half the
// screen width at 2 and the whole width at 1, and even the densest drive grid is 3 columns below
// 600dp (~414 px at 3×). 256 was an upscale in every one of those.
//
// The 768 long side keeps the 2:1 ratio that raises the SDK's embedded-preview acceptance bar
// (microthumb lib.rs:367-370, 511-513) in step with the width, so a preview is only taken when it is
// large enough for the box. That does spend the ~320 px HEIC `thmb`, which now costs a full decode;
// a RAW's full-size embedded JPEG is unaffected and still answers in a couple of range reads.
export const THUMBNAIL_MAX_WIDTH = 384
export const THUMBNAIL_MAX_HEIGHT = 768

// WebP quality 0-100. Absent would mean LOSSLESS (the SDK's default), which is what the box above
// could not afford: lossy runs several times smaller on photographic content, and that is what pays
// for 2.25× the pixels without growing the cache. Storage is the binding constraint at both ends —
// web caps its cache at 256 MiB and evicts LRU, this one is not capped at all — so bytes per entry
// is what a large library pays forever. 80 is where WebP artefacts stop being visible at tile size;
// above it the extra bytes buy detail no tile resolves.
export const THUMBNAIL_LOSSY_QUALITY = 80

// written → `<uuid>.webp` exists, return its URI
// settled → Unsupported / OverBudget / Corrupt: no thumbnail for this session. Unsupported is a
//           rare magic-byte mismatch behind the canMakeThumbnail gate; OverBudget / Corrupt may be a
//           transport blip wearing a verdict's hat (heif.rs:197-205), so nothing is persisted and the
//           caller forgets the verdict on the next online flip.
export type SdkThumbnailOutcome = "written" | "settled"

// The single place an SDK verdict becomes (or does not become) a file on disk. Both entry points below
// return the same union and differ only in where the bytes came from — ranged reads of the encrypted
// remote file, or a path on this device — so the write, the tmp-rename and the 4-arm mapping live here
// once rather than twice.
function handleThumbnailResult(
	result: MakeThumbnailInMemoryResult,
	params: {
		uuid: string
		outputPath: string
	}
): SdkThumbnailOutcome {
	switch (result.tag) {
		case MakeThumbnailInMemoryResult_Tags.Thumbnail: {
			// Write beside the destination and rename into place so a crash never leaves a torn
			// .webp for the rows to render (restore() sweeps .tmp; generate() treats 0 bytes as absent).
			// expo-file-system rebinds a handle to its destination as the LAST step of moveSync (both
			// platforms), so `tmpFile` is only ever touched in the catch below — i.e. before any rebind
			// could have happened; once the rename has run, this handle IS the .webp and must not be deleted.
			const tmpFile = new FileSystem.File(`${params.outputPath}.tmp`)
			const outputFile = new FileSystem.File(params.outputPath)

			try {
				tmpFile.write(new Uint8Array(result.inner.thumbnail.webpData))
				tmpFile.moveSync(outputFile, {
					overwrite: true
				})
			} catch (error) {
				if (tmpFile.exists) {
					try {
						tmpFile.delete()
					} catch {
						// Best-effort cleanup of the partial write; doGenerate also sweeps `<uuid>.webp.tmp` by path
					}
				}

				throw error
			}

			// One breadcrumb per tile evicts the ring on a single grid scroll, so only the embedded-preview
			// case is logged — that one says the SDK served a stored preview instead of a full decode.
			if (result.inner.thumbnail.fromEmbeddedPreview) {
				logger.debug("thumbnails", "sdk thumbnail from embedded preview", {
					uuid: params.uuid,
					width: result.inner.thumbnail.width,
					height: result.inner.thumbnail.height
				})
			}

			return "written"
		}

		case MakeThumbnailInMemoryResult_Tags.Unsupported: {
			logger.debug("thumbnails", "sdk verdict: unsupported", { uuid: params.uuid })

			return "settled"
		}

		case MakeThumbnailInMemoryResult_Tags.OverBudget: {
			logger.debug("thumbnails", "sdk verdict: over budget", { uuid: params.uuid })

			return "settled"
		}

		case MakeThumbnailInMemoryResult_Tags.Corrupt: {
			logger.warn("thumbnails", "sdk verdict: corrupt", { uuid: params.uuid, message: result.inner.message })

			return "settled"
		}
	}
}

// Remote image thumbnails: the SDK decodes from ranged reads of the encrypted file (1 MiB chunks,
// nothing persisted, format decided from magic bytes) and hands back a lossy WebP no larger than the
// request, orientation applied. The caller has already applied both gates (displayability and
// canMakeThumbnail), ruled out local bytes and the offline case, and does NOT hold the JS semaphore:
// the client owns decode concurrency and memory, a parked call holds no buffers, and cancelling
// dequeues it. Authed client only — no thumbnail-bearing screen is reachable logged out.
export async function generateImageViaSdk(params: {
	file: AnyFile
	uuid: string
	outputPath: string
	signal?: AbortSignal
}): Promise<SdkThumbnailOutcome> {
	const { authedSdkClient } = await auth.getSdkClients()

	// The JS AbortSignal is the uniffi cancellation handle itself (this call takes no
	// ManagedFuture): aborting drops the Rust future, which stops the chunk reads at chunk
	// granularity and dequeues a call still parked on the decode gate. The rejection carries
	// name "AbortError" — exempted from the failure count in thumbnails.ts.
	const result = await authedSdkClient.makeThumbnailInMemory(
		{
			file: params.file,
			maxWidth: THUMBNAIL_MAX_WIDTH,
			maxHeight: THUMBNAIL_MAX_HEIGHT,
			lossyQuality: THUMBNAIL_LOSSY_QUALITY
		},
		toSignalOpts(params.signal)
	)

	if (params.signal?.aborted) {
		throw abortError(params.signal)
	}

	return handleThumbnailResult(result, params)
}

// Local image thumbnails: the bytes are already on this device — an offline copy, a file-cache hit, or
// the file the caller just uploaded — so the SDK decodes them in place instead of pulling them back
// through the network. Same decode gate and memory budget as the remote path (the client owns both),
// so this is NOT behind the JS semaphore either. Authed client only, mirroring the remote path.
//
// `localPath` MUST be a DECODED plain filesystem path (normalizeFilePathForSdk), never a
// percent-encoded file:// URI: the SDK opens it verbatim, so a `%20` from any name with a space would
// ENOENT and silently produce no thumbnail. Normalizing here instead of at the call sites is NOT the
// fix — a second decode would turn a file literally named `a%20b.jpg` into `a b.jpg`.
export async function generateImageFromPathViaSdk(params: {
	localPath: string
	uuid: string
	outputPath: string
	signal?: AbortSignal
}): Promise<SdkThumbnailOutcome> {
	const result = await run(async defer => {
		const { authedSdkClient } = await auth.getSdkClients()

		// wrapAbortSignalForSdk allocates TWO uniffi (Rust Arc-backed) handles that nothing GCs. Arm
		// the disposal defer() BEFORE the fallible allocation (its `new ManagedAbortController()` can
		// throw under memory pressure) so an early throw can never bypass it — a missed disposal leaks
		// two handles per file during a camera-upload backfill. null-init, assign once armed.
		let wrappedSignal: ReturnType<typeof wrapAbortSignalForSdk> | null = null

		defer(() => {
			disposeSdkAbortSignal(wrappedSignal)
		})

		wrappedSignal = params.signal ? wrapAbortSignalForSdk(params.signal) : null

		const outcome = await authedSdkClient.makeThumbnailFromPath(
			params.localPath,
			THUMBNAIL_MAX_WIDTH,
			THUMBNAIL_MAX_HEIGHT,
			// A thumbnail extraction is not a user-pausable transfer, so only the abort channel is wired.
			ManagedFuture.new({
				pauseSignal: undefined,
				abortSignal: wrappedSignal ?? undefined
			}),
			// Positional, and it sits BEFORE asyncOpts — passing the signal options here instead would
			// type-check as a quality and silently encode every local thumbnail at some arbitrary level.
			THUMBNAIL_LOSSY_QUALITY,
			toSignalOpts(params.signal)
		)

		// This call carries BOTH cancellation channels (the ManagedFuture and asyncOpts), so an abort
		// races: it surfaces either as the bindings' AbortError or as a FilenSdkError Cancelled,
		// whichever wins. Testing the JS signal FIRST — here and again in thumbnails.ts — makes the
		// flavour irrelevant to the caller's failure ledger.
		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		return handleThumbnailResult(outcome, params)
	})

	if (!result.success) {
		throw result.error
	}

	return result.data
}
