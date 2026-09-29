import { describe, expect, it } from "vitest"
import { contactInitials } from "@/components/userAvatar.logic"

describe("contactInitials", () => {
	it("uppercases the first character of the display name", () => {
		expect(contactInitials("alice")).toBe("A")
	})

	it("trims leading whitespace before taking the first character", () => {
		expect(contactInitials("  bob")).toBe("B")
	})

	it("falls back to a placeholder for an empty display name", () => {
		expect(contactInitials("")).toBe("?")
	})
})
