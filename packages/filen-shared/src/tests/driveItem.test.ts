import { describe, it, expect } from "vitest"
import { driveItemName, nameCollisionKey } from "@filen/shared"

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

describe("nameCollisionKey", () => {
	it("makes names differing only in letter case collide", () => {
		expect(nameCollisionKey("Report.DOCX")).toBe(nameCollisionKey("report.docx"))
		expect(nameCollisionKey("ÄRGER.txt")).toBe(nameCollisionKey("ärger.txt"))
		expect(nameCollisionKey("report.docx")).not.toBe(nameCollisionKey("report 2.docx"))
	})

	it("folds as the server's name hash does (Rust str::to_lowercase), not as a simple case fold", () => {
		expect(nameCollisionKey("İstanbul")).toBe("i\u0307stanbul")
		expect(nameCollisionKey("ΟΔΟΣ")).toBe("οδος")
		// "." is case-ignorable and letters follow, so the sigma is not final (as in Rust).
		expect(nameCollisionKey("ΟΔΟΣ.txt")).toBe("οδοσ.txt")
	})

	it("makes a decomposed (NFD) name collide with its composed (NFC) form, as the SDK stores names NFC", () => {
		const nfc = "Café.txt"
		const nfd = "Café.txt"

		expect(nfc).not.toBe(nfd)
		expect(nameCollisionKey(nfd)).toBe(nameCollisionKey(nfc))
		expect(nameCollisionKey("CAFÉ.TXT")).toBe("café.txt")
	})
})
