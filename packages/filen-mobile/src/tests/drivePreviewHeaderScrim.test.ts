import { describe, it, expect, vi } from "vitest"

// The module imports react-native-svg for the gradient itself; only the pure rule is under test.
vi.mock("react-native-svg", () => ({
	default: () => null,
	Defs: () => null,
	LinearGradient: () => null,
	Rect: () => null,
	Stop: () => null
}))

vi.mock("react-native", () => ({
	StyleSheet: { absoluteFill: {} }
}))

import { drivePreviewHeaderNeedsScrim } from "@/components/drivePreview/headerScrim"

describe("drivePreviewHeaderNeedsScrim", () => {
	it("backs the header on the previews that scroll text under it", () => {
		// These extend edge to edge, so their content passes beneath the overlaid header rather than
		// stopping below it — leaving the title to compete with whatever line is behind it.
		expect(drivePreviewHeaderNeedsScrim({ previewType: "text", solidHeader: false })).toBe(true)
		expect(drivePreviewHeaderNeedsScrim({ previewType: "code", solidHeader: false })).toBe(true)
	})

	it("adds nothing where the header is already opaque", () => {
		// pdf/docx/video hide the content outright, so a fade on top would only mute their own header.
		for (const previewType of ["pdf", "docx", "video", "text", "code"]) {
			expect(drivePreviewHeaderNeedsScrim({ previewType, solidHeader: true })).toBe(false)
		}
	})

	it("leaves the media previews alone", () => {
		// An image or an audio player centres one piece of content; nothing runs under the title that a
		// fade would disambiguate, and dimming the top of a photo is a change nobody asked for.
		for (const previewType of ["image", "audio", "svg", "unknown"]) {
			expect(drivePreviewHeaderNeedsScrim({ previewType, solidHeader: false })).toBe(false)
		}
	})

	it("keys off the header being transparent, not off the platform", () => {
		// Android makes text/code solid and iOS does not; the rule reads that decision rather than
		// re-deriving it, so the two cannot drift apart.
		expect(drivePreviewHeaderNeedsScrim({ previewType: "text", solidHeader: true })).toBe(false)
		expect(drivePreviewHeaderNeedsScrim({ previewType: "text", solidHeader: false })).toBe(true)
	})
})
