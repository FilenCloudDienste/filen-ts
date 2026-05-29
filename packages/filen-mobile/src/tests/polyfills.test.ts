import { vi, describe, it, expect, afterEach } from "vitest"

describe("DOMException polyfill", () => {
	let savedDOMException: typeof globalThis.DOMException | undefined

	async function loadPolyfill() {
		savedDOMException = global.DOMException
		// @ts-expect-error remove native DOMException to force polyfill installation
		delete global.DOMException
		vi.resetModules()
		await import("@/lib/polyfills/DOMException")
	}

	afterEach(() => {
		if (savedDOMException !== undefined) {
			global.DOMException = savedDOMException
		}
	})

	it("installs DOMException on global when not present", async () => {
		await loadPolyfill()

		expect(typeof global.DOMException).toBe("function")
	})

	it("does not overwrite a pre-existing global DOMException", async () => {
		const original = global.DOMException

		vi.resetModules()
		await import("@/lib/polyfills/DOMException")

		expect(global.DOMException).toBe(original)
	})

	it("stores message and name", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("test message", "AbortError")

		expect(ex.message).toBe("test message")
		expect(ex.name).toBe("AbortError")
	})

	it("defaults name to 'Error' and code to 0 when no name is given", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("msg")

		expect(ex.name).toBe("Error")
		expect(ex.code).toBe(0)
	})

	it("code getter returns legacy code for AbortError (20)", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("aborted", "AbortError")

		expect(ex.code).toBe(20)
	})

	it("code getter returns 0 for an unknown name", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("msg", "UnknownError")

		expect(ex.code).toBe(0)
	})

	it("code getter is live — changing name changes code", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("msg", "UnknownError")
		const mutableEx = ex as { name: string }

		expect(ex.code).toBe(0)

		mutableEx.name = "AbortError"

		expect(ex.code).toBe(20)
	})

	it("is instanceof Error", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("msg", "AbortError")

		expect(ex instanceof Error).toBe(true)
	})

	it("Symbol.toStringTag returns 'DOMException'", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("msg")

		expect((ex as unknown as Record<symbol, unknown>)[Symbol.toStringTag]).toBe("DOMException")
	})

	it("ABORT_ERR constant (20) is present on the constructor", async () => {
		await loadPolyfill()

		expect((global.DOMException as unknown as Record<string, unknown>)["ABORT_ERR"]).toBe(20)
	})

	it("ABORT_ERR constant (20) is present on the prototype", async () => {
		await loadPolyfill()

		const proto = (global.DOMException as unknown as { prototype: Record<string, unknown> }).prototype

		expect(proto["ABORT_ERR"]).toBe(20)
	})

	it("ABORT_ERR constant on constructor is non-writable and non-configurable", async () => {
		await loadPolyfill()

		const descriptor = Object.getOwnPropertyDescriptor(global.DOMException, "ABORT_ERR")

		expect(descriptor).toBeDefined()
		expect(descriptor!.value).toBe(20)
		expect(descriptor!.writable).toBe(false)
		expect(descriptor!.configurable).toBe(false)
	})
})
