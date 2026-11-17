import * as Comlink from "comlink"
import { Semaphore } from "@filen/shared"
import ThumbRasterWorker from "@/features/drive/workers/thumbRaster.worker.ts?worker"
import type { ThumbRasterWorkerApi } from "@/features/drive/workers/thumbRaster.worker"
import { statelessWorker } from "@/lib/workers/ownedWorker"

// The worker that thumbnails images only the browser decodes, spun up on demand and torn down once it has sat idle;
// sign-out terminates it with every other preview worker. One thumbnail at a time: each holds a whole file and its
// decode.
const THUMB_RASTER_IDLE_MS = 30_000

const worker = statelessWorker<ThumbRasterWorkerApi>(() => new ThumbRasterWorker(), THUMB_RASTER_IDLE_MS, "thumb-raster")
const one = new Semaphore(1)

// A `width`×`height` image of `type` drawn into a thumbnail no larger than `maxDim` a side. `bytes` is transferred.
export async function thumbnailRaster(
	bytes: Uint8Array,
	type: string,
	size: { width: number; height: number },
	maxDim: number
): Promise<Uint8Array> {
	await one.acquire()

	try {
		return await worker.use(({ remote }) =>
			remote.thumbnail(Comlink.transfer(bytes, [bytes.buffer]), type, size.width, size.height, maxDim)
		)
	} finally {
		one.release()
	}
}
