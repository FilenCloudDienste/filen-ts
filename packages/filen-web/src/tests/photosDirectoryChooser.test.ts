import { describe, expect, it } from "vitest"
import { photosChooserChoice } from "@/features/photos/components/directoryChooserDialog.logic"
import { testUuid } from "@/tests/support/uuid"

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
