import { describe, expect, it } from "vitest"
import type { UuidStr } from "@filen/sdk-rs"
import { photosChooserChoice } from "@/features/photos/components/directoryChooserDialog.logic"

// UuidStr is a template-literal brand requiring at least 3 dashes — pad a short readable test label
// into a shape that satisfies it.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

describe("photosChooserChoice", () => {
	it("chooses the directory open in the picker", () => {
		expect(photosChooserChoice(testUuid("a"), testUuid("root"))).toBe(testUuid("a"))
	})

	it("chooses the whole drive by its root uuid at the top", () => {
		expect(photosChooserChoice(null, testUuid("root"))).toBe(testUuid("root"))
	})

	it("chooses nothing at the top until the root uuid is known", () => {
		expect(photosChooserChoice(null, undefined)).toBeNull()
		expect(photosChooserChoice(null, "")).toBeNull()
	})
})
