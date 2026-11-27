import { describe, it, expect } from "vitest"
import { driveKeepBothName, nameCollisionKey } from "@filen/shared"

function keys(...names: string[]): Set<string> {
	return new Set(names.map(nameCollisionKey))
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).length
}

// Cases mirror sdk-rs fs/name/keep_both/tests.rs.
describe("driveKeepBothName", () => {
	it("keeps a free name", () => {
		expect(driveKeepBothName({ name: "a.txt", isDirectory: false, taken: keys("other.txt") })).toBe("a.txt")
		expect(driveKeepBothName({ name: "dir", isDirectory: true, taken: keys() })).toBe("dir")
	})

	it("numbers a clashing name from (1), as the SDK does", () => {
		expect(driveKeepBothName({ name: "a.txt", isDirectory: false, taken: keys("a.txt") })).toBe("a (1).txt")
		expect(driveKeepBothName({ name: "a.txt", isDirectory: false, taken: keys("a.txt", "a (1).txt", "a (2).txt") })).toBe("a (3).txt")
		expect(driveKeepBothName({ name: "docs", isDirectory: true, taken: keys("docs") })).toBe("docs (1)")
	})

	it("collides case-insensitively and across NFC/NFD", () => {
		expect(driveKeepBothName({ name: "a.txt", isDirectory: false, taken: keys("A.TXT") })).toBe("a (1).txt")
		expect(driveKeepBothName({ name: "a.txt", isDirectory: false, taken: keys("A.TXT", "A (1).txt") })).toBe("a (2).txt")
		expect(driveKeepBothName({ name: "Café.txt", isDirectory: false, taken: keys("café.txt") })).toBe("Café (1).txt")
	})

	it("continues an existing counter", () => {
		expect(driveKeepBothName({ name: "a (1).txt", isDirectory: false, taken: keys("a (1).txt") })).toBe("a (2).txt")
		expect(driveKeepBothName({ name: "photos (9)", isDirectory: true, taken: keys("photos (9)") })).toBe("photos (10)")
		expect(driveKeepBothName({ name: "a (x).txt", isDirectory: false, taken: keys("a (x).txt") })).toBe("a (x) (1).txt")
		expect(driveKeepBothName({ name: "(1).txt", isDirectory: false, taken: keys("(1).txt") })).toBe("(1) (1).txt")
		expect(driveKeepBothName({ name: "a(1).txt", isDirectory: false, taken: keys("a(1).txt") })).toBe("a(1) (1).txt")
	})

	it("treats a counter that cannot grow as part of the stem", () => {
		const max = "a (18446744073709551615).txt"

		expect(driveKeepBothName({ name: max, isDirectory: false, taken: keys(max) })).toBe("a (18446744073709551615) (1).txt")
	})

	it("keeps only a file's last extension apart, a dotfile and a directory whole", () => {
		expect(driveKeepBothName({ name: "a.tar.gz", isDirectory: false, taken: keys("a.tar.gz") })).toBe("a.tar (1).gz")
		expect(driveKeepBothName({ name: "Makefile", isDirectory: false, taken: keys("Makefile") })).toBe("Makefile (1)")
		expect(driveKeepBothName({ name: ".bashrc", isDirectory: false, taken: keys(".bashrc") })).toBe(".bashrc (1)")
		expect(driveKeepBothName({ name: "my.folder", isDirectory: true, taken: keys("my.folder") })).toBe("my.folder (1)")
	})

	it("cuts a long base at a character boundary to stay within 255 bytes", () => {
		const long = `${"é".repeat(125)}.txt`
		const renamed = driveKeepBothName({ name: long, isDirectory: false, taken: keys(long) })

		expect(utf8Bytes(renamed)).toBeLessThanOrEqual(255)
		expect(renamed.endsWith(" (1).txt")).toBe(true)
	})

	it("folds an extension that leaves no room for the base into it", () => {
		const huge = `a.${"x".repeat(253)}`
		const renamed = driveKeepBothName({ name: huge, isDirectory: false, taken: keys(huge) })

		expect(utf8Bytes(renamed)).toBeLessThanOrEqual(255)
		expect(renamed.startsWith("a.")).toBe(true)
		expect(renamed.endsWith(" (1)")).toBe(true)

		const emoji = `\u{1F600}.${"a".repeat(247)}`

		expect(driveKeepBothName({ name: emoji, isDirectory: false, taken: keys(emoji) })).toBe(`\u{1F600}.${"a".repeat(246)} (1)`)
	})
})
