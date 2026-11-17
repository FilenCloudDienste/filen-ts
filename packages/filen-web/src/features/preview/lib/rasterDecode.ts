import * as Comlink from "comlink"
import RasterDecodeWorker from "@/features/preview/workers/rasterDecode.worker.ts?worker"
import type { RasterDecodeWorkerApi } from "@/features/preview/workers/rasterDecode.worker"
import type { DisplayedRaster } from "@/features/preview/lib/rasterCodecs/display"
import {
	isRasterBudgetError,
	type DecodedRaster,
	type DisplayRasterFormat,
	type RasterFormat
} from "@/features/preview/lib/rasterCodecs/raster"
import { statelessWorker, type WorkerHandle } from "@/lib/workers/ownedWorker"
import type { IdleResource } from "@/lib/idleResource"

// A decoder's wasm memory grows to fit the largest image it has decoded and can never shrink, so each worker is torn
// down once it has sat idle; a later decode spins up a fresh one. Sign-out terminates both at once, busy or idle.
const RASTER_DECODE_IDLE_MS = 30_000

// Two decodes at once: a batch of uploads or a preview stepped through quickly keeps two cores busy,
// while each worker's heap stays bounded by the one image it decodes at a time.
const RASTER_DECODE_WORKERS = 2

type PooledWorker = IdleResource<WorkerHandle<RasterDecodeWorkerApi>>

// Each spun up on demand, not at module load: most sessions never open an image our code decodes, and a lone decode
// only ever wakes the first. A failed spin-up isn't cached, so the next attempt gets a fresh worker.
const decodeWorkers: readonly PooledWorker[] = Array.from({ length: RASTER_DECODE_WORKERS }, (_, i) =>
	statelessWorker<RasterDecodeWorkerApi>(() => new RasterDecodeWorker(), RASTER_DECODE_IDLE_MS, `raster-decode-${String(i + 1)}`)
)
// Workers with no decode posted, the first last so it is the one taken next: a lone decode keeps
// reusing the same worker and the other idles out.
const freeWorkers = decodeWorkers.toReversed()
const waiting: ((worker: PooledWorker) => void)[] = []

// One decode posted per worker. A worker decodes its jobs one by one anyway, and every job queued
// there holds its own copy of the file; waiting here instead lets a caller that went away (a preview
// stepped past) drop out before anything is copied or posted.
function takeWorker(): Promise<PooledWorker> {
	const free = freeWorkers.pop()

	if (free !== undefined) {
		return Promise.resolve(free)
	}

	return new Promise(resolve => {
		waiting.push(resolve)
	})
}

function giveBack(worker: PooledWorker): void {
	const next = waiting.shift()

	if (next !== undefined) {
		next(worker)

		return
	}

	freeWorkers.push(worker)
}

// `fresh`: a failure other than a budget refusal ends the worker, so the next decode gets a fresh one. A wasm decoder
// that ran out of memory aborts its module for good, and every later decode in that worker would fail too.
async function onWorker<T>(
	take: () => Uint8Array,
	signal: AbortSignal | undefined,
	run: (remote: Comlink.Remote<RasterDecodeWorkerApi>, bytes: Uint8Array) => Promise<T>,
	fresh = false
): Promise<T> {
	const worker = await takeWorker()
	// Ended once the call has failed, so the caller gets the decoder's own error rather than the worker's end.
	const broken: { handle: WorkerHandle<RasterDecodeWorkerApi> | null } = { handle: null }

	try {
		signal?.throwIfAborted()

		const bytes = take()

		return await worker.use(handle =>
			run(handle.remote, Comlink.transfer(bytes, [bytes.buffer])).catch((error: unknown) => {
				if (fresh && !isRasterBudgetError(error)) {
					broken.handle = handle
				}

				throw error
			})
		)
	} finally {
		if (broken.handle !== null) {
			worker.invalidate(broken.handle)
		}

		giveBack(worker)
	}
}

async function transferToWorker(take: () => Uint8Array, signal: AbortSignal | undefined): Promise<Blob> {
	return await onWorker(take, signal, (remote, bytes) => remote.transform(bytes))
}

// The one entry point for both HEIC callers — decode + JPEG re-encode run off the main thread in the
// workers above, so a multi-megapixel photo (iPhone default) never blocks the tab. Any failure surfaces
// as a plain rejected Error, which each caller maps to its own outcome.
//
// Not preview-only: imageViewer.tsx (TransformedImageBytes) renders the Blob, and heicUpload.ts wires
// transformHeicBytesOwned below as defaultHeicUploadConvertDeps.transform, where maybeConvertHeicUpload
// turns it into the File that startUploads/runDirectoryUpload actually UPLOAD once the user's
// convert-on-upload preference is on. Changing the encode (quality, format, any downscale) therefore
// changes bytes stored on the user's drive, not just pixels on screen.
//
// The caller's buffer is never detached: a private copy is what crosses to the worker. The preview
// keeps its downloaded bytes in state and hands the SAME Uint8Array to every run of its transform
// effect — StrictMode's double-invoked effect in dev, the Retry button, any later re-run — so
// transferring the caller's own buffer would leave every run after the first posting a detached
// buffer (DataCloneError).
export async function transformHeicBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<Blob> {
	return await transferToWorker(() => bytes.slice(), signal)
}

// For a caller whose buffer is freshly read and never used again: it is transferred as is (and
// detached), sparing a second full copy of the file.
export async function transformHeicBytesOwned(bytes: Uint8Array): Promise<Blob> {
	return await transferToWorker(() => bytes, undefined)
}

// The image editor's HEIC source: full-resolution RGBA (transferred back) and whether it has alpha. A private copy of
// `bytes` crosses, as for transformHeicBytes: the preview's cache keeps its own.
export async function decodeHeicRgba(bytes: Uint8Array, signal?: AbortSignal): Promise<DecodedRaster> {
	return await decodeRasterRgba("heic", bytes, Number.POSITIVE_INFINITY, signal)
}

// What one pixel of each format costs the worker while it is shown: the decoder's frame plus every copy made of it.
// QOI: its RGBA, then the bitmap. JPEG XL: libjxl's wasm heap grows by 61 bytes a pixel decoding (measured with
// @jsquash/jxl 1.3.0 in Node on lossy 3 MP and 12 MP images: 60.9 and 61.2 B/px of linear memory), then the RGBA copied
// out of it and the bitmap.
export const RASTER_BYTES_PER_PIXEL: Readonly<Record<DisplayRasterFormat, number>> = {
	qoi: 8,
	jxl: 70
}

// The whole image as RGBA, decoded off the main thread from a private copy of `bytes`; `maxPixels` refuses a larger
// one before anything is allocated (a HEIC is decoded at any size).
export async function decodeRasterRgba(
	format: RasterFormat,
	bytes: Uint8Array,
	maxPixels: number,
	signal?: AbortSignal
): Promise<DecodedRaster> {
	return await onWorker(
		() => bytes.slice(),
		signal,
		(remote, copy) => remote.decodeRgba(format, copy, maxPixels),
		true
	)
}

// The image as a bitmap to draw, its long side at most `maxLongSide` (null: its own size), decoded off the main thread
// from a private copy of `bytes`. The caller closes the bitmap (or hands it to a canvas).
export async function displayRaster(
	format: DisplayRasterFormat,
	bytes: Uint8Array,
	options: { readonly maxPixels: number; readonly maxLongSide: number | null; readonly signal?: AbortSignal }
): Promise<DisplayedRaster> {
	const shown = await onWorker(
		() => bytes.slice(),
		options.signal,
		(remote, copy) => remote.display(format, copy, options.maxPixels, options.maxLongSide),
		true
	)

	if (options.signal?.aborted === true) {
		shown.bitmap.close()
		options.signal.throwIfAborted()
	}

	return shown
}
