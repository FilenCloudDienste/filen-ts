import * as Comlink from "comlink"
import HeicWorker from "@/features/preview/workers/heic.worker.ts?worker"
import type { HeicWorkerApi } from "@/features/preview/workers/heic.worker"
import { idleResource } from "@/lib/idleResource"

// libheif's wasm memory grows to fit the largest image it has decoded and can never shrink, so the
// worker is torn down once it has sat idle; a later HEIC spins up a fresh one.
const HEIC_WORKER_IDLE_MS = 30_000

// Spun up on the first HEIC/HEIF transform, not at module load — most sessions never open one. Wrapped
// with Comlink exactly like sdk.worker.ts/db.worker.ts's own workers (client.ts, storage/leader.ts);
// unlike those, this one has no cross-tab role. A failed spin-up isn't cached, so the next attempt gets
// a fresh worker instead of staying broken for the rest of the tab session.
const heicWorker = idleResource(
	() => {
		const worker = new HeicWorker()

		return { worker, remote: Comlink.wrap<HeicWorkerApi>(worker) }
	},
	({ worker, remote }) => {
		remote[Comlink.releaseProxy]()
		worker.terminate()
	},
	HEIC_WORKER_IDLE_MS
)

async function transferToWorker(bytes: Uint8Array): Promise<Blob> {
	return await heicWorker.use(({ remote }) => remote.transform(Comlink.transfer(bytes, [bytes.buffer])))
}

// The one entry point for both HEIC callers — decode + JPEG re-encode run off the main thread in the
// worker above, so a multi-megapixel photo (iPhone default) never blocks the tab. Any failure surfaces
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
export async function transformHeicBytes(bytes: Uint8Array): Promise<Blob> {
	return await transferToWorker(bytes.slice())
}

// For a caller whose buffer is freshly read and never used again: it is transferred as is (and
// detached), sparing a second full copy of the file.
export async function transformHeicBytesOwned(bytes: Uint8Array): Promise<Blob> {
	return await transferToWorker(bytes)
}

// Logout: nothing of the previous session's photos should outlive it in the worker's heap.
export function releaseHeicWorker(): void {
	heicWorker.disposeIfIdle()
}
