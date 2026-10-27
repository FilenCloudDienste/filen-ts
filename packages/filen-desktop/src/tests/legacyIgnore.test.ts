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

	it("leaves the old local trash to the engine, which reserves it", () => {
		expect(oldWouldIgnore(".filen.trash.local", { excludeDotFiles: false })).toBe(false)
		expect(oldWouldIgnore("d/.filen.trash.local/old.txt", { excludeDotFiles: false })).toBe(false)
	})

	it("adds none of the old always-on patterns", () => {
		for (const relPath of ["a.tmp", "b.temp", "c.ffs_tmp", "d.temporary", "e.~cr", "f.thumbdata", "g.crswap", "ntuser.dat"]) {
			expect(oldWouldIgnore(relPath, { excludeDotFiles: true })).toBe(false)
		}
	})
})
