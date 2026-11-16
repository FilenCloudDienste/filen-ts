import type * as Comlink from "comlink"
import RemuxWorker from "@/workers/remux.worker.ts?worker"
import type { RemuxWorkerApi } from "@/workers/remux.worker"
import type { EncodeCapabilities } from "@/lib/media/playback/capabilities.logic"
import { statelessWorker, type WorkerHandle } from "@/lib/workers/ownedWorker"

// The demuxer's buffers and the audio codecs' wasm stay allocated for the worker's lifetime, so it is
// torn down once nothing has played through it for a while; a later playback starts a fresh one. Sign-out terminates
// it at once, held or not, and with it the decoder workers it runs.
const REMUX_WORKER_IDLE_MS = 30_000

const remuxWorker = statelessWorker<RemuxWorkerApi>(() => new RemuxWorker(), REMUX_WORKER_IDLE_MS, "remux")

const lifeLocked = new WeakSet<Worker>()

// A crashed worker fires nothing; the lock it holds for its life is released then, and this request for it is granted.
// Granted after an ordinary termination too, when the handle is already replaced and invalidating it does nothing.
function watchLife(handle: WorkerHandle<RemuxWorkerApi>): void {
	if (lifeLocked.has(handle.worker)) {
		return
	}

	lifeLocked.add(handle.worker)

	const lock = `filen-remux-life-${crypto.randomUUID()}`

	void handle.remote
		.holdLifeLock(lock)
		.then(() =>
			navigator.locks.request(lock, () => {
				remuxWorker.invalidate(handle)
			})
		)
		.catch(() => undefined)
}

export interface RemuxWorkerHold {
	remote: Comlink.Remote<RemuxWorkerApi>
	// Rejects once the worker is gone while held: WorkerGoneError when it died, an AbortError at sign-out.
	dead: Promise<never>
	// The holder is done; the worker idles out once no one holds it.
	release(): void
}

// Keeps the worker alive until release(), for a playback session's whole length.
export function holdRemuxWorker(): Promise<RemuxWorkerHold> {
	return new Promise((resolve, reject) => {
		const released = Promise.withResolvers<undefined>()

		remuxWorker
			.use(async handle => {
				watchLife(handle)
				resolve({
					remote: handle.remote,
					dead: handle.gone,
					release: () => {
						released.resolve(undefined)
					}
				})
				// A dead worker ends the hold too (the use settles with it), so its idle timer and disposal run.
				await released.promise
			})
			.catch(reject)
	})
}

// The encoders an export can use, asked in the remux worker (which runs mediabunny's checks); the worker idles out
// after as usual.
export function probeEncodersInWorker(): Promise<EncodeCapabilities> {
	return remuxWorker.use(handle => {
		watchLife(handle)

		return handle.remote.encodeCapabilities()
	})
}
