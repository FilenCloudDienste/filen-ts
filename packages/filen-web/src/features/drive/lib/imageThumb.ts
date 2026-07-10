import * as Comlink from "comlink"
import ImageThumbWorker from "@/features/drive/workers/imageThumb.worker.ts?worker"
import type { ImageThumbWorkerApi } from "@/features/drive/workers/imageThumb.worker"

// Spun up on the first image thumbnail request, not at module load — a session that never lists a
// raster image never pays for it. Memoized exactly like heicTransform.ts's own getSharedWorker: a
// failed spin-up isn't cached (the next request gets a fresh worker), and every request after the
// first reuses this one instance, so the whole tab shares a single decode worker rather than churning
// one per thumbnail.
let sharedWorker: Promise<Comlink.Remote<ImageThumbWorkerApi>> | null = null

async function getSharedWorker(): Promise<Comlink.Remote<ImageThumbWorkerApi>> {
	// Worker construction + Comlink.wrap are synchronous — `.then()` (not `async`, which would trip
	// require-await with nothing to await) turns a synchronous throw into a rejection the try/catch
	// below can still evict and retry from.
	sharedWorker ??= Promise.resolve().then(() => Comlink.wrap<ImageThumbWorkerApi>(new ImageThumbWorker()))

	try {
		return await sharedWorker
	} catch (e) {
		sharedWorker = null

		throw e
	}
}

// The one entry point generateImageThumb (thumbGenerators.ts) calls: decode + downscale + encode all
// run off the main thread in the worker above. Rejects (worker-normalized) on any decode/encode
// failure — an unsupported or corrupt image — which the caller maps to a null generation. The source
// bytes are transferred, not cloned: they run megabytes for a real photo and nothing on the main
// thread reads them again after this call.
export async function transformImageThumb(bytes: Uint8Array, maxDim: number): Promise<Uint8Array> {
	const worker = await getSharedWorker()
	// Widens the generic parameter only, mirroring heicTransform.ts: a buffered download's bytes are
	// always a fresh ArrayBuffer, never a SharedArrayBuffer, so this satisfies Comlink's transfer-list
	// shape without changing what backs the value.
	const transferable = bytes as Uint8Array<ArrayBuffer>

	return await worker.generate(Comlink.transfer(transferable, [transferable.buffer]), maxDim)
}
