import type { CacheStatusListener, CacheStatusMessage } from "@filen/sdk-rs"

export interface Convergence extends CacheStatusListener {
	isConverged(root: string): boolean
	// true once the cache converged on `root`; false on timeout, abort, or the root deleted on the server.
	awaitConverged(root: string, timeoutMs: number, signal: AbortSignal): Promise<boolean>
}

// Which remote roots the cache has converged on, from its status messages. Resyncs run one at a time, so a Finished
// belongs to the Started before it. Delivery is best-effort: every message is read as a snapshot.
export function createConvergence(): Convergence {
	const converged = new Set<string>()
	let resyncing: readonly string[] = []
	const waiters = new Map<string, Set<(converged: boolean) => void>>()

	function settle(root: string, value: boolean): void {
		const pending = waiters.get(root)

		if (pending !== undefined) {
			waiters.delete(root)

			for (const resolve of pending) {
				resolve(value)
			}
		}
	}

	function apply(message: CacheStatusMessage): void {
		if (message.tag === "SyncRootsDeleted") {
			for (const root of message.inner.roots) {
				converged.delete(root)
				settle(root, false)
			}

			return
		}

		if (message.tag !== "ResyncProgress") {
			return
		}

		const { progress } = message.inner

		if (progress.tag === "Started") {
			resyncing = progress.inner.roots
		} else if (progress.tag === "Finished") {
			for (const root of resyncing) {
				if (progress.inner.converged) {
					converged.add(root)
					settle(root, true)
				} else {
					converged.delete(root)
				}
			}

			resyncing = []
		}
	}

	return {
		onMessages: messages => {
			for (const message of messages) {
				apply(message)
			}
		},
		isConverged: root => converged.has(root),
		awaitConverged: (root, timeoutMs, signal) => {
			if (converged.has(root)) {
				return Promise.resolve(true)
			}

			if (signal.aborted) {
				return Promise.resolve(false)
			}

			return new Promise(resolve => {
				let pending = waiters.get(root)

				if (pending === undefined) {
					pending = new Set()
					waiters.set(root, pending)
				}

				const done = (value: boolean) => {
					clearTimeout(timer)
					signal.removeEventListener("abort", aborted)
					resolve(value)
				}
				const aborted = () => {
					const current = waiters.get(root)

					current?.delete(done)

					if (current?.size === 0) {
						waiters.delete(root)
					}

					done(false)
				}
				const timer = setTimeout(aborted, timeoutMs)

				pending.add(done)
				signal.addEventListener("abort", aborted, { once: true })
			})
		}
	}
}
