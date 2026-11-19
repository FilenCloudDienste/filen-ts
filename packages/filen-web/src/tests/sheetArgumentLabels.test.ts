import { describe, expect, it } from "vitest"
import { ARGUMENT_LABELS } from "@filen/office/core/sheet"
import { preview } from "@/locales/en/preview"

// Formula signature help shows each argument's label through the catalog: one English key per catalogue argument id,
// worded as the catalogue's own English label, so the two cannot drift.

const PREFIX = "previewSheetArg_"

describe("formula argument labels", () => {
	it("have one English key per catalogue argument, with the catalogue's wording", () => {
		const catalog: Record<string, string> = preview
		const keys = Object.keys(catalog).filter(key => key.startsWith(PREFIX))

		expect(keys.toSorted()).toEqual(
			Object.keys(ARGUMENT_LABELS)
				.map(id => `${PREFIX}${id}`)
				.toSorted()
		)

		for (const [id, label] of Object.entries(ARGUMENT_LABELS)) {
			expect(catalog[`${PREFIX}${id}`], id).toBe(label)
		}
	})
})
