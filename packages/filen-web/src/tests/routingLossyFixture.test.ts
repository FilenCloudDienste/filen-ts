import { describe, expect, it } from "vitest"
import { looksLikeText } from "@filen/shared/textEncoding"
import { readTextFile, readUnicodeTextFile } from "@/features/preview/lib/textFile"

// The routing e2e's lossy file, pinned: it reads as UTF-8 with a replacement character before any codepage is guessed,
// so the encoding detector is never asked and the e2e cannot drift with it; a save cannot write it back.

const { ROUTING_LOSSY_BYTES, ROUTING_LOSSY_LINE } = await import("../../e2e/fixtures/routing")

describe("the routing e2e's lossy text file", () => {
	const bytes = new Uint8Array(ROUTING_LOSSY_BYTES)

	it("is text, read as UTF-8 with an error, and read-only, with no codepage guessed", () => {
		const file = readUnicodeTextFile(bytes)

		expect(looksLikeText(bytes)).toBe(true)
		expect(file).toMatchObject({ encoding: "utf-8", editableAsIs: false, lossy: true })
		expect(file?.text.split("\n")[0]).toBe(ROUTING_LOSSY_LINE)
		expect(file?.text).toContain("�")
	})

	// Whatever the detector or a remembered codepage would say, the Unicode reading comes first; as it would be read
	// without one, it is the same.
	it("reads the same whatever codepage would be guessed", () => {
		for (const guess of ["windows-1252", "windows-1251", "shift_jis", null]) {
			expect(readTextFile(bytes, { guess })).toMatchObject({ encoding: "utf-8", editableAsIs: false, lossy: true })
		}
	})
})
