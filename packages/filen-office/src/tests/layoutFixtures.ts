import { readFileSync } from "node:fs"
import {
	DocumentLayout,
	PropertyResolver,
	PropsStore,
	buildDocxModel,
	layoutDocument,
	openDocxPackage,
	parseNumbering,
	parseStyles,
	parseTheme,
	styleSettings,
	type DocxModel,
	type DocxOpenFailure,
	type FontSource,
	type LayoutOptions,
	type StyleSettings
} from "@filen/office/core/docx"
import {
	FontManager,
	bundledFace,
	readDocxFontTable,
	readSfnt,
	type BundledFamily,
	type FontRequest,
	type ResolvedFont,
	type SfntFont
} from "@filen/office/core/fonts"
import { bytesSource } from "@filen/office/core/opc"
import { LINE_FLOATS, LINE_INTS, LineInt, type FontExtents, type TextMeasurer } from "@filen/office/core/text"
import { ASSETS } from "../scripts/fontTables"
import { sfntFromWoff2 } from "../scripts/woff2Tables"

// Deterministic layout without a browser: advance widths from the bundled OFL fonts' hmtx tables (no
// kerning, no shaping), faces picked from the CSS font string the layout asks for.

interface Face {
	readonly font: SfntFont
	readonly advances: Float32Array
}

const faces = new Map<string, Face>()

function face(file: string): Face {
	let loaded = faces.get(file)

	if (loaded === undefined) {
		const font = readSfnt(sfntFromWoff2(new Uint8Array(readFileSync(`${ASSETS}${file}`))))

		loaded = { font, advances: new Float32Array(0x10000).fill(-1) }
		faces.set(file, loaded)
	}

	return loaded
}

const CSS = /^(italic )?(\d+) ([\d.]+)px (?:"([^"]+)", )?([a-z-]+)$/
const GENERIC: Readonly<Record<string, BundledFamily>> = { serif: "tinos", "sans-serif": "arimo", monospace: "cousine" }
const FAMILIES = new Set<string>(["carlito", "caladea", "arimo", "tinos", "cousine", "gelasio", "selawik"])

export class HmtxMeasurer implements TextMeasurer {
	readonly kerningControl = true
	calls = 0
	private readonly parsed = new Map<string, { face: Face; size: number }>()

	private resolve(css: string): { face: Face; size: number } {
		let parsed = this.parsed.get(css)

		if (parsed === undefined) {
			const match = CSS.exec(css)
			const italic = match?.[1] !== undefined
			const weight = Number(match?.[2] ?? "400")
			const size = Number(match?.[3] ?? "16")
			const alias = match?.[4]
			const generic = match?.[5] ?? "serif"
			const suffix = alias === undefined ? "" : alias.slice(alias.lastIndexOf("-") + 1)
			const family = (FAMILIES.has(suffix) ? suffix : (GENERIC[generic] ?? "tinos")) as BundledFamily
			const bundled = bundledFace(family, weight, italic) ?? bundledFace("tinos", 400, false)

			if (bundled === undefined) throw new Error(`No face for ${css}`)

			parsed = { face: face(bundled.file), size }
			this.parsed.set(css, parsed)
		}

		return parsed
	}

	measure(font: string, _kerning: boolean, texts: readonly string[], count: number, widths: Float64Array): void {
		const { face, size } = this.resolve(font)
		const scale = size / face.font.unitsPerEm
		const advances = face.advances

		this.calls++

		for (let i = 0; i < count; i++) {
			const text = texts[i] ?? ""
			let sum = 0

			for (let k = 0; k < text.length; k++) {
				let c = text.charCodeAt(k)

				if (c >= 0xd800 && c < 0xdc00 && k + 1 < text.length) {
					sum += face.font.advanceOf(text.codePointAt(k) ?? 0)
					k++

					continue
				}

				// Soft hyphens draw nothing unless a line breaks there; word joiners have no width.
				if (c === 0xad || c === 0x200b || c === 0x2060 || c === 0xfeff) continue

				if (c === 0xa0) c = 0x20

				let advance = advances[c] ?? -1

				if (advance < 0) {
					advance = face.font.advanceOf(c)
					advances[c] = advance
				}

				sum += advance
			}

			widths[i] = sum * scale
		}
	}

	fontExtents(font: string): FontExtents {
		const { face, size } = this.resolve(font)
		const m = face.font.metrics

		return { ascent: (m.winAscent / m.unitsPerEm) * size, descent: (m.winDescent / m.unitsPerEm) * size }
	}
}

export const nodeFontHost = {
	addBytes: (): Promise<boolean> => Promise.resolve(true),
	addLocal: (): Promise<boolean> => Promise.resolve(false),
	remove: (): void => undefined
}

export const nodeFontAssets = { read: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(4)) }

// A font source that changes what the manager resolves (calibration experiments).
export function adjustedFonts(manager: FontManager, adjust: (request: FontRequest, font: ResolvedFont) => ResolvedFont): FontSource {
	const cache = new Map<ResolvedFont, ResolvedFont>()

	return {
		prepare: requests => manager.prepare(requests),
		resolve: request => {
			const font = manager.resolve(request)
			let adjusted = cache.get(font)

			if (adjusted === undefined || adjusted.family !== font.family) {
				adjusted = adjust(request, font)
				cache.set(font, adjusted)
			}

			return adjusted
		}
	}
}

export interface LoadedDocx {
	readonly model: DocxModel
	readonly resolver: PropertyResolver
	readonly store: PropsStore
	readonly fonts: FontManager
}

// A package openDocxPackage refused, with its reason; the message is `${reason}: ${message}`.
export class DocxRefusedError extends Error {
	readonly reason: DocxOpenFailure

	constructor(reason: DocxOpenFailure, message: string) {
		super(`${reason}: ${message}`)

		this.reason = reason
	}
}

// `settings` adjusts what the resolver reads from settings.xml (experiments on undocumented defaults).
export async function loadDocx(bytes: Uint8Array, settings?: (settings: StyleSettings) => StyleSettings): Promise<LoadedDocx> {
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) throw new DocxRefusedError(opened.reason, opened.message)

	const pkg = opened.package
	const model = await buildDocxModel(pkg)
	const store = new PropsStore()
	const optional = async (kind: string) => {
		const name = pkg.part(kind)

		if (name === undefined) return undefined

		try {
			return await pkg.xml(name)
		} catch {
			return undefined
		}
	}
	const stylesXml = await optional("styles")
	const styles = stylesXml === undefined ? undefined : parseStyles(stylesXml, store)
	const numberingXml = await optional("numbering")
	const numbering = numberingXml === undefined ? undefined : parseNumbering(numberingXml, store, styles)
	const themeXml = await optional("theme")
	const theme = themeXml === undefined ? undefined : parseTheme(themeXml)
	const fontTable = await optional("fontTable")
	const fonts = new FontManager(nodeFontHost, nodeFontAssets, undefined, "fotest")

	if (fontTable !== undefined) fonts.declare(readDocxFontTable(fontTable))

	const base = styleSettings(model.settings)
	const resolver = new PropertyResolver({ styles, numbering, theme, settings: settings === undefined ? base : settings(base) })

	return { model, resolver, store, fonts }
}

// The time DATE and TIME fields show where two layouts of a document are compared (an editor's and a fresh one
// of its save, a baseline and a later run): layout otherwise reads the wall clock as it starts.
export const LAYOUT_DATE = Date.UTC(2026, 0, 1)

export async function layOut(
	bytes: Uint8Array,
	options: LayoutOptions = {},
	fonts?: (manager: FontManager) => FontSource,
	settings?: (settings: StyleSettings) => StyleSettings
): Promise<DocumentLayout & { loaded: LoadedDocx }> {
	const loaded = await loadDocx(bytes, settings)
	const layout = layoutDocument(loaded.model, loaded.resolver, fonts?.(loaded.fonts) ?? loaded.fonts, new HmtxMeasurer(), {
		sliceMs: Infinity,
		store: loaded.store,
		...options
	})

	await layout.done

	return Object.assign(layout, { loaded })
}

export function readBytes(path: string): Uint8Array {
	return new Uint8Array(readFileSync(path))
}

export interface LineInfo {
	readonly text: string
	readonly top: number
	readonly bottom: number
	readonly x: number
	readonly width: number
	readonly region: number
	readonly flags: number
}

// The lines of a page with their text, in display-list order.
export function pageLines(layout: DocumentLayout, index: number): LineInfo[] {
	const page = layout.pages[index]

	if (page === undefined) return []

	const text = page.text
	const out: LineInfo[] = []

	for (let line = 0; line < text.lineCount; line++) {
		const f = line * LINE_FLOATS
		const i = line * LINE_INTS
		const source = text.lineInts[i + LineInt.SOURCE] ?? 0
		const top = text.lineFloats[f] ?? 0

		out.push({
			text: (page.sourceTexts[source] ?? "").slice(
				text.lineInts[i + LineInt.TEXT_START] ?? 0,
				text.lineInts[i + LineInt.TEXT_END] ?? 0
			),
			top,
			bottom: top + (text.lineFloats[f + 1] ?? 0),
			x: text.lineFloats[f + 3] ?? 0,
			width: text.lineFloats[f + 4] ?? 0,
			region: page.sourceRegion(source),
			flags: text.lineInts[i + LineInt.FLAGS] ?? 0
		})
	}

	return out
}

// A fingerprint of every page's display list (geometry, text and sources), to compare two layouts.
export function layoutDigest(layout: DocumentLayout, from = 0): string[] {
	return layout.pages.slice(from).map(page => {
		let hash = 0
		const mix = (values: ArrayLike<number>): void => {
			for (let i = 0; i < values.length; i++) hash = (Math.imul(hash, 31) + Math.round((values[i] ?? 0) * 100)) | 0
		}

		mix(page.text.lineFloats)
		mix(page.text.lineInts)
		mix(page.text.fragmentFloats)
		mix(page.text.fragmentInts)
		mix(page.graphicFloats)
		mix(page.objectFloats)
		mix(page.sourceInts)

		return `${page.number}:${page.text.lineCount}:${hash}:${page.sourceTexts.join("|").length}`
	})
}
