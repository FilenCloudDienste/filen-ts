export interface ScheduleIdleOptions {
	// The longest the run may wait for an idle period (requestIdleCallback's timeout); unbounded when absent.
	readonly timeout?: number
	// Where requestIdleCallback does not exist (Safari before 18.2), the run waits this long instead.
	readonly fallbackMs?: number
}

// Runs `run` once the page is idle; returns the cancel, which does nothing once it ran.
export function scheduleIdle(run: () => void, options: ScheduleIdleOptions = {}): () => void {
	if (typeof requestIdleCallback === "function") {
		const handle = requestIdleCallback(run, options.timeout === undefined ? undefined : { timeout: options.timeout })

		return () => {
			cancelIdleCallback(handle)
		}
	}

	const timer = setTimeout(run, options.fallbackMs ?? 0)

	return () => {
		clearTimeout(timer)
	}
}
