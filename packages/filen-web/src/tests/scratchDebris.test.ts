import { describe, expect, it } from "vitest"
import { isScratchDebrisName } from "@/e2e-hooks/scratchDebris"

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
