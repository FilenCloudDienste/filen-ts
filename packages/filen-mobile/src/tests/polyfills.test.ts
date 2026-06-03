import { vi, describe, it, expect, afterEach } from "vitest"

// All legacy constants defined by the polyfill — name → expected numeric value.
const ALL_LEGACY_CONSTANTS: readonly (readonly [string, number])[] = [
	["INDEX_SIZE_ERR", 1],
	["DOMSTRING_SIZE_ERR", 2],
	["HIERARCHY_REQUEST_ERR", 3],
	["WRONG_DOCUMENT_ERR", 4],
	["INVALID_CHARACTER_ERR", 5],
	["NO_DATA_ALLOWED_ERR", 6],
	["NO_MODIFICATION_ALLOWED_ERR", 7],
	["NOT_FOUND_ERR", 8],
	["NOT_SUPPORTED_ERR", 9],
	["INUSE_ATTRIBUTE_ERR", 10],
	["INVALID_STATE_ERR", 11],
	["SYNTAX_ERR", 12],
	["INVALID_MODIFICATION_ERR", 13],
	["NAMESPACE_ERR", 14],
	["INVALID_ACCESS_ERR", 15],
	["VALIDATION_ERR", 16],
	["TYPE_MISMATCH_ERR", 17],
	["SECURITY_ERR", 18],
	["NETWORK_ERR", 19],
	["ABORT_ERR", 20],
	["URL_MISMATCH_ERR", 21],
	["QUOTA_EXCEEDED_ERR", 22],
	["TIMEOUT_ERR", 23],
	["INVALID_NODE_TYPE_ERR", 24],
	["DATA_CLONE_ERR", 25]
]

describe("DOMException polyfill", () => {
	// Capture the original value before the test file runs (may be undefined in vitest node env).
	const originalDOMException = global.DOMException

	async function loadPolyfill() {
		// Always delete so the polyfill guard (`typeof global.DOMException === "undefined"`) triggers.
		// @ts-expect-error remove native DOMException to force polyfill installation
		delete global.DOMException
		vi.resetModules()
		await import("@/lib/polyfills/DOMException")
	}

	afterEach(() => {
		// Always restore — including when the original was undefined, which means delete it.
		if (originalDOMException !== undefined) {
			global.DOMException = originalDOMException
		} else {
			// @ts-expect-error restoring undefined state
			delete global.DOMException
		}
	})

	it("installs DOMException on global when not present", async () => {
		await loadPolyfill()

		expect(typeof global.DOMException).toBe("function")
	})

	it("does not overwrite a pre-existing global DOMException", async () => {
		// Ensure polyfill is installed first, then import again — the guard must no-op.
		await loadPolyfill()
		const polyfillClass = global.DOMException

		vi.resetModules()
		await import("@/lib/polyfills/DOMException")

		expect(global.DOMException).toBe(polyfillClass)
	})

	it("stores message and name", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("test message", "AbortError")

		expect(ex.message).toBe("test message")
		expect(ex.name).toBe("AbortError")
	})

	it("defaults name to 'Error' and code to 0 when only message is given", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("msg")

		expect(ex.name).toBe("Error")
		expect(ex.code).toBe(0)
	})

	it("defaults both message and name when called with no arguments", async () => {
		await loadPolyfill()

		const ex = new global.DOMException()

		expect(ex.message).toBe("")
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

	it("code getter returns correct value for NotFoundError (8)", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("not found", "NotFoundError")

		expect(ex.code).toBe(8)
	})

	it("code getter returns correct value for TimeoutError (23)", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("timed out", "TimeoutError")

		expect(ex.code).toBe(23)
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

	it("message property is non-enumerable", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("secret message", "AbortError")
		const descriptor = Object.getOwnPropertyDescriptor(ex, "message")

		expect(descriptor).toBeDefined()
		expect(descriptor!.enumerable).toBe(false)
	})

	it("name property is non-enumerable", async () => {
		await loadPolyfill()

		const ex = new global.DOMException("msg", "AbortError")
		const descriptor = Object.getOwnPropertyDescriptor(ex, "name")

		expect(descriptor).toBeDefined()
		expect(descriptor!.enumerable).toBe(false)
	})

	describe("LEGACY_CONSTANTS on constructor", () => {
		it.each(ALL_LEGACY_CONSTANTS)("%s === %i on the constructor", async (name, value) => {
			await loadPolyfill()

			const ctor = global.DOMException as unknown as Record<string, unknown>

			expect(ctor[name]).toBe(value)
		})

		it.each(ALL_LEGACY_CONSTANTS)("%s descriptor on constructor: value=%i, writable=false, configurable=false, enumerable=true", async (name, value) => {
			await loadPolyfill()

			const descriptor = Object.getOwnPropertyDescriptor(global.DOMException, name)

			expect(descriptor).toBeDefined()
			expect(descriptor!.value).toBe(value)
			expect(descriptor!.writable).toBe(false)
			expect(descriptor!.configurable).toBe(false)
			expect(descriptor!.enumerable).toBe(true)
		})
	})

	describe("LEGACY_CONSTANTS on prototype", () => {
		it.each(ALL_LEGACY_CONSTANTS)("%s === %i on the prototype", async (name, value) => {
			await loadPolyfill()

			const proto = (global.DOMException as unknown as { prototype: Record<string, unknown> }).prototype

			expect(proto[name]).toBe(value)
		})

		it.each(ALL_LEGACY_CONSTANTS)("%s descriptor on prototype: value=%i, writable=false, configurable=false, enumerable=true", async (name, value) => {
			await loadPolyfill()

			const proto = (global.DOMException as unknown as { prototype: Record<string, unknown> }).prototype
			const descriptor = Object.getOwnPropertyDescriptor(proto, name)

			expect(descriptor).toBeDefined()
			expect(descriptor!.value).toBe(value)
			expect(descriptor!.writable).toBe(false)
			expect(descriptor!.configurable).toBe(false)
			expect(descriptor!.enumerable).toBe(true)
		})
	})

	it("LEGACY_CONSTANTS are enumerable via for-in on the constructor", async () => {
		await loadPolyfill()

		const ctor = global.DOMException as unknown as Record<string, unknown>
		const enumerableKeys: string[] = []

		for (const key in ctor) {
			enumerableKeys.push(key)
		}

		for (const [name] of ALL_LEGACY_CONSTANTS) {
			expect(enumerableKeys).toContain(name)
		}
	})
})
