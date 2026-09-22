import { describe, it, expect } from "vitest"
import { driveItemName } from "@filen/shared"

describe("driveItemName", () => {
	it("returns the decrypted metadata's name when present", () => {
		expect(driveItemName({ data: { uuid: "uuid-1", decryptedMeta: { name: "Documents" } } })).toBe("Documents")
	})

	it("falls back to the uuid when decryptedMeta is null", () => {
		expect(driveItemName({ data: { uuid: "uuid-2", decryptedMeta: null } })).toBe("uuid-2")
	})

	it("falls back to the uuid when decryptedMeta is undefined", () => {
		expect(driveItemName({ data: { uuid: "uuid-3" } })).toBe("uuid-3")
	})
})
