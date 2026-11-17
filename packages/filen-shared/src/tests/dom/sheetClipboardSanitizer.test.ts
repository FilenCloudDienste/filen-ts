// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { createSheetClipboardSanitizer, type SheetClipboardPurifier } from "@filen/shared/dom"

describe("createSheetClipboardSanitizer", () => {
	// DOMPurify's `removed` holds the last run's parsed document until its next run.
	it("lets go of what the run removed", () => {
		const purifier: SheetClipboardPurifier = {
			removed: [],
			sanitize: dirty => {
				purifier.removed.push({ element: dirty })

				return dirty
			}
		}

		expect(createSheetClipboardSanitizer(purifier)("<table></table>")).toBe("<table></table>")
		expect(purifier.removed).toEqual([])
	})
})
