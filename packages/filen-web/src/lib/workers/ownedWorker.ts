import * as Comlink from "comlink"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import { idleResource, type IdleResource } from "@/lib/idleResource"
import { recoverIfNewerBuild } from "@/lib/appUpdate"
import { toErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { registerPreviewDisposer, runPreviewDisposers } from "@/lib/workers/previewDisposers"
import {
	WorkerGoneError,
	workerEndedError,
	ownedWorkerState,
	type OwnedWorkerSession,
	type OwnedWorkerState
} from "@/lib/workers/ownedWorker.logic"

// The preview workers' lifecycles. Every worker started here is registered for sign-out, which terminates it at once,
// busy or idle: nothing of the session outlives it in a worker's heap.

export interface WorkerHandle<Api> {
	readonly worker: Worker
	readonly remote: Comlink.Remote<Api>
	// Rejects once the worker is gone: WorkerGoneError when it broke, an AbortError when it was ended on purpose. A
	// Comlink call to a terminated worker never settles, so a long-lived caller races its calls against this.
	readonly gone: Promise<never>
}

interface StartedWorker<Api> {
	readonly handle: WorkerHandle<Api>
	// A call that rejects with the end reason once the worker is gone instead of hanging. Its waiter is dropped when it
	// settles, so nothing it returned outlives it.
	race<R>(call: () => Promise<R>): Promise<R>
	// Idempotent: unregisters, rejects the calls in flight and `gone` with `reason`, terminates.
	end(reason: Error): void
}

// `stop` is how a break or sign-out reaches the worker's owner, which ends it.
function startWorker<Api>(create: () => Worker, label: string, stop: (reason: Error) => void): StartedWorker<Api> {
	const worker = create()
	const remote = Comlink.wrap<Api>(worker)
	const gone = Promise.withResolvers<never>()
	// The reject of every call in flight. Racing each call against `gone` instead would leave a reaction on it per call,
	// holding that call's result until the worker ends.
	const waiters = new Set<(reason: Error) => void>()
	let endReason: Error | null = null

	gone.promise.catch(() => undefined)

	const unregister = registerPreviewDisposer(label, () => {
		stop(workerEndedError(label, "released at sign-out"))
	})

	worker.addEventListener("error", () => {
		// A deploy that changed this worker removes its old file (appUpdate.ts).
		recoverIfNewerBuild()
		stop(new WorkerGoneError(label, "error"))
	})
	worker.addEventListener("messageerror", () => {
		stop(new WorkerGoneError(label, "messageerror"))
	})

	return {
		handle: { worker, remote, gone: gone.promise },
		race: <R>(call: () => Promise<R>) =>
			new Promise<R>((resolve, reject) => {
				if (endReason !== null) {
					reject(endReason)

					return
				}

				waiters.add(reject)
				void Promise.resolve()
					.then(call)
					.then(resolve, reject)
					.finally(() => {
						waiters.delete(reject)
					})
			}),
		end: reason => {
			if (endReason !== null) {
				return
			}

			endReason = reason
			unregister()

			for (const reject of waiters) {
				reject(reason)
			}

			waiters.clear()
			gone.reject(reason)
			remote[Comlink.releaseProxy]()
			worker.terminate()
		}
	}
}

// A worker holding per-file state or a canvas. Created by the caller, terminated exactly once.
export interface OwnedWorker<Api> extends WorkerHandle<Api> {
	// Settles when the worker breaks (a crash, a deploy that removed its file); never when it is ended on purpose.
	readonly failed: Promise<ErrorDTO>
	// A call that rejects once the worker is gone instead of hanging.
	run<R>(call: (remote: Comlink.Remote<Api>) => Promise<R>): Promise<R>
	// Idempotent; also unregisters from sign-out. Calls in flight reject as cancelled.
	terminate(): void
}

export function createOwnedWorker<Api>(create: () => Worker, label: string): OwnedWorker<Api> {
	const failed = Promise.withResolvers<ErrorDTO>()
	const started: StartedWorker<Api> = startWorker<Api>(create, label, reason => {
		if (reason instanceof WorkerGoneError) {
			failed.resolve(toErrorDTO(reason))
		}

		started.end(reason)
	})
	const { handle } = started

	return {
		...handle,
		failed: failed.promise,
		run: call => started.race(() => call(handle.remote)),
		terminate: () => {
			started.end(workerEndedError(label, "ended by its owner"))
		}
	}
}

// Created in an effect and terminated in its cleanup, so StrictMode's dev double-run creates, terminates and recreates.
// A new `key` (a new file) restarts it, as does `restart()` after a failure. `create` is read when the worker starts.
export function useOwnedWorker<Api>(create: () => Worker, key: string, label: string): OwnedWorkerState<OwnedWorker<Api>> {
	const [attempt, setAttempt] = useState(0)
	const [session, setSession] = useState<OwnedWorkerSession<OwnedWorker<Api>> | null>(null)
	const generations = useRef(0)
	const start = useEffectEvent(() => createOwnedWorker<Api>(create, label))

	useEffect(() => {
		const owned = start()
		const generation = ++generations.current
		let live = true

		// Published after the commit; until then ownedWorkerState reports "starting" for the new key, never the
		// terminated worker of the old one.
		queueMicrotask(() => {
			if (live) {
				setSession({ key, attempt, generation, owned, failure: null })
			}
		})
		void owned.failed.then(dto => {
			if (live) {
				setSession({ key, attempt, generation, owned, failure: dto })
			}
		})

		return () => {
			live = false
			owned.terminate()
		}
	}, [key, attempt])

	return ownedWorkerState(session, key, attempt, () => {
		setAttempt(previous => previous + 1)
	})
}

// Stateless request/response workers: idle out after `idleMs` with no call in flight, are terminated at sign-out even
// while busy (calls in flight reject as cancelled), and a later call starts a fresh one. Each pool member is its own
// instance with its own label. A call rejects once its worker is gone rather than hanging.
export function statelessWorker<Api>(create: () => Worker, idleMs: number, label: string): IdleResource<WorkerHandle<Api>> {
	const started = new WeakMap<WorkerHandle<Api>, StartedWorker<Api>>()
	const endings = new WeakMap<StartedWorker<Api>, Error>()
	const stop = (worker: StartedWorker<Api>, reason: Error) => {
		endings.set(worker, reason)
		pool.invalidate(worker)
	}
	const pool: IdleResource<StartedWorker<Api>> = idleResource(
		() => {
			const worker: StartedWorker<Api> = startWorker<Api>(create, label, reason => {
				stop(worker, reason)
			})

			started.set(worker.handle, worker)

			return worker
		},
		worker => {
			worker.end(endings.get(worker) ?? workerEndedError(label, "idle"))
		},
		idleMs
	)

	return {
		use: run => pool.use(worker => worker.race(() => run(worker.handle))),
		disposeIfIdle: () => {
			pool.disposeIfIdle()
		},
		invalidate: handle => {
			const worker = started.get(handle)

			if (worker !== undefined) {
				stop(worker, new WorkerGoneError(label, "terminated"))
			}
		}
	}
}

// Sign-out: runs every registered preview disposer, which terminates every preview worker at once, owned and stateless,
// busy or idle.
export function releaseAllPreviewWorkers(): void {
	runPreviewDisposers()
}
