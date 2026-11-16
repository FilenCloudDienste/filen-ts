import type * as Mupdf from "mupdf"
import { decodeFace } from "../../core/pdfwrite/fonts/assets"
import { FALLBACK_FAMILIES, type FallbackFamily, type PdfFaceFile } from "../../core/pdfwrite/fonts/faces.generated"
import type { MupdfModule } from "./protocol"

// The read role's fallback faces: MuPDF's wasm embeds no face for Arabic, Hebrew, Indic or CJK text, and asks its font
// hook for one when a book's text needs it. The hook answers from the office PDF writer's bundled faces, fetched
// synchronously (a worker request cannot await) once per face, and keeps only the MuPDF Font. Installed by the read
// role's open alone: the hook is module-global, and the edit and verify roles never draw with it.

export interface ReadFontSource {
	// A face file's body (gzip'd, or already decoded by the server), from the app's own origin. Throws when it cannot.
	fetchSync(file: string): Uint8Array
	// A face that could not be had (its text shows as missing glyphs), once per face.
	readonly onError?: (file: string, error: unknown) => void
}

const NOTO_SC = "noto-sans-sc"
const NOTO_TC = "noto-sans-tc"
const NOTO_JP = "noto-sans-jp"
const NOTO_KR = "noto-sans-kr"

// MuPDF's names for the scripts it asks a face for, to the family that draws them. Han, kana, hangul and bopomofo come
// as the CJK face MuPDF picked by the text's language: JP, KR, SC or TC (TC is also its pick for Han text that names no
// language, decided by hanFamily).
export const SCRIPT_FAMILY: Readonly<Record<string, string>> = {
	Arabic: "noto-naskh-arabic",
	Hebrew: "noto-sans-hebrew",
	Armenian: "noto-sans-armenian",
	Georgian: "noto-sans-georgian",
	Ethiopic: "noto-sans-ethiopic",
	Devanagari: "noto-sans-devanagari",
	Bengali: "noto-sans-bengali",
	Gurmukhi: "noto-sans-gurmukhi",
	Gujarati: "noto-sans-gujarati",
	Oriya: "noto-sans-oriya",
	Tamil: "noto-sans-tamil",
	Telugu: "noto-sans-telugu",
	Kannada: "noto-sans-kannada",
	Malayalam: "noto-sans-malayalam",
	Sinhala: "noto-sans-sinhala",
	Thai: "noto-sans-thai",
	Lao: "noto-sans-lao",
	JP: NOTO_JP,
	KR: NOTO_KR,
	SC: NOTO_SC,
	TC: NOTO_TC
}

// MuPDF's TC: by the book's language (BCP 47) when the page knows it; otherwise Simplified Chinese, whose face also holds
// the Traditional forms (the Traditional face lacks many Simplified ones).
export function hanFamily(language: string | undefined): string {
	const [primary, ...subtags] = (language ?? "").toLowerCase().split(/[-_]/)

	if (primary === "ja") return NOTO_JP
	if (primary === "ko") return NOTO_KR
	if (primary === "zh" && subtags.some(subtag => subtag === "hant" || subtag === "tw" || subtag === "hk" || subtag === "mo"))
		return NOTO_TC

	return NOTO_SC
}

export function readFontFamily(script: string, language: string | undefined): FallbackFamily | null {
	const id = script === "TC" ? hanFamily(language) : Object.hasOwn(SCRIPT_FAMILY, script) ? SCRIPT_FAMILY[script] : undefined

	return id === undefined ? null : (FALLBACK_FAMILIES.find(family => family.id === id) ?? null)
}

// The family's face nearest the asked weight, upright before italic unless italic was asked.
function faceFor(family: FallbackFamily, bold: boolean, italic: boolean): PdfFaceFile | null {
	const weight = bold ? 700 : 400
	let best: PdfFaceFile | null = null
	let bestScore = Number.POSITIVE_INFINITY

	for (const face of family.faces) {
		const score = Math.abs(face.weight - weight) + (face.italic === italic ? 0 : 1000)

		if (score < bestScore) {
			best = face
			bestScore = score
		}
	}

	return best
}

// Installs the hook; returns its removal, which also drops the faces it made (MuPDF keeps its own reference to a face it
// still uses).
export function installReadFontHook(mupdf: MupdfModule, options: ReadFontSource & { readonly language?: string | undefined }): () => void {
	// By face file; null: it could not be had (fetch or decode failed), so its text shows as missing glyphs.
	const fonts = new Map<string, Mupdf.Font | null>()

	mupdf.installLoadFontFunction((_name, script, bold, italic) => {
		const family = readFontFamily(script, options.language)
		const face = family === null ? null : faceFor(family, bold, italic)

		if (family === null || face === null) return null

		let font = fonts.get(face.file)

		if (font === undefined) {
			try {
				font = new mupdf.Font(family.id, decodeFace(options.fetchSync(face.file), face))
			} catch (error) {
				font = null
				options.onError?.(face.file, error)
			}

			fonts.set(face.file, font)
		}

		return font
	})

	return () => {
		mupdf.installLoadFontFunction(() => null)

		for (const font of fonts.values()) font?.destroy()

		fonts.clear()
	}
}
