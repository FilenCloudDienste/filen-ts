// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

const { mockAlertsError, mockUnwrapSdkError } = vi.hoisted(() => ({
	mockAlertsError: vi.fn(),
	mockUnwrapSdkError: vi.fn().mockReturnValue(null)
}))

vi.mock("uniffi-bindgen-react-native", () => ({
	NativeEventEmitter: vi.fn(),
	UniffiEnum: class {
		protected constructor(..._args: any[]) {}
	}
}))

vi.mock("@/lib/memo", () => ({
	useCallback: (fn: unknown) => fn
}))

vi.mock("@/lib/alerts", () => ({
	default: { error: mockAlertsError }
}))

vi.mock("@/lib/utils", () => ({
	unwrapSdkError: (...args: unknown[]) => mockUnwrapSdkError(...args)
}))

vi.mock("@filen/sdk-rs", () => ({
	ErrorKind: { Unauthenticated: "Unauthenticated" }
}))

import { renderHook, waitFor, act } from "@testing-library/react"
import { useSimpleQuery } from "@/hooks/useSimpleQuery"

beforeEach(() => {
	vi.clearAllMocks()
	mockUnwrapSdkError.mockReturnValue(null)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("useSimpleQuery", () => {
	describe("initial execution", () => {
		it("transitions to success with data", async () => {
			const { result } = renderHook(() =>
				useSimpleQuery(async () => "data")
			)

			await waitFor(() => {
				expect(result.current.status).toBe("success")
			})

			expect(result.current.data).toBe("data")
			expect(result.current.isSuccess).toBe(true)
			expect(result.current.error).toBeNull()
		})

		it("passes the abort signal to the promise", async () => {
			let receivedSignal: AbortSignal | null = null

			const { result } = renderHook(() =>
				useSimpleQuery(async signal => {
					receivedSignal = signal

					return "ok"
				})
			)

			await waitFor(() => {
				expect(result.current.isSuccess).toBe(true)
			})

			expect(receivedSignal).toBeInstanceOf(AbortSignal)
			expect(receivedSignal!.aborted).toBe(false)
		})

		it("does not execute when enabled is false", async () => {
			const fn = vi.fn(async () => "data")

			const { result } = renderHook(() =>
				useSimpleQuery(fn, {
					enabled: false
				})
			)

			await new Promise(r => setTimeout(r, 50))

			expect(fn).not.toHaveBeenCalled()
			expect(result.current.status).toBe("idle")
			expect(result.current.isIdle).toBe(true)
		})
	})

	describe("error handling", () => {
		it("transitions to error after exhausting retries", async () => {
			const error = new Error("fail")
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

			const { result } = renderHook(() =>
				useSimpleQuery(
					async () => {
						throw error
					},
					{
						retry: 0
					}
				)
			)

			await waitFor(() => {
				expect(result.current.status).toBe("error")
			})

			expect(result.current.isError).toBe(true)
			expect(result.current.error).toBe(error)
			expect(result.current.data).toBeNull()
			expect(mockAlertsError).toHaveBeenCalledWith(error)

			consoleError.mockRestore()
		})

		it("retries the specified number of times before failing", async () => {
			vi.useFakeTimers()

			let callCount = 0
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

			renderHook(() =>
				useSimpleQuery(
					async () => {
						callCount++

						throw new Error("fail")
					},
					{
						retry: 2
					}
				)
			)

			await vi.runAllTimersAsync()

			// 1 initial + 2 retries = 3 total
			expect(callCount).toBe(3)

			consoleError.mockRestore()
		})

		it("succeeds on retry after initial failure", async () => {
			vi.useFakeTimers()

			let callCount = 0

			renderHook(() =>
				useSimpleQuery(
					async () => {
						callCount++

						if (callCount < 3) {
							throw new Error("transient")
						}

						return "recovered"
					},
					{
						retry: 5
					}
				)
			)

			await vi.runAllTimersAsync()

			// Stopped retrying after success on attempt 3
			expect(callCount).toBe(3)
			expect(mockAlertsError).not.toHaveBeenCalled()
		})

		it("does not retry on auth errors", async () => {
			let callCount = 0

			mockUnwrapSdkError.mockReturnValue({
				kind: () => "Unauthenticated"
			})

			renderHook(() =>
				useSimpleQuery(
					async () => {
						callCount++

						throw new Error("auth")
					},
					{
						retry: 5
					}
				)
			)

			await waitFor(() => {
				expect(callCount).toBe(1)
			})
		})
	})

	describe("abort", () => {
		it("aborts the signal on unmount", async () => {
			let capturedSignal: AbortSignal | null = null

			const { unmount } = renderHook(() =>
				useSimpleQuery(async signal => {
					capturedSignal = signal

					return "data"
				})
			)

			await waitFor(() => {
				expect(capturedSignal).not.toBeNull()
			})

			expect(capturedSignal!.aborted).toBe(false)

			unmount()

			expect(capturedSignal!.aborted).toBe(true)
		})
	})

	describe("refetch", () => {
		it("re-executes the promise and updates state", async () => {
			let callCount = 0

			const { result } = renderHook(() =>
				useSimpleQuery(async () => {
					callCount++

					return `result-${callCount}`
				})
			)

			await waitFor(() => {
				expect(result.current.isSuccess).toBe(true)
			})

			expect(result.current.data).toBe("result-1")

			await act(async () => {
				result.current.refetch()
			})

			await waitFor(() => {
				expect(result.current.data).toBe("result-2")
			})
		})

		it("aborts the previous execution before restarting", async () => {
			const signals: AbortSignal[] = []

			const { result } = renderHook(() =>
				useSimpleQuery(async signal => {
					signals.push(signal)

					return "data"
				})
			)

			await waitFor(() => {
				expect(result.current.isSuccess).toBe(true)
			})

			const firstSignal = signals[0]!

			await act(async () => {
				result.current.refetch()
			})

			await waitFor(() => {
				expect(signals.length).toBe(2)
			})

			expect(firstSignal.aborted).toBe(true)
			expect(signals[1]!.aborted).toBe(false)
		})
	})
})
