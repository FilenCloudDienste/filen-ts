import { describe, expect, it } from "vitest"
import { oldWouldIgnore } from "../shared/legacyIgnore.ts"

describe("oldWouldIgnore", () => {
	it("hides dot files and directories only where the pair excluded them", () => {
		const excluded = { excludeDotFiles: true }

		expect(oldWouldIgnore(".env", excluded)).toBe(true)
		expect(oldWouldIgnore("src/.git/HEAD", excluded)).toBe(true)
		expect(oldWouldIgnore("d/.filenignore", excluded)).toBe(true)
		expect(oldWouldIgnore("notes.txt", excluded)).toBe(false)
		expect(oldWouldIgnore("a.b/c", excluded)).toBe(false)
		expect(oldWouldIgnore(".env", { excludeDotFiles: false })).toBe(false)
	})

	it("keeps the root .filenignore", () => {
		expect(oldWouldIgnore(".filenignore", { excludeDotFiles: true })).toBe(false)
	})

	it("always hides the old local trash", () => {
		expect(oldWouldIgnore(".filen.trash.local", { excludeDotFiles: false })).toBe(true)
		expect(oldWouldIgnore(".filen.trash.local/old.txt", { excludeDotFiles: false })).toBe(true)
	})

	it("adds none of the old always-on patterns", () => {
		for (const relPath of ["a.tmp", "b.temp", "c.ffs_tmp", "d.temporary", "e.~cr", "f.thumbdata", "g.crswap", "ntuser.dat"]) {
			expect(oldWouldIgnore(relPath, { excludeDotFiles: true })).toBe(false)
		}
	})
})
