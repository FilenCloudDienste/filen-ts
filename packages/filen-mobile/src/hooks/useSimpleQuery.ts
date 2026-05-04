import { useState, useRef, useCallback, useEffect } from "react"
import useEffectOnce from "@/hooks/useEffectOnce"
import alerts from "@/lib/alerts"
import { unwrapSdkError } from "@/lib/utils"
import { ErrorKind } from "@filen/sdk-rs"

const DEFAULT_RETRY_COUNT = 5
const MAX_RETRY_DELAY = 30000

function retryDelay(attempt: number): number {
	return Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY)
}

function waitForRetry(attempt: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>(resolve => {
		const timeout = setTimeout(resolve, retryDelay(attempt))

		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout)

				resolve()
			},
			{
				once: true
			}
		)
	})
}

export type QueryState<T> =
	| {
			status: "idle"
			data: null
			error: null
	  }
	| {
			status: "loading"
			data: null
			error: null
	  }
	| {
			status: "success"
			data: T
			error: null
	  }
	| {
			status: "error"
			data: null
			error: unknown
	  }

export function useSimpleQuery<T>(
	promise: (signal: AbortSignal) => Promise<T>,
	options?: {
		enabled?: boolean
		retry?: number
	}
) {
	const abortControllerRef = useRef<AbortController>(new AbortController())
	const [state, setState] = useState<QueryState<T>>({
		status: "idle",
		data: null,
		error: null
	})

	const promiseRef = useRef(promise)
	const optionsRef = useRef(options)

	useEffect(() => {
		promiseRef.current = promise
		optionsRef.current = options
	}, [promise, options])

	const execute = useCallback(async () => {
		setState({
			status: "loading",
			data: null,
			error: null
		})

		const maxRetries = optionsRef.current?.retry ?? DEFAULT_RETRY_COUNT
		let lastError: unknown = null

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (abortControllerRef.current.signal.aborted) {
				return
			}

			try {
				const data = await promiseRef.current(abortControllerRef.current.signal)

				setState({
					status: "success",
					data,
					error: null
				})

				return
			} catch (e) {
				lastError = e

				if (abortControllerRef.current.signal.aborted) {
					return
				}

				console.error(e)

				const unwrappedSdkError = unwrapSdkError(e)

				if (unwrappedSdkError && unwrappedSdkError.kind() === ErrorKind.Unauthenticated) {
					// TODO: Logout on auth errors

					return
				}

				if (attempt < maxRetries) {
					await waitForRetry(attempt, abortControllerRef.current.signal)

					continue
				}
			}
		}

		if (abortControllerRef.current.signal.aborted) {
			return
		}

		console.error(lastError)
		alerts.error(lastError)

		setState({
			status: "error",
			data: null,
			error: lastError
		})
	}, [])

	const refetch = useCallback(() => {
		abortControllerRef.current.abort()
		abortControllerRef.current = new AbortController()

		execute()
	}, [execute])

	useEffectOnce(() => {
		if (options?.enabled ?? true) {
			execute()
		}

		return () => {
			abortControllerRef.current.abort()
		}
	})

	return {
		...state,
		isIdle: state.status === "idle",
		isLoading: state.status === "loading",
		isSuccess: state.status === "success",
		isError: state.status === "error",
		refetch
	}
}

export default useSimpleQuery
