// The Font group's editable boxes: what a typed size or font name applies.

// Word's size range, 1 to 1638 pt in half-point steps (w:sz is ST_HpsMeasure, half-points).
export const DOCX_MIN_HALF_POINTS = 2
export const DOCX_MAX_HALF_POINTS = 3276

const SIZE_TEXT = /^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/u

// A size typed in points (either decimal separator) as half-points, rounded to the nearest half point; null for text
// that is no size or one outside Word's range (the box then shows the size in effect again; nothing is clamped).
export function parseFontSize(text: string): number | null {
	const trimmed = text.trim()

	if (!SIZE_TEXT.test(trimmed)) {
		return null
	}

	const halfPoints = Math.round(Number(trimmed.replace(",", ".")) * 2)

	return halfPoints >= DOCX_MIN_HALF_POINTS && halfPoints <= DOCX_MAX_HALF_POINTS ? halfPoints : null
}

export interface DocxFontItem {
	// What font.family takes.
	value: string
	label: string
}

// The listed font whose label is exactly what is typed (any case), by its value.
export function listedFont(text: string, items: readonly DocxFontItem[]): string | undefined {
	const lower = text.trim().toLocaleLowerCase()

	return items.find(item => item.label.toLocaleLowerCase() === lower)?.value
}

// A font name typed: a listed font it names, else the name itself, as Word applies a font that is not installed; null
// for nothing typed.
export function typedFont(text: string, items: readonly DocxFontItem[]): string | null {
	const name = text.trim()

	return name === "" ? null : (listedFont(name, items) ?? name)
}

// Whether a font's label matches what is typed: a word of it starts so (any case), as "light" finds Calibri Light.
export function fontMatches(label: string, query: string): boolean {
	const lower = label.toLocaleLowerCase()
	const typed = query.trim().toLocaleLowerCase()

	return lower.startsWith(typed) || lower.includes(` ${typed}`)
}
