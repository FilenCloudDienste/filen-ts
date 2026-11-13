import * as Comlink from "comlink"
import RemuxWorker from "@/workers/remux.worker.ts?worker"
import type { RemuxWorkerApi } from "@/workers/remux.worker"
import type { EncodeCapabilities } from "@/lib/media/playback/capabilities.logic"
import { idleResource } from "@/lib/idleResource"
import { recoverIfNewerBuild } from "@/lib/appUpdate"

// The demuxer's buffers and the audio codecs' wasm stay allocated for the worker's lifetime, so it is
// torn down once nothing has played through it for a while; a later playback starts a fresh one.
const REMUX_WORKER_IDLE_MS = 30_000

export class RemuxWorkerDiedError extends Error {
	public constructor(cause: string) {
		super(`remux worker is gone (${cause})`)
		this.name = "RemuxWorkerDiedError"
	}
}

interface RemuxWorkerResource {
	worker: Worker
	remote: Comlink.Remote<RemuxWorkerApi>
	// Rejects when the worker dies; calls in flight to it would otherwise never settle.
	dead: Promise<never>
}

const remuxWorker = idleResource<RemuxWorkerResource>(
	() => {
		const worker = new RemuxWorker()
		const remote = Comlink.wrap<RemuxWorkerApi>(worker)
		const died = Promise.withResolvers<never>()
		const resource: RemuxWorkerResource = { worker, remote, dead: died.promise }
		let alive = true
		const die = (cause: string) => {
			if (!alive) {
				return
			}

			alive = false
			died.reject(new RemuxWorkerDiedError(cause))
			remuxWorker.invalidate(resource)
		}

		died.promise.catch(() => undefined)
		worker.addEventListener("error", () => {
			// A deploy that changed this worker removes its old file (appUpdate.ts).
			recoverIfNewerBuild()
			die("error")
		})
		worker.addEventListener("messageerror", () => {
			die("messageerror")
		})

		// A crashed or terminated worker fires nothing; the lock it holds for its life is released then,
		// and this request for it is granted.
		const lock = `filen-remux-life-${crypto.randomUUID()}`

		void remote
			.holdLifeLock(lock)
			.then(() =>
				navigator.locks.request(lock, () => {
					die("terminated")
				})
			)
			.catch(() => undefined)

		return resource
	},
	({ worker, remote }) => {
		remote[Comlink.releaseProxy]()
		worker.terminate()
	},
	REMUX_WORKER_IDLE_MS
)

export interface RemuxWorkerHold {
	remote: Comlink.Remote<RemuxWorkerApi>
	// Rejects with RemuxWorkerDiedError when the worker dies while held.
	dead: Promise<never>
	// The holder is done; the worker idles out once no one holds it.
	release(): void
}

// Keeps the worker alive until release(), for a playback session's whole length.
export function holdRemuxWorker(): Promise<RemuxWorkerHold> {
	return new Promise((resolve, reject) => {
		const released = Promise.withResolvers<undefined>()

		remuxWorker
			.use(async ({ remote, dead }) => {
				resolve({
					remote,
					dead,
					release: () => {
						released.resolve(undefined)
					}
				})
				// A dead worker ends the hold too, so its idle timer and disposal run.
				await Promise.race([released.promise, dead.catch(() => undefined)])
			})
			.catch(reject)
	})
}

// The encoders an export can use, asked in the remux worker (which runs mediabunny's checks); the worker idles out
// after as usual.
export function probeEncodersInWorker(): Promise<EncodeCapabilities> {
	return remuxWorker.use(({ remote, dead }) => Promise.race([remote.encodeCapabilities(), dead]))
}

// Logout: nothing of the previous session's media should outlive it in a worker's heap.
export function releaseRemuxWorker(): void {
	remuxWorker.disposeIfIdle()
}
