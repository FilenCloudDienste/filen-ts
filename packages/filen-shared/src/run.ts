export type Success<T> = {
	success: true
	data: T
	error: null
}

export type Failure<E = unknown> = {
	success: false
	data: null
	error: E
}

export type Result<T, E = unknown> = Success<T> | Failure<E>

export type DeferFn = (fn: () => unknown) => void

export type Options = {
	throw?: boolean
}

export async function run<TResult, E = unknown>(
	fn: (deferFn: DeferFn) => Promise<TResult> | TResult,
	options?: Options
): Promise<Result<TResult, E>> {
	const deferredFunctions: Array<() => unknown> = []

	const defer: DeferFn = deferFn => {
		deferredFunctions.push(deferFn)
	}

	try {
		const result = await fn(defer)

		return {
			success: true,
			data: result,
			error: null
		}
	} catch (e) {
		if (options?.throw) {
			throw e
		}

		return {
			success: false,
			data: null,
			error: e as E
		}
	} finally {
		// Needs to be LIFO to properly clean up resources and not interfere with each other and cause race conditions
		for (let i = deferredFunctions.length - 1; i >= 0; i--) {
			try {
				await deferredFunctions[i]?.()
			} catch {
				// A failing deferred fn must not stop the others.
			}
		}
	}
}

// run() that resolves the bare data and rethrows after the deferred cleanups, so callers skip the Result narrowing.
export async function runOrThrow<TResult>(fn: (deferFn: DeferFn) => Promise<TResult> | TResult): Promise<TResult> {
	const result = await run<TResult>(fn)

	if (!result.success) {
		throw result.error
	}

	return result.data
}

export function runEffect<TResult, E = unknown>(
	fn: (deferFn: DeferFn) => TResult,
	options?: Options & {
		automaticCleanup?: boolean
	}
): Result<TResult, E> & {
	cleanup: () => void
} {
	const deferredFunctions: Array<() => unknown> = []

	const defer: DeferFn = deferFn => {
		deferredFunctions.push(deferFn)
	}

	const cleanup = () => {
		for (let i = deferredFunctions.length - 1; i >= 0; i--) {
			try {
				deferredFunctions[i]?.()
			} catch {
				// A failing deferred fn must not stop the others.
			}
		}
	}

	try {
		const result = fn(defer)

		return {
			success: true,
			data: result,
			error: null,
			cleanup
		}
	} catch (e) {
		if (options?.throw) {
			throw e
		}

		return {
			success: false,
			data: null,
			error: e as E,
			cleanup
		}
	} finally {
		if (options?.automaticCleanup) {
			cleanup()
		}
	}
}

export class TimeoutError extends Error {
	public constructor(message = "Operation timed out") {
		super(message)

		this.name = "TimeoutError"
	}
}

export async function runTimeout<TResult, E = unknown>(
	fn: (deferFn: DeferFn) => Promise<TResult> | TResult,
	timeoutMs: number,
	options?: Options
): Promise<Result<TResult, E>> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null

	try {
		const result = await Promise.race([
			run(fn, options),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					timeoutId = null

					reject(new TimeoutError(`Operation timed out after ${timeoutMs}ms`))
				}, timeoutMs)
			})
		])

		return result as Result<TResult, E>
	} catch (e) {
		if (options?.throw) {
			throw e
		}

		return {
			success: false,
			data: null,
			error: e as E
		}
	} finally {
		if (timeoutId !== null) {
			clearTimeout(timeoutId)
		}
	}
}
