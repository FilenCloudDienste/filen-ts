import { describe, expect, it } from "vitest"
import { toErrorDTO, asErrorDTO, labelFirst, type ErrorDTO } from "@/lib/sdk/errors"

// Models a live FilenSdkError WITHOUT pinning its class name: production minification mangles the
// real glue class to an arbitrary identifier, so detection must NOT lean on `constructor.name`. The
// shape is what matters — a `kind` string field plus the wasm accessor METHODS (message/inner/
// server) — so the class is deliberately named `X` and does NOT extend Error, proving both.
class X {
	kind = "Unauthenticated"
	message(): string {
		return "outer"
	}
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

describe("toErrorDTO", () => {
	it("classifies an SDK error by shape even when its class name is minified (no constructor.name match)", () => {
		expect(X.name).not.toBe("FilenSdkError") // the invariant the old name-pinned suite could not catch
		const dto = toErrorDTO(new X())
		expect(dto.species).toBe("sdk")
		expect(dto.kind).toBe("Unauthenticated")
		expect(dto.serverMessage).toBe("API key not found")
		expect(dto.label).toBe("API key not found")
		expect(structuredClone(dto)).toEqual(dto)
	})

	it("classifies a hollow structured clone (accessor METHODS stripped) as plain, not sdk", () => {
		// structuredClone drops prototype methods and keeps only own data — exactly what crossing
		// postMessage does to a FilenSdkError. The surviving `kind` data field alone must NOT read as
		// sdk; the missing `server_message` method is what keeps the duck-check safe.
		const hollow = structuredClone(new X())
		expect(typeof (hollow as { server_message?: unknown }).server_message).not.toBe("function")
		expect(toErrorDTO(hollow).species).toBe("plain")
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

describe("labelFirst", () => {
	it("prefers the server message over inner and outer", () => {
		const dto: ErrorDTO = { species: "sdk", message: "outer", innerMessage: "inner", serverMessage: "server", label: "" }
		expect(labelFirst(dto)).toBe("server")
	})

	it("falls back to the inner message when there is no server message (inner-only)", () => {
		const dto: ErrorDTO = { species: "sdk", message: "outer", innerMessage: "inner", label: "" }
		expect(labelFirst(dto)).toBe("inner")
	})

	it("falls back to the outer message when neither server nor inner is present (empty accessors)", () => {
		const dto: ErrorDTO = { species: "plain", message: "outer", label: "" }
		expect(labelFirst(dto)).toBe("outer")
	})
})

describe("asErrorDTO", () => {
	it("passes an already-shaped ErrorDTO through unchanged (same reference)", () => {
		const dto: ErrorDTO = { species: "plain", message: "already a dto", label: "already a dto" }
		expect(asErrorDTO(dto)).toBe(dto)
	})

	it("normalizes a raw Error", () => {
		expect(asErrorDTO(new Error("boom")).message).toBe("boom")
	})

	it("normalizes a random object that is not a DTO", () => {
		expect(asErrorDTO({ foo: 1 }).species).toBe("plain")
	})
})
