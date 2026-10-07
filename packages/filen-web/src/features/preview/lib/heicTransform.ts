import * as Comlink from "comlink"
import HeicWorker from "@/features/preview/workers/heic.worker.ts?worker"
import type { HeicWorkerApi } from "@/features/preview/workers/heic.worker"
import { idleResource } from "@/lib/idleResource"
import { recoverIfNewerBuild } from "@/lib/appUpdate"

// libheif's wasm memory grows to fit the largest image it has decoded and can never shrink, so each
// worker is torn down once it has sat idle; a later HEIC spins up a fresh one.
const HEIC_WORKER_IDLE_MS = 30_000

// Two decodes at once: a batch of uploads or a preview stepped through quickly keeps two cores busy,
// while each worker's heap stays bounded by the one image it decodes at a time.
const HEIC_WORKERS = 2

// Each spun up on demand, not at module load — most sessions never open a HEIC, and a lone transform only
// ever wakes the first. Wrapped with Comlink exactly like sdk.worker.ts/db.worker.ts's own workers
// (client.ts, storage/leader.ts); unlike those, these have no cross-tab role. A failed spin-up isn't
// cached, so the next attempt gets a fresh worker instead of staying broken for the rest of the tab
// session.
function pooledWorker() {
	return idleResource(
		() => {
			const worker = new HeicWorker()
			// A deploy that changed this worker removes its old file (appUpdate.ts).
			worker.addEventListener("error", () => {
				recoverIfNewerBuild()
			})

			return { worker, remote: Comlink.wrap<HeicWorkerApi>(worker) }
		},
		({ worker, remote }) => {
			remote[Comlink.releaseProxy]()
			worker.terminate()
		},
		HEIC_WORKER_IDLE_MS
	)
}

type PooledWorker = ReturnType<typeof pooledWorker>

const heicWorkers = Array.from({ length: HEIC_WORKERS }, pooledWorker)
// Workers with no transform posted, the first last so it is the one taken next: a lone transform keeps
// reusing the same worker and the other idles out.
const freeWorkers = heicWorkers.toReversed()
const waiting: ((heic: PooledWorker) => void)[] = []

// One transform posted per worker. A worker decodes its jobs one by one anyway, and every job queued
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

function giveBack(heic: PooledWorker): void {
	const next = waiting.shift()

	if (next !== undefined) {
		next(heic)

		return
	}

	freeWorkers.push(heic)
}

async function transferToWorker(take: () => Uint8Array, signal: AbortSignal | undefined): Promise<Blob> {
	const heic = await takeWorker()

	try {
		signal?.throwIfAborted()

		const bytes = take()

		return await heic.use(({ remote }) => remote.transform(Comlink.transfer(bytes, [bytes.buffer])))
	} finally {
		giveBack(heic)
	}
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

// Logout: nothing of the previous session's photos should outlive it in a worker's heap.
export function releaseHeicWorker(): void {
	for (const heic of heicWorkers) {
		heic.disposeIfIdle()
	}
}
