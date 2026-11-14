import { describe, expect, it } from "vitest"
import { OFFICE_SIGNATURE_FONTS } from "virtual:office-signature-fonts"
import type { SavedPdfSignature } from "@filen/shared/pdfSignatures"
import {
	DEFAULT_SIGNATURE_STYLE,
	needsSignatureFallback,
	parseUnicodeRange,
	rememberedSignatureStyle,
	SIGNATURE_FALLBACK_FAMILY,
	SIGNATURE_STYLES,
	signatureFontFamily,
	signatureStyleFont
} from "@/features/pdf/fillSign/signatureStyles"

// The typed signature's handwriting styles: the fonts @filen/office ships for them, which characters each draws
// itself (the rest go to the fallback, never a missing-glyph box) and the style a new typed signature starts on.

const saved = (id: string, at: number, data: SavedPdfSignature["data"]): SavedPdfSignature => ({ id, role: "signature", at, data })

describe("signature styles", () => {
	it("are the office signature fonts, in their order, the first the default", () => {
		expect(OFFICE_SIGNATURE_FONTS.map(font => font.id)).toEqual([...SIGNATURE_STYLES])
		expect(DEFAULT_SIGNATURE_STYLE).toBe(SIGNATURE_STYLES[0])

		for (const style of SIGNATURE_STYLES) {
			const font = signatureStyleFont(style)

			// Served from the office font assets, never a third-party origin.
			expect(font.url).toMatch(/^\/office\/fonts\/[a-z-]+\/[A-Za-z-]+\.woff2$/u)
			expect(font.ranges[0]).toEqual([0x20, 0x7e])
			// Each style falls back to Gelasio Italic, then the system serif.
			expect(signatureFontFamily(style)).toBe(`"Filen Signature ${style}", "${SIGNATURE_FALLBACK_FAMILY}", serif`)
		}
	})

	it("parses a unicode-range into sorted code point pairs", () => {
		expect(parseUnicodeRange("U+0100-017F,U+0020-007E, U+00E9 ,junk")).toEqual([
			[0x20, 0x7e],
			[0xe9, 0xe9],
			[0x100, 0x17f]
		])
	})

	it("draws German, French, Polish and Romanian names in every style without the fallback", () => {
		for (const style of SIGNATURE_STYLES) {
			for (const name of ["Zoë Łukasz Ştefan", "Jürgen Größe", "François Œuvre", "Żółć Dvořák", "Șerban Țară"]) {
				expect(needsSignatureFallback(name, style), `${style}: ${name}`).toBe(false)
			}
		}
	})

	it("needs the fallback for what a style lacks", () => {
		// Dancing Script has no long s, Ms Madi no ĳ ligature; no style has Cyrillic or CJK.
		expect(needsSignatureFallback("ſ", "dancing-script")).toBe(true)
		expect(needsSignatureFallback("ſ", "pinyon-script")).toBe(false)
		expect(needsSignatureFallback("Rĳn", "ms-madi")).toBe(true)
		expect(needsSignatureFallback("Rĳn", "dancing-script")).toBe(false)

		for (const style of SIGNATURE_STYLES) {
			expect(needsSignatureFallback("Жанна", style)).toBe(true)
			expect(needsSignatureFallback("山田", style)).toBe(true)
			// Control characters are not drawn.
			expect(needsSignatureFallback("A\tB", style)).toBe(false)
		}
	})

	it("starts on the style of the newest saved typed signature", () => {
		expect(rememberedSignatureStyle([])).toBe(DEFAULT_SIGNATURE_STYLE)
		expect(
			rememberedSignatureStyle([
				saved("drawn", 4, { kind: "strokes", width: 10, height: 10, strokes: [[0, 0, 10, 10]] }),
				// A picture, or a name typed before styles existed (in Gelasio Italic): no style to remember.
				saved("picture", 3, { kind: "image", width: 10, height: 5, png: "AAAA" }),
				saved("unknown", 2, { kind: "image", width: 10, height: 5, png: "AAAA", style: "a-later-style" }),
				saved("typed", 1, { kind: "image", width: 10, height: 5, png: "AAAA", style: "ms-madi" })
			])
		).toBe("ms-madi")
		expect(rememberedSignatureStyle([saved("picture", 3, { kind: "image", width: 10, height: 5, png: "AAAA" })])).toBe(
			DEFAULT_SIGNATURE_STYLE
		)
	})
})
