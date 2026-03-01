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

export type GenericFnResult =
	| number
	| boolean
	| string
	| object
	| null
	| undefined
	| symbol
	| bigint
	| void
	| Promise<number | boolean | string | object | null | undefined | symbol | bigint | void>
	| Array<number | boolean | string | object | null | undefined | symbol | bigint | void>
export type DeferFn = (fn: () => GenericFnResult) => void
export type DeferredFunction = () => GenericFnResult
export type DeferredFunctions = Array<DeferredFunction>

export type Options = {
	throw?: boolean
	onError?: (err: unknown) => void
}

export async function run<TResult, E = unknown>(
	fn: (deferFn: DeferFn) => Promise<TResult> | TResult,
	options?: Options
): Promise<Result<TResult, E>> {
	const deferredFunctions: DeferredFunctions = []

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
		options?.onError?.(e)

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
			} catch (e) {
				options?.onError?.(e)
			}
		}
	}
}

export type AbortableFn = (
	abortableFn: () => GenericFnResult,
	opts?: {
		signal?: AbortSignal
	}
) => GenericFnResult

export class AbortError extends Error {
	public constructor(message = "Operation aborted") {
		super(message)

		this.name = "AbortError"
	}
}

export function abortSignalReason(signal: AbortSignal): string | undefined {
	try {
		if (signal.reason instanceof Error) {
			return signal.reason.message
		} else if (typeof signal.reason === "string") {
			return signal.reason
		} else if (signal.reason !== undefined) {
			return String(signal.reason)
		}

		return undefined
	} catch {
		return undefined
	}
}

export async function runAbortable<TResult, E = unknown>(
	fn: ({
		abortable,
		defer,
		signal,
		controller
	}: {
		abortable: AbortableFn
		defer: DeferFn
		signal: AbortSignal
		controller: AbortController
	}) => Promise<TResult> | TResult,
	options?: Options & {
		controller?: AbortController
		signal?: AbortSignal
	}
): Promise<Result<TResult, E>> {
	const deferredFunctions: DeferredFunctions = []
	const controller = options?.controller ?? new AbortController()
	const signal = options?.signal ?? options?.controller?.signal ?? controller.signal

	const defer: DeferFn = deferFn => {
		deferredFunctions.push(deferFn)
	}

	const abortable: AbortableFn = async <T>(
		abortableFn: () => Promise<T> | T,
		opts?: {
			signal?: AbortSignal
		}
	): Promise<T> => {
		if (signal.aborted) {
			throw new AbortError(abortSignalReason(signal))
		}

		return await new Promise<T>((resolve, reject) => {
			;(async () => {
				const signal = opts?.signal ?? controller.signal

				const abortHandler = () => {
					reject(new AbortError(abortSignalReason(signal)))
				}

				signal.addEventListener("abort", abortHandler)

				try {
					if (signal.aborted) {
						reject(new AbortError(abortSignalReason(signal)))

						return
					}

					const result = await abortableFn()

					if (signal.aborted) {
						reject(new AbortError(abortSignalReason(signal)))

						return
					}

					resolve(result)
				} catch (e) {
					reject(e)
				} finally {
					signal.removeEventListener("abort", abortHandler)
				}
			})()
		})
	}

	try {
		if (signal.aborted) {
			throw new AbortError(abortSignalReason(signal))
		}

		const result = await fn({
			abortable,
			defer,
			signal,
			controller
		})

		if (signal.aborted) {
			throw new AbortError(abortSignalReason(signal))
		}

		return {
			success: true,
			data: result,
			error: null
		}
	} catch (e) {
		options?.onError?.(e)

		if (options?.throw) {
			throw e
		}

		return {
			success: false,
			data: null,
			error: e as E
		}
	} finally {
		// Needs to be LIFO to properly clean up resources
		for (let i = deferredFunctions.length - 1; i >= 0; i--) {
			try {
				await deferredFunctions[i]?.()
			} catch (e) {
				options?.onError?.(e)
			}
		}
	}
}

export function runEffect<TResult, E = unknown>(
	fn: (deferFn: DeferFn) => TResult,
	options?: Options & {
		automaticCleanup?: boolean
	}
): Result<TResult, E> & {
	cleanup: () => void
} {
	const deferredFunctions: DeferredFunctions = []

	const defer: DeferFn = deferFn => {
		deferredFunctions.push(deferFn)
	}

	const cleanup = () => {
		for (let i = deferredFunctions.length - 1; i >= 0; i--) {
			try {
				deferredFunctions[i]?.()
			} catch (e) {
				options?.onError?.(e)
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
		options?.onError?.(e)

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

export async function runRetry<TResult, E = unknown>(
	fn: (deferFn: DeferFn, attempt: number) => Promise<TResult> | TResult,
	options?: Options & {
		maxAttempts?: number
		delayMs?: number
		backoff?: "linear" | "exponential"
		shouldRetry?: ((err: E, attempt: number) => boolean) | boolean
		onRetry?: (err: E, attempt: number) => void
	}
): Promise<Result<TResult, E>> {
	const maxAttempts = options?.maxAttempts ?? 3
	const delayMs = options?.delayMs ?? 1000
	const backoff = options?.backoff ?? "exponential"
	const runOptions: Options = { onError: options?.onError, throw: false }
	let lastError: E | null = null

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const result = await run<TResult, E>(defer => fn(defer, attempt), runOptions)

		if (result.success) {
			return result
		}

		lastError = result.error

		if (attempt < maxAttempts) {
			const shouldRetry =
				typeof options?.shouldRetry === "boolean"
					? options.shouldRetry
					: options && typeof options.shouldRetry === "function"
						? options.shouldRetry(result.error, attempt)
						: true

			if (!shouldRetry) {
				break
			}

			options?.onRetry?.(result.error, attempt)

			const delay = backoff === "exponential" ? delayMs * Math.pow(2, attempt - 1) : delayMs * attempt

			await new Promise<void>(resolve => setTimeout(resolve, delay))
		}
	}

	return {
		success: false,
		data: null,
		error: lastError as E
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
		options?.onError?.(e)

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

export function runDebounced<TResult, TArgs extends unknown[]>(
	fn: (defer: DeferFn, ...args: TArgs) => Promise<TResult> | TResult,
	delayMs: number,
	options?: Options
): (...args: TArgs) => Promise<Result<TResult, unknown>> {
	let timeoutId: NodeJS.Timeout | null = null
	let pendingResolve: ((value: Result<TResult, unknown>) => void) | null = null
	let pendingPromise: Promise<Result<TResult, unknown>> | null = null
	let executing = false

	return (...args: TArgs) => {
		if (timeoutId) {
			clearTimeout(timeoutId)
		}

		if (!pendingPromise) {
			pendingPromise = new Promise(resolve => {
				pendingResolve = resolve
			})
		}

		timeoutId = setTimeout(async () => {
			if (executing || !pendingResolve) {
				return
			}

			executing = true

			const result = await run(defer => fn(defer, ...args), options)

			executing = false

			if (pendingResolve) {
				pendingResolve(result)
			}

			pendingPromise = null
			pendingResolve = null
			timeoutId = null
		}, delayMs)

		return pendingPromise
	}
}

export type StepFn<T> = (defer: DeferFn, signal: AbortSignal) => Promise<T> | T

export type StepHandle<T> = {
	then: Promise<T>["then"]
	catch: Promise<T>["catch"]
	finally: Promise<T>["finally"]
}

export function createAbortablePipeline(signal?: AbortSignal) {
	const controller = new AbortController()
	const controllerSignal = controller.signal

	if (signal) {
		if (signal.aborted) {
			controller.abort(signal.reason)
		} else {
			signal.addEventListener("abort", () => controller.abort(signal.reason), {
				once: true
			})
		}
	}

	let chain: Promise<void> = Promise.resolve()
	let halted = false

	const step = <T>(fn: StepFn<T>): StepHandle<T> => {
		let resolve: (v: T) => void
		let reject: (e: unknown) => void

		const promise = new Promise<T>((res, rej) => {
			resolve = res
			reject = rej
		})

		chain = chain.then(async (): Promise<void> => {
			if (halted || controllerSignal.aborted) {
				reject(new AbortError(controllerSignal.aborted ? abortSignalReason(controllerSignal) : "Pipeline halted"))

				return
			}

			const stepDeferred: DeferredFunctions = []

			const defer: DeferFn = deferFn => {
				stepDeferred.push(deferFn)
			}

			const runCleanups = async () => {
				for (let i = stepDeferred.length - 1; i >= 0; i--) {
					try {
						await stepDeferred[i]?.()
					} catch {
						// Swallow cleanup errors
					}
				}
			}

			let fnSucceeded = false
			let fnValue: T
			let fnError: unknown

			const fnPromise = (async () => {
				try {
					fnValue = await fn(defer, controllerSignal)
					fnSucceeded = true
				} catch (e) {
					fnError = e
					fnSucceeded = false
				}
			})()

			// If abort was triggered during fn's synchronous execution,
			// let fn complete and use its result
			if (controllerSignal.aborted) {
				await fnPromise
				await runCleanups()

				if (fnSucceeded) {
					resolve(fnValue!)
				} else {
					halted = true

					reject(fnError)
				}

				return
			}

			// Set up abort handler for external aborts while fn is running asynchronously
			try {
				await new Promise<void>((res, rej) => {
					const onAbort = () => {
						rej(new AbortError(abortSignalReason(controllerSignal)))
					}

					controllerSignal.addEventListener("abort", onAbort, {
						once: true
					})

					fnPromise.then(() => {
						controllerSignal.removeEventListener("abort", onAbort)

						res()
					})
				})
			} catch (e) {
				await runCleanups()

				halted = true

				reject(e)

				return
			}

			await runCleanups()

			if (fnSucceeded) {
				resolve(fnValue!)
			} else {
				halted = true

				reject(fnError)
			}
		})

		return {
			then: promise.then.bind(promise),
			catch: promise.catch.bind(promise),
			finally: promise.finally.bind(promise)
		}
	}

	return {
		step,
		signal: controllerSignal
	}
}

export default run
