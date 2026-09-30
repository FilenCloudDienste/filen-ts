// Leading+trailing throttle. The leading edge invokes immediately so the first call never waits;
// every call inside the window only overwrites a pending buffer, and exactly the LAST one fires at
// the trailing edge — a transfer's final progress notification (100%) must never be the one a
// throttle drops. A call once the window has fully elapsed (nothing pending) starts a fresh cycle.
// flush() delivers a pending call now instead of at the trailing edge.
export type Throttled<Args extends unknown[]> = ((...args: Args) => void) & { flush: () => void }

export function throttle<Args extends unknown[]>(fn: (...args: Args) => void, ms: number): Throttled<Args> {
	let lastInvoked: number | null = null
	let timeoutId: ReturnType<typeof setTimeout> | null = null
	let pendingArgs: Args | null = null

	function invoke(args: Args): void {
		lastInvoked = Date.now()
		fn(...args)
	}

	function flush(): void {
		if (timeoutId !== null) {
			clearTimeout(timeoutId)
			timeoutId = null
		}

		if (pendingArgs !== null) {
			const toSend = pendingArgs
			pendingArgs = null
			invoke(toSend)
		}
	}

	const throttled = (...args: Args) => {
		const now = Date.now()

		if (lastInvoked === null || now - lastInvoked >= ms) {
			if (timeoutId !== null) {
				clearTimeout(timeoutId)
				timeoutId = null
			}
			pendingArgs = null
			invoke(args)
			return
		}

		pendingArgs = args

		if (timeoutId === null) {
			const remaining = ms - (now - lastInvoked)
			timeoutId = setTimeout(() => {
				timeoutId = null
				flush()
			}, remaining)
		}
	}

	return Object.assign(throttled, { flush })
}

// ~10 store updates/sec per transfer is plenty for a progress bar and keeps a many-file batch from
// re-rendering the transfers panel on every chunk (mobile parity).
export const PROGRESS_THROTTLE_MS = 100
