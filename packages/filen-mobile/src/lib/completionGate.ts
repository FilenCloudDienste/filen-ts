/**
 * Gate for a transfer's `awaitExternalCompletionBeforeMarkingAsFinished`: the transfer entry
 * (notification/floating bar) stays alive until `open` is called, so callers register
 * `defer(gate.open)` before starting the download to open it on EVERY exit path. `open` is
 * idempotent and `wait` always returns the same promise.
 */
export function createCompletionGate(): { wait: () => Promise<void>; open: () => void } {
	let resolve: (() => void) | undefined

	const promise = new Promise<void>(r => {
		resolve = r
	})

	return {
		wait: () => promise,
		open: () => {
			resolve?.()
		}
	}
}
