/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { runHeicTransform, productionDeps, type HeicTransformOpts } from "@/features/preview/lib/heicCodec"

// Thin glue only — heicCodec.ts owns every real step (decode, orientation, freeing WASM handles, JPEG
// encode, error normalization). One dedicated worker per tab, spun up lazily by heicTransform.ts on
// the first HEIC/HEIF preview; every call after that reuses this same instance, so heicCodec.ts's own
// decoder memoization (getSharedDecoder) applies across the whole tab session, not just one call.
// opts is undefined for every preview call (heicTransform.ts's default) — only the thumbnail
// generator ever passes maxDimension.
const api = {
	transform: (bytes: Uint8Array, opts?: HeicTransformOpts): Promise<Blob> => runHeicTransform(bytes, productionDeps, opts)
}

export type HeicWorkerApi = typeof api

Comlink.expose(api)
