import { describe, expect, it } from "vitest"
import { sanitizeFileName } from "@filen/shared"
import { keepBothName, localCollisionKey, localName } from "@filen/shared/localName"

const encoder = new TextEncoder()

function bytes(value: string): number {
	return encoder.encode(value).length
}

describe("localName", () => {
	it("keeps .env", () => {
		expect(localName(".env", "darwin")).toBe(".env")
		expect(localName(".env", "win32")).toBe(".env")
		expect(localName(".env", "linux")).toBe(".env")
	})

	it("replaces / \\ and NUL on every platform", () => {
		for (const platform of ["darwin", "win32", "linux"] as const) {
			expect(localName("a/b\\c\0d", platform)).toBe("a_b_c_d")
		}
	})

	it("replaces controls on every platform and the Windows set only on win32", () => {
		expect(localName("a\tb\x7fc", "linux")).toBe("a_b_c")
		expect(localName("a:b*c?d\"e<f>g|h", "win32")).toBe("a_b_c_d_e_f_g_h")
		expect(localName("a:b*c?d\"e<f>g|h", "darwin")).toBe("a:b*c?d\"e<f>g|h")
	})

	it("normalizes to NFC", () => {
		expect(localName("Ä.txt", "linux")).toBe("Ä.txt")
	})

	it("maps CON, com1.txt and \"name.\" on win32 and not on darwin", () => {
		expect(localName("CON", "win32")).toBe("CON_")
		expect(localName("com1.txt", "win32")).toBe("com1_.txt")
		expect(localName("nul.tar.gz", "win32")).toBe("nul_.tar.gz")
		expect(localName("name.", "win32")).toBe("name")
		expect(localName("name . ", "win32")).toBe("name")
		expect(localName("CON", "darwin")).toBe("CON")
		expect(localName("name.", "darwin")).toBe("name.")
	})

	it("maps CONIN$, COM¹ and \"CON .txt\" on win32", () => {
		expect(localName("conin$", "win32")).toBe("conin$_")
		expect(localName("CONOUT$.log", "win32")).toBe("CONOUT$_.log")
		expect(localName("COM¹", "win32")).toBe("COM¹_")
		expect(localName("lpt³.txt", "win32")).toBe("lpt³_.txt")
		expect(localName("CON .txt", "win32")).toBe("CON_ .txt")
		expect(localName("COM10", "win32")).toBe("COM10")
		expect(localName("console", "win32")).toBe("console")
	})

	it("never returns \"\", \".\" or \"..\"", () => {
		for (const platform of ["darwin", "win32", "linux"] as const) {
			for (const name of ["", ".", "..", "...", " "]) {
				const result = localName(name, platform)

				expect(result).not.toBe("")
				expect(result).not.toBe(".")
				expect(result).not.toBe("..")
			}
		}

		expect(localName("..", "linux")).not.toBe("..")
	})

	it("caps at 255 UTF-8 bytes keeping the extension", () => {
		const result = localName(`${"ä".repeat(200)}.txt`, "linux")

		expect(bytes(result)).toBeLessThanOrEqual(255)
		expect(result.endsWith(".txt")).toBe(true)
		expect(result.startsWith("ä".repeat(125))).toBe(true)
	})

	it("never splits a surrogate pair when capping", () => {
		const result = localName(`${"\u{1f600}".repeat(70)}.txt`, "linux")

		expect(bytes(result)).toBe(252)
		expect(result).toBe(`${"\u{1f600}".repeat(62)}.txt`)
	})

	it("caps a name whose extension is too long to keep", () => {
		const result = localName(`a.${"b".repeat(300)}`, "linux")

		expect(bytes(result)).toBe(255)
		expect(result.startsWith("a.b")).toBe(true)
	})

	it("keeps a capped win32 name free of trailing spaces and device names", () => {
		const trailing = localName(`${"a".repeat(254)} b`, "win32")

		expect(trailing).toBe("a".repeat(254))

		const device = localName(`COM1${" ".repeat(300)}.txt`, "win32")

		expect(bytes(device)).toBeLessThanOrEqual(255)
		expect(device.startsWith("COM1_")).toBe(true)
		expect(device.endsWith(".txt")).toBe(true)
	})
})

describe("keepBothName", () => {
	it("returns the name itself for n = 0", () => {
		expect(keepBothName("a.txt", 0, "file")).toBe("a.txt")
	})

	it("inserts the counter before a file's extension", () => {
		expect(keepBothName("a.txt", 1, "file")).toBe("a (1).txt")
		expect(keepBothName("a.tar.gz", 1, "file")).toBe("a.tar (1).gz")
		expect(keepBothName("README", 3, "file")).toBe("README (3)")
		expect(keepBothName(".env", 1, "file")).toBe(".env (1)")
	})

	it("appends the counter to a directory", () => {
		expect(keepBothName("dir", 2, "directory")).toBe("dir (2)")
		expect(keepBothName("my.dir", 1, "directory")).toBe("my.dir (1)")
	})

	it("keepBothName of a 255-byte name stays within 255 bytes and keeps its extension", () => {
		const name = `${"a".repeat(251)}.txt`
		const file = keepBothName(name, 12, "file")

		expect(bytes(file)).toBe(255)
		expect(file).toBe(`${"a".repeat(246)} (12).txt`)

		const directory = keepBothName("b".repeat(255), 1, "directory")

		expect(bytes(directory)).toBe(255)
		expect(directory).toBe(`${"b".repeat(251)} (1)`)
	})
})

describe("localCollisionKey", () => {
	it("folds case and normalization", () => {
		expect(localCollisionKey("Ä.txt".normalize("NFD"))).toBe(localCollisionKey("ä.TXT"))
	})
})

describe("sanitizeFileName", () => {
	it("still strips a leading dot", () => {
		expect(sanitizeFileName(".hidden")).toBe("hidden")
	})
})
