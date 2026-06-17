import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const loggerMock = vi.hoisted(() => ({
	error: vi.fn(),
	flushNow: vi.fn(),
	warn: vi.fn(),
	info: vi.fn(),
	debug: vi.fn()
}))

vi.mock("@/lib/logger", () => ({
	default: loggerMock
}))

import { installGlobalErrorHandlers } from "@/lib/errorHandlers"

type TestGlobal = typeof globalThis & {
	ErrorUtils?: unknown
	HermesInternal?: unknown
	__DEV__?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (error: unknown, isFatal?: boolean) => void

describe("errorHandlers", () => {
	const g = globalThis as TestGlobal
	let savedErrorUtils: unknown
	let savedHermes: unknown
	let savedDev: boolean | undefined

	beforeEach(() => {
		loggerMock.error.mockClear()
		loggerMock.flushNow.mockClear()
		savedErrorUtils = g.ErrorUtils
		savedHermes = g.HermesInternal
		savedDev = g.__DEV__
	})

	afterEach(() => {
		g.ErrorUtils = savedErrorUtils
		g.HermesInternal = savedHermes
		g.__DEV__ = savedDev
		vi.restoreAllMocks()
	})

	it("logs + flushes a fatal uncaught error and chains the previous handler", () => {
		const previous = vi.fn()
		let captured: Handler | undefined

		g.ErrorUtils = {
			getGlobalHandler: () => previous,
			setGlobalHandler: (handler: Handler) => {
				captured = handler
			}
		}
		g.HermesInternal = undefined
		g.__DEV__ = true

		installGlobalErrorHandlers()

		expect(captured).toBeDefined()

		const err = new Error("boom")

		captured?.(err, true)

		expect(loggerMock.error).toHaveBeenCalledWith("uncaught", "Fatal uncaught error", expect.objectContaining({ isFatal: true }))
		expect(loggerMock.flushNow).toHaveBeenCalled()
		expect(previous).toHaveBeenCalledWith(err, true)
	})

	it("labels a non-fatal uncaught error and survives the absence of a previous handler", () => {
		let captured: Handler | undefined

		g.ErrorUtils = {
			getGlobalHandler: () => undefined,
			setGlobalHandler: (handler: Handler) => {
				captured = handler
			}
		}
		g.HermesInternal = undefined
		g.__DEV__ = true

		installGlobalErrorHandlers()

		expect(() => captured?.(new Error("x"), false)).not.toThrow()
		expect(loggerMock.error).toHaveBeenCalledWith("uncaught", "Uncaught error", expect.objectContaining({ isFatal: false }))
	})

	it("enables the Hermes rejection tracker in production and logs unhandled rejections", () => {
		let options: { allRejections: boolean; onUnhandled: (id: number, rejection?: unknown) => void } | undefined

		g.ErrorUtils = undefined
		g.HermesInternal = {
			hasPromise: () => true,
			enablePromiseRejectionTracker: (o: typeof options) => {
				options = o
			}
		}
		g.__DEV__ = false

		installGlobalErrorHandlers()

		expect(options).toBeDefined()
		expect(options?.allRejections).toBe(true)

		options?.onUnhandled(7, new Error("late"))

		expect(loggerMock.error).toHaveBeenCalledWith(
			"unhandledRejection",
			"Unhandled promise rejection",
			expect.objectContaining({ id: 7 })
		)
	})

	it("does NOT enable its own rejection tracker in dev (leaves RN's intact)", () => {
		const enable = vi.fn()

		g.ErrorUtils = undefined
		g.HermesInternal = {
			hasPromise: () => true,
			enablePromiseRejectionTracker: enable
		}
		g.__DEV__ = true

		installGlobalErrorHandlers()

		expect(enable).not.toHaveBeenCalled()
	})
})
