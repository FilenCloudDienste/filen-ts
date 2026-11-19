// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import {
	highlightedReferences,
	MAX_VALIDATION_ERROR,
	MAX_VALIDATION_LIST,
	MAX_VALIDATION_PROMPT,
	MAX_VALIDATION_TITLE,
	type SheetRange
} from "@filen/office/core/sheet"
import type { GridCanvas, GridPaintScene } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { ValidationDialog } from "@/features/spreadsheet/data/dvDialog"
import { NEW_RULE, validationRefusalKey } from "@/features/spreadsheet/data/dvDialog.logic"
import { referenceLayer } from "@/features/spreadsheet/formulaBar/referenceLayer"

// The sheet view limits what the engine limits, with the engine's own numbers: a validation's text lengths, and the
// sheet's extent a whole-column or whole-row reference reaches.

afterEach(() => {
	cleanup()
})

describe("the Data validation dialog's limits", () => {
	it("are the engine's (Excel's 32, 255, 32 and 225 characters)", () => {
		expect([MAX_VALIDATION_TITLE, MAX_VALIDATION_PROMPT, MAX_VALIDATION_ERROR, MAX_VALIDATION_LIST]).toEqual([32, 255, 225, 255])

		const { container } = render(
			<ValidationDialog
				rule={{ ...NEW_RULE, showInputMessage: true, showErrorMessage: true }}
				kind="xlsx"
				onClose={() => undefined}
				onApply={() => Promise.resolve(null)}
				onClear={() => undefined}
			/>
		)
		const limit = (id: string): number => {
			const field = container.ownerDocument.getElementById(id)

			return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.maxLength : -1
		}

		expect(limit("validation-prompt-title")).toBe(MAX_VALIDATION_TITLE)
		expect(limit("validation-prompt")).toBe(MAX_VALIDATION_PROMPT)
		expect(limit("validation-error-title")).toBe(MAX_VALIDATION_TITLE)
		expect(limit("validation-error-text")).toBe(MAX_VALIDATION_ERROR)
	})

	it("calls a typed list too long past the engine's limit", () => {
		const list = (length: number) => ({ ...NEW_RULE, type: "list" as const, value1: "x".repeat(length) })

		expect(validationRefusalKey("tooLarge", list(MAX_VALIDATION_LIST))).toBe("previewSheetValidationTextTooLong")
		expect(validationRefusalKey("tooLarge", list(MAX_VALIDATION_LIST + 1))).toBe("previewSheetValidationListTooLong")
	})
})

describe("the formula's references outlined to the sheet's edge", () => {
	it("reaches the last row of a whole column and the last column of a whole row", () => {
		const references = highlightedReferences("=B:C+3:4", 4)
		const layer = referenceLayer({ references, ownSheet: "Data", shownSheet: "Data", colors: ["#1f5fd6"] })
		const ranges: SheetRange[] = []
		const scene: Pick<GridPaintScene, "rangeRects"> = {
			rangeRects: range => {
				ranges.push(range)

				return []
			}
		}

		layer.paint({} as GridCanvas, scene as GridPaintScene)

		expect(ranges).toEqual([
			{ startRow: 0, startCol: 1, endRow: 1_048_575, endCol: 2 },
			{ startRow: 2, startCol: 0, endRow: 3, endCol: 16_383 }
		])
	})
})
