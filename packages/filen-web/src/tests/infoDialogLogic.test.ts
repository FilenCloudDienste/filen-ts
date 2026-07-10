import { describe, expect, it } from "vitest"
import { type PreviewCategory } from "@/features/drive/lib/preview.logic"
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
	})

	it("returns null for a non-previewable file so the Kind row is omitted", () => {
		expect(previewKindLabelKey("other")).toBeNull()
	})

	it("covers every PreviewCategory (no unmapped arm slips through)", () => {
		const categories: PreviewCategory[] = ["image", "video", "audio", "pdf", "docx", "text", "code", "markdown", "other"]

		for (const category of categories) {
			const key = previewKindLabelKey(category)

			expect(category === "other" ? key === null : typeof key === "string").toBe(true)
		}
	})
})
