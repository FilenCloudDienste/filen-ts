import { describe, expect, it } from "vitest"
import { isScratchDebrisName, isNoteDebrisTitle, isTagDebrisName } from "@/e2e-hooks/scratchDebris"

describe("isScratchDebrisName", () => {
	it.each([
		"e2e-marquee-abc123",
		"debug-probe",
		"_debug",
		"_debugSomething",
		"zz-old-scratch",
		"_tmp",
		"_tmpFixture",
		"tmp-fixture",
		"d4-leftover",
		"dlagt5-leftover",
		"diagt5-leftover",
		"drive-marquee-abc",
		"review-batch-3"
	])("matches every known scratch prefix: %s", name => {
		expect(isScratchDebrisName(name)).toBe(true)
	})

	it.each([
		"",
		"My Documents",
		"Invoice 2026.pdf",
		"Photos",
		"e2",
		"a-e2e-marquee-abc",
		"note about tmp-files.txt",
		"reviewed-notes",
		"D4-Leftover"
	])("never matches real content or a non-anchored/near-miss name: %s", name => {
		expect(isScratchDebrisName(name)).toBe(false)
	})
})

describe("isNoteDebrisTitle", () => {
	it.each(["e2e action note 1783720000000", "e2e text 123-456", "e2e checklist 9-9", "e2e-note-probe"])(
		"matches every spec-minted note title shape: %s",
		title => {
			expect(isNoteDebrisTitle(title)).toBe(true)
		}
	)

	it.each(["", "e2e", "e2etest", "My e2e journey", "Groceries", "E2E plan"])(
		"never matches an unanchored/near-miss/real title: %s",
		title => {
			expect(isNoteDebrisTitle(title)).toBe(false)
		}
	)
})

describe("isTagDebrisName", () => {
	it.each(["e2e-tag-1783720000000", "e2e-tag-x"])("matches spec-minted tag names: %s", name => {
		expect(isTagDebrisName(name)).toBe(true)
	})

	it.each(["", "e2e-tag", "e2e ", "work", "my-e2e-tag-1"])("never matches real or near-miss tag names: %s", name => {
		expect(isTagDebrisName(name)).toBe(false)
	})
})
