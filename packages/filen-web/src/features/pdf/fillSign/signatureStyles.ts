import { OFFICE_SIGNATURE_FONTS } from "virtual:office-signature-fonts"
import type { SavedPdfSignature } from "@filen/shared/pdfSignatures"

// The handwriting styles a typed signature is drawn in: @filen/office's signature fonts (assets/fonts/manifest.json
// "signatures", in its order; the first is the default). A character a style's font lacks is drawn by the fallback
// family (Gelasio Italic) instead, never as a missing-glyph box: each face is registered with the unicode-range of its
// cmap, so the browser skips it for any other character.

export const SIGNATURE_STYLES = ["dancing-script", "ms-madi", "pinyon-script"] as const

export type SignatureStyle = (typeof SIGNATURE_STYLES)[number]

export const DEFAULT_SIGNATURE_STYLE: SignatureStyle = "dancing-script"

export const SIGNATURE_FALLBACK_FAMILY = "Filen Signature Fallback"

export function isSignatureStyle(value: unknown): value is SignatureStyle {
	return SIGNATURE_STYLES.some(style => style === value)
}

export function signatureStyleFamily(style: SignatureStyle): string {
	return `Filen Signature ${style}`
}

// The CSS font-family list a style is drawn with, in the dialog's previews and on the canvas alike.
export function signatureFontFamily(style: SignatureStyle): string {
	return `"${signatureStyleFamily(style)}", "${SIGNATURE_FALLBACK_FAMILY}", serif`
}

export interface SignatureStyleFont {
	readonly url: string
	readonly unicodeRange: string
	// Sorted, disjoint [first, last] code point pairs.
	readonly ranges: readonly (readonly [number, number])[]
}

// "U+0020-007E,U+00A0" as code point pairs.
export function parseUnicodeRange(range: string): (readonly [number, number])[] {
	return range
		.split(",")
		.map(part => /^\s*U\+([0-9A-Fa-f]{1,6})(?:-([0-9A-Fa-f]{1,6}))?\s*$/u.exec(part))
		.flatMap(match => {
			if (match === null) return []

			const first = Number.parseInt(match[1] ?? "", 16)
			const last = match[2] === undefined ? first : Number.parseInt(match[2], 16)

			return [[first, last] as const]
		})
		.sort((a, b) => a[0] - b[0])
}

const fonts = new Map<SignatureStyle, SignatureStyleFont>()

export function signatureStyleFont(style: SignatureStyle): SignatureStyleFont {
	const cached = fonts.get(style)

	if (cached !== undefined) return cached

	const entry = OFFICE_SIGNATURE_FONTS.find(font => font.id === style)

	if (entry === undefined) throw new Error(`signature font ${style} missing`)

	const font: SignatureStyleFont = { url: entry.url, unicodeRange: entry.unicodeRange, ranges: parseUnicodeRange(entry.unicodeRange) }

	fonts.set(style, font)

	return font
}

function covers(ranges: readonly (readonly [number, number])[], codePoint: number): boolean {
	let low = 0
	let high = ranges.length - 1

	while (low <= high) {
		const middle = (low + high) >> 1
		const range = ranges[middle]

		if (range === undefined) return false
		if (codePoint < range[0]) high = middle - 1
		else if (codePoint > range[1]) low = middle + 1
		else return true
	}

	return false
}

// Whether `text` has a character the style's font lacks (control characters aside), which the fallback then draws.
export function needsSignatureFallback(text: string, style: SignatureStyle): boolean {
	const { ranges } = signatureStyleFont(style)

	for (const character of text) {
		const codePoint = character.codePointAt(0) ?? 0

		if (codePoint >= 0x20 && !covers(ranges, codePoint)) return true
	}

	return false
}

// The style the newest saved typed signature of a list (newest first) was drawn in; the default without one.
export function rememberedSignatureStyle(saved: readonly SavedPdfSignature[]): SignatureStyle {
	for (const item of saved) {
		if (item.data.kind === "image" && isSignatureStyle(item.data.style)) return item.data.style
	}

	return DEFAULT_SIGNATURE_STYLE
}
