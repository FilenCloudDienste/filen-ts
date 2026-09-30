import { describe, it, expect } from "vitest"
import { serializeError, deserializeError } from "@/lib/storage/rpcError"

describe("rpc error serialization", () => {
	it("round-trips name, message and stack", () => {
		const original = new TypeError("type error")
		const deserialized = deserializeError(serializeError(original))

		expect(deserialized).toBeInstanceOf(Error)
		expect(deserialized.name).toBe("TypeError")
		expect(deserialized.message).toBe("type error")
		expect(deserialized.stack).toBe(original.stack)
	})

	it("preserves a custom name", () => {
		const original = new Error("custom")

		original.name = "OpfsUnavailableError"

		const deserialized = deserializeError(serializeError(original))

		expect(deserialized.name).toBe("OpfsUnavailableError")
		expect(deserialized.message).toBe("custom")
	})
})
