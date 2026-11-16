// Runs `callback` once `signal` aborts, at once when it already has (an abort listener added then would
// never fire). Returns the unsubscribe; a no-op without a signal.
export function onAbort(signal: AbortSignal | undefined, callback: () => void): () => void {
	if (signal === undefined) {
		return () => undefined
	}

	if (signal.aborted) {
		callback()

		return () => undefined
	}

	signal.addEventListener("abort", callback, { once: true })

	return () => {
		signal.removeEventListener("abort", callback)
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError")
}

// Settles with `promise`, or rejects with the signal's reason once `signal` aborts first. The work behind `promise` goes
// on for whoever else waits on it (a shared download, a memoised block).
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) {
		return promise
	}

	if (signal.aborted) {
		return Promise.reject(abortReason(signal))
	}

	return new Promise<T>((resolve, reject) => {
		const unsubscribe = onAbort(signal, () => {
			reject(abortReason(signal))
		})

		promise.then(
			value => {
				unsubscribe()
				resolve(value)
			},
			(error: unknown) => {
				unsubscribe()
				reject(error instanceof Error ? error : new Error(String(error)))
			}
		)
	})
}
