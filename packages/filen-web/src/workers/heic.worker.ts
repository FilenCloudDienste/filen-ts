/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { runHeicTransform, productionDeps } from "@/lib/preview/heic-codec"

// Thin glue only — heic-codec.ts owns every real step (decode, orientation, freeing WASM handles, JPEG
// encode, error normalization). One dedicated worker per tab, spun up lazily by heic-transform.ts on
// the first HEIC/HEIF preview; every call after that reuses this same instance, so heic-codec.ts's own
// decoder memoization (getSharedDecoder) applies across the whole tab session, not just one call.
const api = {
	transform: (bytes: Uint8Array): Promise<Blob> => runHeicTransform(bytes, productionDeps)
}

export type HeicWorkerApi = typeof api

Comlink.expose(api)
