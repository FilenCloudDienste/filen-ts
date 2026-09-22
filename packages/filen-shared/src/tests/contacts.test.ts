import { describe, it, expect } from "vitest"
import { contactDisplayName } from "@filen/shared"

describe("contactDisplayName", () => {
	it("returns the nickname when it is set and non-empty", () => {
		expect(contactDisplayName({ email: "alice@filen.io", nickName: "Alice" })).toBe("Alice")
	})

	it("falls back to the email when nickName is an empty string", () => {
		expect(contactDisplayName({ email: "alice@filen.io", nickName: "" })).toBe("alice@filen.io")
	})

	it("falls back to the email when nickName is absent", () => {
		expect(contactDisplayName({ email: "alice@filen.io" })).toBe("alice@filen.io")
	})
})
