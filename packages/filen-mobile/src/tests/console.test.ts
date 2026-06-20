import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest"

const loggerMock = vi.hoisted(() => ({
	captureConsole: vi.fn()
}))

const sdkErrorsMock = vi.hoisted(() => ({
	unwrapSdkError: vi.fn((_arg?: unknown): unknown => null)
}))

vi.mock("@/lib/logger", () => ({ default: loggerMock }))
vi.mock("@/lib/sdkErrors", () => sdkErrorsMock)

type TestGlobal = typeof globalThis & { __DEV__?: boolean }

describe("console tee (polyfills/console)", () => {
	const g = globalThis as TestGlobal

	// Captured during collection, BEFORE beforeAll imports the module and mutates global.console.
	const native = {
		log: console.log,
		info: console.info,
		debug: console.debug,
		trace: console.trace,
		warn: console.warn,
		error: console.error
	}

	let savedDev: boolean | undefined

	beforeAll(async () => {
		savedDev = g.__DEV__

		// Side effect: installs the tee onto global.console in place.
		await import("@/lib/polyfills/console")
	})

	afterAll(() => {
		// Restore so the tee doesn't leak into the runner / other suites.
		console.log = native.log
		console.info = native.info
		console.debug = native.debug
		console.trace = native.trace
		console.warn = native.warn
		console.error = native.error
		g.__DEV__ = savedDev
	})

	beforeEach(() => {
		loggerMock.captureConsole.mockClear()
		sdkErrorsMock.unwrapSdkError.mockReset().mockReturnValue(null)
		// Prod-like: no native forwarding, pure tee (so we don't spam the test runner either).
		g.__DEV__ = false
	})

	it("tees console.error into the logger at error level", () => {
		console.error("boom", { a: 1 })

		expect(loggerMock.captureConsole).toHaveBeenCalledTimes(1)

		const call = loggerMock.captureConsole.mock.calls[0]!

		expect(call[0]).toBe("error")
		expect((call[1] as unknown[])[0]).toBe("boom")
	})

	it("maps console levels to logger levels (log/debug→debug, info→info, warn→warn)", () => {
		console.log("a")
		console.info("b")
		console.debug("c")
		console.warn("d")

		expect(loggerMock.captureConsole.mock.calls.map(c => c[0])).toEqual(["debug", "info", "debug", "warn"])
	})

	it("passes args to the logger RAW — SDK-error normalization happens in the logger freeze, not the tee", () => {
		// The tee used to rewrite SDK-error args into { sdkKind, sdkMessage } here. That moved into the
		// logger's enqueue-time freeze (one path for both direct logger.* and console.* — see
		// logger.test / logRedaction.test), so the tee now forwards the raw values untouched.
		const sdkError = { kind: () => "Io", message: () => "disk full" }

		console.error("context", sdkError)

		const args = loggerMock.captureConsole.mock.calls[0]![1] as unknown[]

		expect(args[0]).toBe("context")
		expect(args[1]).toBe(sdkError)
	})

	it("never throws and always tees (the prod tee does no SDK probing of its own)", () => {
		expect(() => console.error("plain", { a: 1 })).not.toThrow()

		expect(loggerMock.captureConsole).toHaveBeenCalledTimes(1)
		expect(loggerMock.captureConsole.mock.calls[0]![0]).toBe("error")
	})

	it("preserves non-leveled console methods (mutated in place, not spread-replaced)", () => {
		// group/table/assert etc. are not overridden and must still be callable.
		expect(typeof console.group).toBe("function")
		expect(typeof console.table).toBe("function")
		expect(typeof console.assert).toBe("function")
	})
})
