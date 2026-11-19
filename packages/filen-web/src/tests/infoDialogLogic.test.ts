import { describe, expect, it } from "vitest"
import { CATEGORY_POLICY, type PreviewCategory } from "@/features/drive/lib/preview.logic"
import { previewKindLabelKey } from "@/features/drive/components/infoDialog.logic"

describe("previewKindLabelKey", () => {
	it("maps each previewable category to its own Kind-row label key", () => {
		expect(previewKindLabelKey("image")).toBe("drivePreviewKindImage")
		expect(previewKindLabelKey("video")).toBe("drivePreviewKindVideo")
		expect(previewKindLabelKey("audio")).toBe("drivePreviewKindAudio")
		expect(previewKindLabelKey("pdf")).toBe("drivePreviewKindPdf")
		expect(previewKindLabelKey("docx")).toBe("drivePreviewKindDocx")
		expect(previewKindLabelKey("text")).toBe("drivePreviewKindText")
		expect(previewKindLabelKey("code")).toBe("drivePreviewKindCode")
		expect(previewKindLabelKey("markdown")).toBe("drivePreviewKindMarkdown")
		expect(previewKindLabelKey("archive")).toBe("drivePreviewKindArchive")
	})

	it("returns null for a non-previewable file so the Kind row is omitted", () => {
		expect(previewKindLabelKey("other")).toBeNull()
	})

	it("names a Kind for every PreviewCategory but 'other' (no unmapped row slips through)", () => {
		for (const category of Object.keys(CATEGORY_POLICY) as PreviewCategory[]) {
			const key = previewKindLabelKey(category)

			expect({ category, mapped: key !== null }).toEqual({ category, mapped: category !== "other" })
		}
	})
})
