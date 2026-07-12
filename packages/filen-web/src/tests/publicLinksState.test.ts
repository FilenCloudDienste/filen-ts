import { describe, expect, it } from "vitest"
import { isPasswordError } from "@/features/publicLinks/lib/state.logic"

describe("isPasswordError", () => {
	it("recognizes a password error by its kind", () => {
		expect(isPasswordError({ kind: "wrongPassword", label: "Wrong password", message: "" })).toBe(true)
	})

	it("recognizes a password error mentioned only in the message", () => {
		expect(isPasswordError({ kind: "generic", label: "", message: "invalid PASSWORD supplied" })).toBe(true)
	})

	it("does not flag an unrelated error", () => {
		expect(isPasswordError({ kind: "notFound", label: "not found", message: "" })).toBe(false)
	})

	it("is safe against non-object errors", () => {
		expect(isPasswordError(null)).toBe(false)
		expect(isPasswordError("password")).toBe(false)
		expect(isPasswordError(undefined)).toBe(false)
	})
})
