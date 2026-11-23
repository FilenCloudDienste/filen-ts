// A worker call's callback (progress, events) that passes nothing on once its operation settled. Comlink answers a
// proxied callback over the callback's own port, which keeps no order with the call's result: a report posted just
// before the result can arrive after it, and after the caller's cleanup.
export interface SettleGuard<Args extends unknown[]> {
	// Hand this to the worker (wrapped in Comlink.proxy) in place of the callback.
	readonly callback: (...args: Args) => void
	// From here on the callback is ignored. Idempotent.
	readonly settle: () => void
}

// Up to three arguments, passed on as they are: no array is made per call, only a boolean read.
export function settleGuard<F extends (a: never, b: never, c: never) => void>(fn: F): SettleGuard<Parameters<F>> {
	let settled = false
	const callback = (a: never, b: never, c: never): void => {
		if (!settled) {
			fn(a, b, c)
		}
	}

	return {
		callback,
		settle: () => {
			settled = true
		}
	}
}
