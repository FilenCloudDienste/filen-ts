import type { FallbackFamily, PdfFaceFile } from "@filen/office/core/pdfwrite/fonts"

// The fonts a DXF drawing's text is drawn with: the bundled office faces (gzip'd TrueType, which opentype.js reads once
// decompressed). dxf-viewer loads them in order, each only once a character is missing from every font before it, and
// a character no font has loads all of them; so a drawing is offered the sans face plus only the fallbacks for the
// characters its drawn text holds (dxfText.logic reads them).

// Distinct characters collected at most: a drawing's text uses a few hundred.
export const DXF_MAX_CODE_POINTS = 65_536

// What MIF escapes (\M+n followed by a two-byte code, pre-Unicode drawings) stand for, by codepage digit: a character of
// that script, so its fallback is offered.
const MIF_SAMPLES: ReadonlyMap<string, number> = new Map([
	["1", 0x3042],
	["2", 0x7e41],
	["3", 0xac00],
	["4", 0xac00],
	["5", 0x4e2d]
])

// Collects the characters past ASCII drawn text may hold, one text value at a time: those written out, those written
// as \U+XXXX or MIF escapes, and the diameter sign %%c stands for. The escapes are ASCII, so they stand whatever the
// file's encoding turns out to be; the written ones only in the encoding they were decoded with.
export class DxfCodePoints {
	private readonly written = new Set<number>()
	private readonly escaped = new Set<number>()

	public add(value: string): void {
		for (const [char] of value.matchAll(/[\u0080-\u{10ffff}]/gu)) {
			this.note(this.written, char.codePointAt(0) ?? 0)
		}

		for (const match of value.matchAll(/\\U\+([0-9A-Fa-f]{4})|\\M\+([1-5])|%%[cC]/g)) {
			if (match[1] !== undefined) this.note(this.escaped, Number.parseInt(match[1], 16))
			else if (match[2] !== undefined) this.note(this.escaped, MIF_SAMPLES.get(match[2]) ?? 0)
			else this.note(this.escaped, 0x2205)
		}
	}

	// `written`: whether the characters written out count (false once the decode they came from was found wrong).
	public codePoints(written = true): ReadonlySet<number> {
		return written ? new Set([...this.escaped, ...this.written]) : this.escaped
	}

	private note(into: Set<number>, cp: number): void {
		if (cp >= 0x80 && this.written.size + this.escaped.size < DXF_MAX_CODE_POINTS) into.add(cp)
	}
}

// A family's script codes as one pattern: Unicode scripts by Script_Extensions, the symbol and math families by
// category. A code no engine knows is left out.
function familyPattern(family: FallbackFamily): RegExp | null {
	const parts = family.scripts.flatMap(script => {
		const part = script === "Zsym" ? "\\p{So}" : script === "Zmth" ? "\\p{Sm}" : `\\p{scx=${script}}`

		try {
			new RegExp(part, "u").test("")

			return [part]
		} catch {
			return []
		}
	})

	return parts.length === 0 ? null : new RegExp(parts.join("|"), "u")
}

// A family's upright regular face (drawings name no weights the viewer draws).
export function regularFace(faces: readonly PdfFaceFile[]): PdfFaceFile | undefined {
	return faces.find(face => face.weight === 400 && !face.italic) ?? faces[0]
}

// `primary` first, then, in the families' own order, the first family covering each collected character.
export function dxfFontFaces(codePoints: ReadonlySet<number>, primary: PdfFaceFile, families: readonly FallbackFamily[]): PdfFaceFile[] {
	const patterns = families.map(familyPattern)
	const wanted = new Set<number>()

	for (const cp of codePoints) {
		const char = String.fromCodePoint(cp)
		const index = patterns.findIndex(pattern => pattern?.test(char) === true)

		if (index !== -1) wanted.add(index)
	}

	const faces = [primary]

	families.forEach((family, index) => {
		const face = wanted.has(index) ? regularFace(family.faces) : undefined

		if (face !== undefined) faces.push(face)
	})

	return faces
}
