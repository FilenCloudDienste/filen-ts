import { describe, expect, it } from "vitest"
import { toErrorDTO, labelFirst } from "@/lib/sdk/errors"

class FakeFilenSdkError extends Error {
	__wbg_ptr = 12345
	kind = "Unauthenticated"
	constructor() {
		super("outer")
	}
	// wasm accessors are METHODS; message is BOTH inherited prop and method on the real class —
	// the fake models the method form via a shadowing own function:
	inner_message(): string {
		return "inner detail"
	}
	server_message(): string {
		return "API key not found"
	}
	server_code(): string {
		return "api_key_not_found"
	}
}
Object.defineProperty(FakeFilenSdkError, "name", { value: "FilenSdkError" })

describe("toErrorDTO", () => {
	it("extracts FilenSdkError to a cloneable DTO", () => {
		const dto = toErrorDTO(new FakeFilenSdkError())
		expect(dto.species).toBe("sdk")
		expect(dto.kind).toBe("Unauthenticated")
		expect(dto.serverMessage).toBe("API key not found")
		expect(dto.label).toBe("API key not found")
		expect(structuredClone(dto)).toEqual(dto)
	})
	it("wraps plain marshalling errors", () => {
		const dto = toErrorDTO(new Error("invalid type: string"))
		expect(dto.species).toBe("plain")
		expect(dto.kind).toBeUndefined()
		expect(labelFirst(dto)).toBe("invalid type: string")
	})
	it("never throws on garbage", () => {
		expect(toErrorDTO(undefined).label).toBeTypeOf("string")
	})
})
