import { describe, it, expect } from "vitest"
import { serializeError, deserializeError } from "@filen/utils"

describe("serializeError", () => {
	it("should serialize error name, message, and stack", () => {
		const error = new Error("test error")
		const serialized = serializeError(error)

		expect(serialized.name).toBe("Error")
		expect(serialized.message).toBe("test error")
		expect(serialized.stack).toBeDefined()
		expect(typeof serialized.stringified).toBe("string")
	})

	it("should preserve custom error names", () => {
		const error = new TypeError("type error")
		const serialized = serializeError(error)

		expect(serialized.name).toBe("TypeError")
	})

	it("should stringify to valid JSON", () => {
		const error = new Error("test")
		const serialized = serializeError(error)

		expect(() => JSON.parse(serialized.stringified)).not.toThrow()
	})
})

describe("deserializeError", () => {
	it("should recreate error from serialized form", () => {
		const original = new Error("test error")
		const serialized = serializeError(original)
		const deserialized = deserializeError(serialized)

		expect(deserialized).toBeInstanceOf(Error)
		expect(deserialized.message).toBe("test error")
		expect(deserialized.name).toBe("Error")
	})

	it("should preserve custom error names", () => {
		const serialized = {
			name: "CustomError",
			message: "custom",
			stack: undefined,
			stringified: "{}"
		}
		const deserialized = deserializeError(serialized)

		expect(deserialized.name).toBe("CustomError")
		expect(deserialized.message).toBe("custom")
	})

	it("should roundtrip serialize/deserialize", () => {
		const original = new Error("roundtrip test")

		original.name = "ValidationError"

		const deserialized = deserializeError(serializeError(original))

		expect(deserialized.name).toBe(original.name)
		expect(deserialized.message).toBe(original.message)
	})
})
