import { describe, expect, it } from "vitest"
import { CODE_FILE_EXTENSIONS, extensionStart } from "@filen/shared"

describe("CODE_FILE_EXTENSIONS", () => {
	it("is the verified 53-entry intersection, lowercase and dot-less", () => {
		expect(CODE_FILE_EXTENSIONS.size).toBe(53)

		for (const ext of CODE_FILE_EXTENSIONS) {
			expect(ext).toBe(ext.toLowerCase())
			expect(ext.startsWith(".")).toBe(false)
		}
	})

	it("contains representative source-code extensions", () => {
		expect(CODE_FILE_EXTENSIONS.has("ts")).toBe(true)
		expect(CODE_FILE_EXTENSIONS.has("tsx")).toBe(true)
		expect(CODE_FILE_EXTENSIONS.has("rs")).toBe(true)
		expect(CODE_FILE_EXTENSIONS.has("gradle")).toBe(true)
		expect(CODE_FILE_EXTENSIONS.has("proto")).toBe(true)
	})

	it("excludes md/markdown/log — each app composes those back in locally", () => {
		expect(CODE_FILE_EXTENSIONS.has("md")).toBe(false)
		expect(CODE_FILE_EXTENSIONS.has("markdown")).toBe(false)
		expect(CODE_FILE_EXTENSIONS.has("log")).toBe(false)
	})

	it("excludes ahk — left to the icon classifier batch to decide", () => {
		expect(CODE_FILE_EXTENSIONS.has("ahk")).toBe(false)
	})
})

describe("extensionStart", () => {
	it("returns the index of the last dot", () => {
		expect(extensionStart("notes.md")).toBe(5)
		expect(extensionStart("archive.tar.gz")).toBe(11)
	})

	it("treats a leading dot, a trailing dot or no dot as no extension", () => {
		expect(extensionStart(".bashrc")).toBe(-1)
		expect(extensionStart("report.")).toBe(-1)
		expect(extensionStart("README")).toBe(-1)
		expect(extensionStart("")).toBe(-1)
	})
})
