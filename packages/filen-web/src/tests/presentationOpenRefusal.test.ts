import { describe, expect, it } from "vitest"
import { openRefusalKey } from "@/features/presentation/lib/openRefusal"
import { previewPptxViewer } from "@/locales/en/previewPptx/viewer"

// What the viewer says when a deck refuses to open: each typed reason its own words, a password-protected
// OpenDocument deck included; anything else the generic failure.

describe("the viewer's words for a deck that refuses to open", () => {
	it("names a password-protected OpenDocument presentation", () => {
		const key = openRefusalKey("encrypted")

		expect(key).toBe("previewPptxEncrypted")
		expect(previewPptxViewer[key as keyof typeof previewPptxViewer]).toMatch(/password/iu)
	})

	it("keeps the generic failure for a reason without words of its own", () => {
		expect(openRefusalKey("stale")).toBe("previewPptxLoadFailed")
		expect(openRefusalKey("rightsManaged")).toBe("previewPptxRightsManaged")
	})
})
