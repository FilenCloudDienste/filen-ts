import { useState, useRef } from "react"
import useEffectOnce from "@/hooks/useEffectOnce"
import { useCallback } from "@/lib/memo"
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

	const execute = useCallback(async () => {
		setState({
			status: "loading",
			data: null,
			error: null
		})

		const maxRetries = options?.retry ?? DEFAULT_RETRY_COUNT
		let lastError: unknown = null

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (abortControllerRef.current.signal.aborted) {
				return
			}

			try {
				const data = await promise(abortControllerRef.current.signal)

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

		console.error(lastError)
		alerts.error(lastError)

		setState({
			status: "error",
			data: null,
			error: lastError
		})
	}, [promise, options?.retry])

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
