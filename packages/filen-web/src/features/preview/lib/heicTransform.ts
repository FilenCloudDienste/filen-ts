import * as Comlink from "comlink"
import HeicWorker from "@/features/preview/workers/heic.worker.ts?worker"
import type { HeicWorkerApi } from "@/features/preview/workers/heic.worker"

// Spun up on the first HEIC/HEIF preview, not at module load — most sessions never open one. Wrapped
// with Comlink exactly like sdk.worker.ts/db.worker.ts's own workers (client.ts, storage/leader.ts);
// unlike those, this one has no cross-tab role, so it's just created lazily and memoized the same way
// heicCodec.ts memoizes its own decoder (getSharedDecoder): a failed spin-up isn't cached, so the next
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

// The one entry point for both HEIC callers — decode + JPEG re-encode run off the main thread in the
// worker above, so a multi-megapixel photo (iPhone default) never blocks the tab. Any failure surfaces
// as a plain rejected Error, which each caller maps to its own outcome.
//
// Not preview-only: imageViewer.tsx (TransformedImageBytes) renders the Blob, and heicUpload.ts wires
// this as defaultHeicUploadConvertDeps.transform, where maybeConvertHeicUpload turns it into the File
// that startUploads/runDirectoryUpload actually UPLOAD once the user's convert-on-upload preference is
// on. Changing the encode (quality, format, any downscale) therefore changes bytes stored on the user's
// drive, not just pixels on screen.
//
// The caller's buffer is never detached: a private copy is what crosses to the worker. The preview
// keeps its downloaded bytes in state and hands the SAME Uint8Array to every run of its transform
// effect — StrictMode's double-invoked effect in dev, the Retry button, any later re-run — so
// transferring the caller's own buffer would leave every run after the first posting a detached
// buffer (DataCloneError).
export async function transformHeicBytes(bytes: Uint8Array): Promise<Blob> {
	const worker = await getSharedWorker()
	const copy = bytes.slice()

	return await worker.transform(Comlink.transfer(copy, [copy.buffer]))
}
