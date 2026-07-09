import * as Comlink from "comlink"
import HeicWorker from "@/features/preview/workers/heic.worker.ts?worker"
import type { HeicWorkerApi } from "@/features/preview/workers/heic.worker"
import type { HeicTransformOpts } from "@/lib/preview/heic-codec"

// Spun up on the first HEIC/HEIF preview, not at module load — most sessions never open one. Wrapped
// with Comlink exactly like sdk.worker.ts/db.worker.ts's own workers (client.ts, storage/leader.ts);
// unlike those, this one has no cross-tab role, so it's just created lazily and memoized the same way
// heic-codec.ts memoizes its own decoder (getSharedDecoder): a failed spin-up isn't cached, so the next
// preview attempt gets a fresh worker instead of staying broken for the rest of the tab session.
let sharedWorker: Promise<Comlink.Remote<HeicWorkerApi>> | null = null

async function getSharedWorker(): Promise<Comlink.Remote<HeicWorkerApi>> {
	// Worker construction + Comlink.wrap are both synchronous — `.then()` (not `async`, which would trip
	// require-await with nothing to actually await) is what turns a synchronous throw into a rejection
	// this function's own try/catch below can still evict and retry from.
	sharedWorker ??= Promise.resolve().then(() => Comlink.wrap<HeicWorkerApi>(new HeicWorker()))

	try {
		return await sharedWorker
	} catch (e) {
		sharedWorker = null

		throw e
	}
}

// The one entry point image-viewer.tsx calls (TransformedImageBytes) — decode + JPEG re-encode both run
// off the main thread in the worker above, so a multi-megapixel photo (iPhone default) never blocks the
// tab. Signature and error behavior are unchanged from before this moved worker-side: any failure still
// surfaces as a plain rejected Error, which the caller maps to one labeled error state regardless of
// content. `opts` is omitted by image-viewer.tsx (every preview call) — only the thumbnail generator
// (thumb-generators.ts) passes `{maxDimension}` to request the downscaled, webp-first encode instead.
export async function transformHeicBytes(bytes: Uint8Array, opts?: HeicTransformOpts): Promise<Blob> {
	const worker = await getSharedWorker()
	// Narrowed the same way image-viewer.tsx's BufferedImageBytes narrows a worker-sourced Uint8Array:
	// this buffer is always a fresh ArrayBuffer allocation (usePreviewBytes's buffered download), never a
	// SharedArrayBuffer, so the cast only widens the generic parameter Comlink's transfer list requires —
	// it doesn't change what's actually backing the value. Transferred, not cloned: HEIC originals run
	// multi-megabyte, and nothing on the main thread reads these bytes again after this call.
	const transferable = bytes as Uint8Array<ArrayBuffer>

	return await worker.transform(Comlink.transfer(transferable, [transferable.buffer]), opts)
}
