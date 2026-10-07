/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { Semaphore } from "@filen/shared"
import { runHeicTransform, productionDeps } from "@/features/preview/lib/heicCodec"

// Thin glue only — heicCodec.ts owns every real step (decode, orientation, freeing WASM handles, JPEG
// encode, error normalization). One of heicTransform.ts's two pooled workers, each spun up lazily;
// every call while it lives reuses this same instance, so heicCodec.ts's own decoder memoization
// (getSharedDecoder) applies across calls.
//
// Comlink runs an async handler per message without waiting for the previous one, and a transform
// yields mid-way (display callback, convertToBlob), so without this lock every queued message would
// start its decode and hold a full RGBA frame plus its share of the wasm heap at the same time.
const transformLock = new Semaphore(1)

const api = {
	transform: async (bytes: Uint8Array): Promise<Blob> => {
		await transformLock.acquire()

		try {
			return await runHeicTransform(bytes, productionDeps)
		} finally {
			transformLock.release()
		}
	}
}

export type HeicWorkerApi = typeof api

Comlink.expose(api)
