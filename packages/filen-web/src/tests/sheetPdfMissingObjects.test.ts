import { beforeEach, describe, expect, it, vi } from "vitest"

// A spreadsheet's PDF that left out a chart, picture or shape whose render failed says so, as it does for missing
// pictures and characters, and logs how many.

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }))

vi.mock("@/lib/log", () => ({ log }))

const { sheetPdfMessages } = await import("@/features/spreadsheet/save/sheetPdf")

const MADE = { ok: true, blob: new Blob([]), pages: 1, missingImages: 0, missingGlyphs: 0, unshapedRuns: 0, missingObjects: 0 } as const

beforeEach(() => {
	vi.clearAllMocks()
})

describe("a spreadsheet's PDF that left an object off", () => {
	it("warns that the PDF was simplified and logs the count", () => {
		expect(sheetPdfMessages({ ...MADE, missingObjects: 1 })).toEqual({
			warnings: [{ key: "previewSheetPdfSimplified", values: {} }],
			error: null
		})
		expect(log.warn).toHaveBeenCalledWith("preview", "spreadsheet pdf simplified", { glyphs: 0, images: 0, objects: 1 })
	})

	it("says nothing when every object was drawn", () => {
		expect(sheetPdfMessages(MADE)).toEqual({ warnings: [], error: null })
		expect(log.warn).not.toHaveBeenCalled()
	})
})
