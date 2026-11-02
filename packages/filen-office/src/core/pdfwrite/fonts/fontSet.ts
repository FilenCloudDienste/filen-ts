import { appendAll } from "../../arrays"
import type { PdfFaceSource } from "../../fonts/manager"
import { BIDI_REMOVED, BidiResolver, applyL1, hasRightToLeft, reorder } from "../../text/bidi"
import { readSfnt, type SfntFont } from "../../fonts/sfnt"
import type { FontSlot } from "../../fonts/slots"
import { NO_HINTS, SUBSTITUTIONS, fallbackFor, type BundledFamily } from "../../fonts/substitutes"
import type { PdfRef } from "../objects"
import type { PdfObjectSink } from "../writer"
import { readFace, type PdfFontAssets } from "./assets"
import { FALLBACK_FAMILIES, PDF_FACES, type FallbackFamily, type PdfFaceFile } from "./faces.generated"
import { INDIC_SHAPER } from "./indic"
import { EmbeddedPdfFont } from "./pdfFont"
import { ShapingFace, registerIndicShaper } from "./shape"
import { checkTrueTypeSubset } from "./subset"
import { SCRIPT_CODES } from "./shaping.generated"
import { SCRIPT_COMMON, SCRIPT_INHERITED, codePointAt, isDefaultIgnorable, isMark, scriptCode, scriptOf, type ScriptCode } from "./unicode"

registerIndicShaper(INDIC_SHAPER)

// The fonts of one PDF export: resolves each fragment's font to an embeddable face, falls back per grapheme
// to a Noto family when the face lacks the script, shapes, and records glyph use and text for the Type0
// fonts written after the pages. Faces load on demand (prepare) and are released by close().

export interface PdfFontFaceRequest {
	// Document family name, as FontRequest.family.
	readonly family: string
	readonly bold: boolean
	readonly italic: boolean
	readonly slot: FontSlot
	// BCP 47 (w:lang): picks the CJK fallback and the OpenType language system.
	readonly language?: string | undefined
}

// Fragment flag bits (FragmentFlag in core/text/displayList).
export const SHAPE_CAPS = 0x10
export const SHAPE_SMALL_CAPS = 0x20
export const SHAPE_HYPHEN = 0x40

export interface PdfShapeOptions {
	// Bidi embedding level of the fragment (odd: right to left).
	readonly level: number
	// CAPS, SMALL_CAPS (upper-cased here; the writer draws at the small-caps size) and HYPHEN bits.
	readonly flags: number
	// Resolve bidi levels inside the text (base direction from `level`), for text no layout ordered (sheet
	// cells). Layout fragments have one level each and leave this off.
	readonly bidi?: boolean
}

export interface PdfFont {
	readonly unitsPerEm: number
	readonly postScriptName: string
	advance(glyph: number): number
	write(sink: PdfObjectSink, ref: PdfRef): Promise<void>
	close(): void
}

export interface PdfGlyphRun {
	readonly font: PdfFont
	// Character codes (CIDs) in visual order.
	readonly glyphs: Uint16Array
	// 1/1000 em, GSUB and GPOS applied.
	readonly advances: Float32Array
	readonly dx: Float32Array | null
	readonly dy: Float32Array | null
	// Per glyph, the UTF-16 offset of its cluster from the fragment start.
	readonly clusters: Uint32Array
	// Set when ToUnicode cannot reproduce the run's text: the run's text in logical order.
	readonly actualText: string | undefined
	// The face is regular or upright where the request asked for bold or italic: draw emboldened or slanted.
	readonly fauxBold: boolean
	readonly fauxItalic: boolean
}

export interface PdfShapedText {
	readonly runs: readonly PdfGlyphRun[]
	// Sum of the advances, 1/1000 em.
	readonly width: number
}

export type PdfFaceResolver = (request: PdfFontFaceRequest) => PdfFaceSource

export interface PdfFontSetOptions {
	readonly assets: PdfFontAssets
	// Where each request's face comes from; the default maps family names to the bundled substitutes. Pass
	// `request => manager.pdfFace(request)` to embed what the document's FontManager drew with.
	readonly resolve?: PdfFaceResolver
	readonly deterministic?: boolean
	readonly signal?: { readonly aborted: boolean }
	readonly maxEmbeddedFaceBytes?: number
}

export class PdfFontLoadError extends Error {
	constructor(face: string, cause: unknown) {
		super(`The font ${face} could not be loaded`, { cause })
	}
}

// OS/2 fsType: Restricted License embedding, and Bitmap embedding only.
const RESTRICTED = 0x0002
const BITMAP_ONLY = 0x0200
const DEFAULT_MAX_EMBEDDED = 32 * 1024 * 1024
const CJK = new Set(["Hani", "Hira", "Kana", "Hang", "Bopo"])

interface Face {
	readonly key: string
	readonly weight: number
	readonly italic: boolean
	load: Promise<void> | null
	state: "pending" | "ready" | "failed"
	shaping: ShapingFace | null
	pdf: EmbeddedPdfFont | null
}

interface Resolved {
	readonly primary: Face
	readonly weight: number
	readonly italic: boolean
}

export class PdfFontSet {
	private readonly assets: PdfFontAssets
	private readonly resolver: PdfFaceResolver
	private readonly signal: { readonly aborted: boolean } | undefined
	private readonly maxEmbedded: number
	private readonly faces = new Map<string, Face>()
	private readonly resolved = new Map<string, Resolved>()
	private readonly used: EmbeddedPdfFont[] = []
	private readonly usedSet = new Set<EmbeddedPdfFont>()
	private readonly missingByScript = new Map<string, number>()
	private unshapedRuns = 0
	private closed = false

	constructor(options: PdfFontSetOptions) {
		this.assets = options.assets
		this.resolver = options.resolve ?? defaultResolver
		this.signal = options.signal
		this.maxEmbedded = options.maxEmbeddedFaceBytes ?? DEFAULT_MAX_EMBEDDED
	}

	// Loads what shaping text[start, end) needs. Undefined when everything is loaded already.
	prepare(text: string, start: number, end: number, request: PdfFontFaceRequest): Promise<void> | undefined {
		this.live()

		const resolved = this.resolve(request)

		if (resolved.primary.state !== "ready")
			return this.loadPrimary(resolved.primary).then(() => this.prepare(text, start, end, request))

		const needed = this.fallbacksNeeded(text, start, end, request, resolved)
		const loads = needed.filter(face => face.state === "pending").map(face => this.loadFace(face))

		return loads.length === 0 ? undefined : Promise.all(loads).then(() => this.prepare(text, start, end, request))
	}

	shape(text: string, start: number, end: number, request: PdfFontFaceRequest, options: PdfShapeOptions): PdfShapedText {
		this.live()

		const resolved = this.resolve(request)
		const runs: PdfGlyphRun[] = []
		const rtl = (options.level & 1) === 1

		if (options.bidi !== true || (!rtl && !hasRightToLeft(text, start, end))) {
			const width = this.shapeLevel(text, start, end, start, request, resolved, rtl, options.flags, runs)

			return { runs, width }
		}

		// Text without a layout of its own (a sheet cell): bidi levels per UAX #9, each level run shaped in
		// its direction, the runs in visual order (L2).
		const count = end - start
		const levels = new Uint8Array(count)
		const paragraph = (this.bidi ??= new BidiResolver()).resolve(text, start, end, rtl ? "rtl" : "ltr", levels)

		applyL1(text, start, levels, 0, count, paragraph)

		const segments: [number, number, number][] = []
		let previous = paragraph

		for (let k = 0; k < count;) {
			const level = levels[k] === BIDI_REMOVED ? previous : (levels[k] ?? paragraph)
			let next = k + 1

			while (next < count && (levels[next] === level || levels[next] === BIDI_REMOVED)) next++

			segments.push([start + k, start + next, level])
			previous = level
			k = next
		}

		const segmentLevels = Uint8Array.from(segments, segment => segment[2])
		const order = new Int32Array(segments.length)
		let width = 0

		reorder(segmentLevels, 0, segments.length, order)

		for (const index of order) {
			const [from, to, level] = segments[index] ?? [start, start, 0]
			const flags = to === end ? options.flags : options.flags & ~SHAPE_HYPHEN

			width += this.shapeLevel(text, from, to, start, request, resolved, (level & 1) === 1, flags, runs)
		}

		return { runs, width }
	}

	private bidi: BidiResolver | null = null

	// Shapes text[start, end) in one direction, appending runs in visual order; clusters count from `base`.
	private shapeLevel(
		text: string,
		start: number,
		end: number,
		base: number,
		request: PdfFontFaceRequest,
		resolved: Resolved,
		rtl: boolean,
		flags: number,
		out: PdfGlyphRun[]
	): number {
		const input = this.codePoints(text, start, end, flags)
		const count = input.cps.length
		const runs: PdfGlyphRun[] = []
		let width = 0

		// Scripts per code point, Common and Inherited taking the script around them.
		const scripts = resolveScripts(input.cps)
		// Face per code point, decided per grapheme.
		const faceOf: (Face | null)[] = new Array<Face | null>(count).fill(null)

		for (let i = 0; i < count;) {
			let next = i + 1

			while (next < count && (isMark(input.cps[next] ?? 0) || input.cps[next] === 0x200d)) next++

			const face = this.faceFor(input.cps.slice(i, next), scripts[i] ?? 0, request, resolved)

			faceOf.fill(face, i, next)
			i = next
		}

		stickCommonFaces(input.cps, scripts, faceOf, resolved.primary)

		for (let i = 0; i < count;) {
			const face = faceOf[i] ?? resolved.primary
			const script = scripts[i] ?? 0
			let next = i + 1

			while (next < count && faceOf[next] === face && sameRun(scripts[next] ?? 0, script)) next++

			const run = this.shapeRun(face, input, i, next, script, rtl, text, start, end, base, request, resolved)

			if (run !== null) {
				runs.push(run.run)
				width += run.width
			}

			i = next
		}

		if (rtl) runs.reverse()

		appendAll(out, runs)

		return width
	}

	// Every font used so far, in first-use order.
	fonts(): Iterable<PdfFont> {
		return this.used
	}

	// Characters drawn with .notdef because no face has them, by ISO 15924 script.
	missing(): ReadonlyMap<string, number> {
		return this.missingByScript
	}

	// Runs drawn without their font's layout tables because shaping them went past the limits.
	unshaped(): number {
		return this.unshapedRuns
	}

	close(): void {
		if (this.closed) return

		this.closed = true

		for (const font of this.used) font.close()

		this.faces.clear()
		this.resolved.clear()
		this.used.length = 0
		this.usedSet.clear()
	}

	private live(): void {
		if (this.closed) throw new Error("The PDF font set is closed")
	}

	private resolve(request: PdfFontFaceRequest): Resolved {
		const key = `${request.family.toLowerCase()}\u0000${request.bold ? 1 : 0}${request.italic ? 1 : 0}${request.slot}`
		let resolved = this.resolved.get(key)

		if (resolved !== undefined) return resolved

		const source = this.resolver(request)
		const weight = request.bold ? Math.max(700, source.weight) : source.weight
		let primary: Face

		if (source.kind === "embedded" && (source.fsType & (RESTRICTED | BITMAP_ONLY)) === 0) {
			primary = this.embeddedFace(source)
		} else {
			const family = source.kind === "embedded" ? source.substitute : source.family

			primary = this.bundledFace(family, weight, request.italic)
		}

		resolved = { primary, weight, italic: request.italic }
		this.resolved.set(key, resolved)

		return resolved
	}

	private face(key: string, weight: number, italic: boolean, read: () => Promise<Uint8Array>): Face {
		let face = this.faces.get(key)

		if (face === undefined) {
			face = { key, weight, italic, load: null, state: "pending", shaping: null, pdf: null }
			this.faces.set(key, face)
			this.readers.set(face, read)
		}

		return face
	}

	private readonly readers = new WeakMap<Face, () => Promise<Uint8Array>>()

	private bundledFace(family: BundledFamily, weight: number, italic: boolean): Face {
		const file = pickFace(PDF_FACES[family], weight, italic)

		return this.face(`asset:${file.file}`, file.weight, file.italic, () => readFace(this.assets, file, this.signal))
	}

	private embeddedFace(source: Extract<PdfFaceSource, { kind: "embedded" }>): Face {
		const fallback = this.bundledFace(source.substitute, source.weight, source.italic)
		const face = this.face(`embedded:${source.key}`, source.weight, source.italic, () => source.read(this.maxEmbedded))

		this.substitutes.set(face, fallback)

		return face
	}

	// The bundled face an embedded one gives way to when it cannot be used.
	private readonly substitutes = new WeakMap<Face, Face>()

	// Loads a face; a failure leaves it "failed" (an embedded face takes its bundled substitute's place).
	private loadFace(face: Face): Promise<void> {
		if (face.load !== null) return face.load

		const read = this.readers.get(face)

		face.load = (async () => {
			try {
				if (read === undefined) throw new Error("No reader")

				const bytes = await read()
				const sfnt = readSfnt(bytes)

				// CID-keyed CFF has its own CID order, never mixed with glyph ids: the substitute draws instead.
				if (sfnt.cff && cidKeyedCff(sfnt)) throw new Error("CID-keyed CFF")
				if (face.key.startsWith("embedded:") && (sfnt.fsType & (RESTRICTED | BITMAP_ONLY)) !== 0) throw new Error("Restricted")

				// What subsetting reads must be there now, not when the font is written at the end.
				if (!sfnt.cff) checkTrueTypeSubset(sfnt)

				face.shaping = new ShapingFace(sfnt)
				face.pdf = new EmbeddedPdfFont(sfnt)
				face.state = "ready"
			} catch (error) {
				face.state = "failed"
				this.errors.set(face, error)

				const substitute = this.substitutes.get(face)

				if (substitute === undefined) return

				await this.loadFace(substitute)
				face.shaping = substitute.shaping
				face.pdf = substitute.pdf
				face.state = substitute.state
			}
		})()

		return face.load
	}

	private readonly errors = new WeakMap<Face, unknown>()

	// The request's own face must load; fallbacks may fail (their characters then stay .notdef).
	private async loadPrimary(face: Face): Promise<void> {
		await this.loadFace(face)

		if (face.state !== "ready") throw new PdfFontLoadError(face.key, this.errors.get(face))
	}

	// The face for one grapheme: the request's if it has every character, else the script's fallback.
	private faceFor(cps: Uint32Array, script: number, request: PdfFontFaceRequest, resolved: Resolved): Face | null {
		if (covers(resolved.primary, cps)) return resolved.primary

		for (const candidate of this.candidates(cps, script, request, resolved)) {
			if (candidate.state === "ready" && covers(candidate, cps)) return candidate
		}

		return resolved.primary
	}

	private candidates(cps: Uint32Array, script: number, request: PdfFontFaceRequest, resolved: Resolved): Face[] {
		const code = scriptCode(script)
		const out: Face[] = []
		const bold = resolved.weight >= 600

		for (const family of fallbackFamilies(code, request.language, cps[0] ?? 0)) {
			const file = pickFace(family.faces, bold ? 700 : 400, false)

			out.push(this.face(`asset:${file.file}`, file.weight, file.italic, () => readFace(this.assets, file, this.signal)))
		}

		// Symbols and Latin-script letters a decorative or non-Latin face lacks.
		if (out.length === 0 || code === "Zyyy" || code === "Zinh" || code === "Latn" || code === "Grek" || code === "Cyrl") {
			for (const family of ["arimo", "tinos", "cousine"] as const) {
				const face = this.bundledFace(family, resolved.weight, resolved.italic)

				if (face !== resolved.primary) out.push(face)
			}
		}

		return out
	}

	private fallbacksNeeded(text: string, start: number, end: number, request: PdfFontFaceRequest, resolved: Resolved): Face[] {
		const cps = this.codePoints(text, start, end, 0).cps
		const scripts = resolveScripts(cps)
		const needed = new Set<Face>()

		for (let i = 0; i < cps.length;) {
			let next = i + 1

			while (next < cps.length && (isMark(cps[next] ?? 0) || cps[next] === 0x200d)) next++

			const grapheme = cps.subarray(i, next)

			if (!covers(resolved.primary, grapheme)) {
				// The first candidate that is not yet known not to cover it: loaded one at a time, cheapest first.
				for (const candidate of this.candidates(grapheme, scripts[i] ?? 0, request, resolved)) {
					if (candidate.state === "pending") {
						needed.add(candidate)
						break
					}

					if (candidate.state === "ready" && covers(candidate, grapheme)) break
				}
			}

			i = next
		}

		return [...needed]
	}

	private codePoints(
		text: string,
		start: number,
		end: number,
		flags: number
	): { readonly cps: Uint32Array; readonly clusters: Uint32Array } {
		const cps: number[] = []
		const clusters: number[] = []
		const upper = (flags & (SHAPE_CAPS | SHAPE_SMALL_CAPS)) !== 0

		for (let i = start; i < end;) {
			const cp = codePointAt(text, i, end)
			const units = cp > 0xffff ? 2 : 1

			if (upper) {
				for (const char of String.fromCodePoint(cp).toUpperCase()) {
					cps.push(char.codePointAt(0) ?? cp)
					clusters.push(i)
				}
			} else {
				cps.push(cp)
				clusters.push(i)
			}

			i += units
		}

		// The hyphen at a hyphenation break stands for the soft hyphen there, or for an implied one.
		if ((flags & SHAPE_HYPHEN) !== 0) {
			if (cps.length > 0 && cps[cps.length - 1] === 0x00ad) {
				cps[cps.length - 1] = 0x002d
			} else {
				cps.push(0x002d)
				clusters.push(end)
			}
		}

		return { cps: Uint32Array.from(cps), clusters: Uint32Array.from(clusters) }
	}

	private shapeRun(
		face: Face,
		input: { readonly cps: Uint32Array; readonly clusters: Uint32Array },
		from: number,
		to: number,
		script: number,
		rtl: boolean,
		text: string,
		start: number,
		end: number,
		base: number,
		request: PdfFontFaceRequest,
		resolved: Resolved
	): { readonly run: PdfGlyphRun; readonly width: number } | null {
		const shaping = face.shaping
		const pdf = face.pdf

		if (shaping === null || pdf === null) throw new Error("A PDF font was used before prepare() loaded it")

		const shaped = shaping.shape({
			cps: input.cps.subarray(from, to),
			clusters: input.clusters.subarray(from, to),
			count: to - from,
			before: before(text, start, input.cps, from),
			after: after(text, end, input.cps, to),
			script,
			rtl,
			language: request.language
		})
		const buffer = shaped.buffer
		const n = buffer.length

		if (shaped.limited) this.unshapedRuns++
		if (n === 0) return null

		if (!this.usedSet.has(pdf)) {
			this.usedSet.add(pdf)
			this.used.push(pdf)
		}

		const scale = 1000 / pdf.unitsPerEm
		const runStart = input.clusters[from] ?? start
		const runEnd = to < input.clusters.length ? (input.clusters[to] ?? end) : end
		const codes = new Uint16Array(n)
		let simple = true

		// Cluster text spans, in logical order: glyphs grouped by cluster, logical order kept within each.
		const order = Array.from({ length: n }, (_, k) => k)

		order.sort((a, b) => (buffer.cluster[a] ?? 0) - (buffer.cluster[b] ?? 0) || a - b)

		for (let first = 0; first < n;) {
			const clusterStart = buffer.cluster[order[first] ?? 0] ?? runStart
			let last = first + 1

			while (last < n && buffer.cluster[order[last] ?? 0] === clusterStart) last++

			const clusterEnd = Math.max(clusterStart, last < n ? (buffer.cluster[order[last] ?? 0] ?? runEnd) : runEnd)
			const members = order.slice(first, last)
			let clusterText = text.slice(clusterStart, Math.min(clusterEnd, end))

			// The hyphen added at a break has no source character: it stands for a soft hyphen.
			if (clusterStart >= end) clusterText = "­"

			const pieces = piecesFor(clusterText, members, buffer.cp)

			first = last

			if (!pieces.simple) simple = false

			for (let m = 0; m < members.length; m++) {
				const k = members[m] ?? 0
				const glyph = buffer.glyph[k] ?? 0
				const coded = pdf.code(glyph, pieces.texts[m] ?? NO_TEXT)

				if (!coded.exact) simple = false

				codes[k] = coded.code

				if (glyph === 0) {
					const name = scriptCode(scriptOf(buffer.cp[k] ?? 0))

					this.missingByScript.set(name, (this.missingByScript.get(name) ?? 0) + 1)
				}
			}
		}

		// Visual order, pen positions and offsets, 1/1000 em.
		const glyphs = new Uint16Array(n)
		const advances = new Float32Array(n)
		const dx = new Float32Array(n)
		const dy = new Float32Array(n)
		const clusters = new Uint32Array(n)
		let pen = 0
		let anyOffset = false
		let width = 0

		for (let v = 0; v < n; v++) {
			const k = rtl ? n - 1 - v : v
			const advance = (buffer.xAdvance[k] ?? 0) * scale

			glyphs[v] = codes[k] ?? 0
			advances[v] = advance
			dx[v] = (shaped.x[k] ?? 0) * scale - pen
			dy[v] = (shaped.y[k] ?? 0) * scale
			clusters[v] = Math.max(0, (buffer.cluster[k] ?? start) - base)
			pen += advance
			width += advance

			if (Math.abs(dx[v] ?? 0) > 1e-3 || Math.abs(dy[v] ?? 0) > 1e-3) anyOffset = true
		}

		return {
			run: {
				font: pdf,
				glyphs,
				advances,
				dx: anyOffset ? dx : null,
				dy: anyOffset ? dy : null,
				clusters,
				actualText: simple ? undefined : text.slice(runStart, Math.min(runEnd, end)),
				fauxBold: resolved.weight >= 600 && face.weight < 600,
				fauxItalic: resolved.italic && !face.italic
			},
			width
		}
	}
}

// Text for a glyph that only shapes part of a cluster whose text went to its other glyphs: WORD JOINER, a
// format character text extraction drops (pdf.js skips Cf) where an empty ToUnicode string falls back to the
// raw code in some readers. The run's /ActualText still gives the exact text.
const NO_TEXT = "\u2060"

// How a cluster's text is spread over its glyphs (in logical order) so that reading the glyphs' ToUnicode
// text in that order gives the cluster's text. Glyphs that each show their own character keep it; otherwise
// the text is cut into consecutive pieces, and glyphs beyond the characters get NO_TEXT.
function piecesFor(text: string, members: readonly number[], cps: Uint32Array): { readonly texts: string[]; readonly simple: boolean } {
	const count = members.length

	if (count === 1) return { texts: [text === "" ? NO_TEXT : text], simple: text !== "" }

	const own = members.map(k => (cps[k] === 0 ? "" : String.fromCodePoint(cps[k] ?? 0)))

	if (own.every(piece => piece !== "") && own.join("") === text) return { texts: own, simple: true }

	const chars = [...text]
	const last = Math.min(count, chars.length) - 1
	const texts: string[] = []

	for (let m = 0; m < count; m++) {
		if (m < last) texts.push(chars[m] ?? "")
		else if (m === last) texts.push(chars.slice(m).join(""))
		else texts.push(NO_TEXT)
	}

	return { texts, simple: false }
}

const CONTEXT = 8
const CJK_INDICES = new Set(["Hani", "Hira", "Kana", "Bopo"].map(code => SCRIPT_CODES.indexOf(code as ScriptCode)))

// Han, kana and bopomofo shape as one run (one CJK font draws them, with kerning across).
function sameRun(a: number, b: number): boolean {
	return a === b || (CJK_INDICES.has(a) && CJK_INDICES.has(b))
}

// Spaces, punctuation and marks (Common and Inherited) inside text a fallback face draws stay in that face
// when it has them, so a run is not cut into fonts at every space.
function stickCommonFaces(cps: Uint32Array, scripts: Uint8Array, faceOf: (Face | null)[], primary: Face): void {
	const count = cps.length
	const common = (k: number): boolean => {
		const raw = scriptOf(cps[k] ?? 0)

		return raw === SCRIPT_COMMON || raw === SCRIPT_INHERITED
	}

	for (let pass = 0; pass < 2; pass++) {
		const forward = pass === 0

		for (let step = 0; step < count; step++) {
			const k = forward ? step : count - 1 - step
			const neighbour = forward ? k - 1 : k + 1
			const face = faceOf[neighbour]

			if (face === undefined || face === null || face === primary || faceOf[k] !== primary || !common(k)) continue
			if (scripts[k] !== scripts[neighbour] || !covers(face, [cps[k] ?? 0])) continue

			faceOf[k] = face
		}
	}
}

// Code points before a run, nearest first: the fragment's own before it, then the text before the fragment.
function before(text: string, start: number, cps: Uint32Array, from: number): number[] {
	const out: number[] = []

	for (let k = from - 1; k >= 0 && out.length < CONTEXT; k--) out.push(cps[k] ?? 0)

	for (let i = start - 1; i >= 0 && out.length < CONTEXT; i--) {
		const unit = text.charCodeAt(i)

		if (unit >= 0xdc00 && unit <= 0xdfff && i > 0) {
			const high = text.charCodeAt(i - 1)

			if (high >= 0xd800 && high <= 0xdbff) i--
		}

		out.push(codePointAt(text, i, text.length))
	}

	return out
}

// Code points after a run, nearest first.
function after(text: string, end: number, cps: Uint32Array, to: number): number[] {
	const out: number[] = []

	for (let k = to; k < cps.length && out.length < CONTEXT; k++) out.push(cps[k] ?? 0)

	for (let i = end; i < text.length && out.length < CONTEXT;) {
		const cp = codePointAt(text, i, text.length)

		out.push(cp)
		i += cp > 0xffff ? 2 : 1
	}

	return out
}

function covers(face: Face, cps: Uint32Array | readonly number[]): boolean {
	const shaping = face.shaping

	if (face.state !== "ready" || shaping === null) return false

	for (const cp of cps) {
		if (shaping.hasGlyph(cp) || isDefaultIgnorable(cp)) continue

		// The composed or decomposed form counts too.
		const decomposed = String.fromCodePoint(cp).normalize("NFD")

		if (decomposed.length > 1 && [...decomposed].every(char => shaping.hasGlyph(char.codePointAt(0) ?? 0))) continue

		return false
	}

	return true
}

// Scripts per code point: Common and Inherited take the script before them, or after them at the start.
function resolveScripts(cps: Uint32Array): Uint8Array {
	const out = new Uint8Array(cps.length)
	let last = -1

	for (let i = 0; i < cps.length; i++) {
		const script = scriptOf(cps[i] ?? 0)

		out[i] = script

		if (script !== SCRIPT_COMMON && script !== SCRIPT_INHERITED) last = script
		else if (last >= 0) out[i] = last
	}

	let next = -1

	for (let i = cps.length - 1; i >= 0; i--) {
		const script = out[i] ?? 0

		if (script !== SCRIPT_COMMON && script !== SCRIPT_INHERITED) next = script
		else if (next >= 0) out[i] = next
	}

	return out
}

// Noto families for a script, the CJK ones by language: Japanese kana and kanji in JP, Hangul in KR,
// traditional Chinese in TC, everything else Han in SC.
function fallbackFamilies(code: string, language: string | undefined, cp: number): FallbackFamily[] {
	const lang = (language ?? "").toLowerCase()
	let preferred: string | undefined

	if (CJK.has(code) || (code === "Zyyy" && isCjkSymbol(cp))) {
		if (code === "Hang" || lang.startsWith("ko")) preferred = "noto-sans-kr"
		else if (lang.startsWith("ja") || ((code === "Hira" || code === "Kana") && !lang.startsWith("zh"))) preferred = "noto-sans-jp"
		else if (/^zh-(hant|tw|hk|mo)/.test(lang) || code === "Bopo") preferred = "noto-sans-tc"
		else preferred = "noto-sans-sc"

		const order = [preferred, "noto-sans-sc", "noto-sans-jp", "noto-sans-tc", "noto-sans-kr"]

		return [...new Set(order)].map(id => FALLBACK_FAMILIES.find(family => family.id === id)).filter(family => family !== undefined)
	}

	return FALLBACK_FAMILIES.filter(family => family.scripts.includes(code))
}

function isCjkSymbol(cp: number): boolean {
	return (
		(cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xffef)
	)
}

// The face CSS matching would pick: style first, then the closest weight (lighter below 500, heavier above).
function pickFace(faces: readonly PdfFaceFile[], weight: number, italic: boolean): PdfFaceFile {
	const styled = faces.some(face => face.italic === italic) ? faces.filter(face => face.italic === italic) : faces
	let best = styled[0] ?? faces[0]
	let bestDistance = Infinity

	for (const face of styled) {
		const distance = Math.abs(face.weight - weight)
		const preferred = weight > 500 ? face.weight > weight : face.weight < weight

		if (distance < bestDistance || (distance === bestDistance && preferred)) {
			best = face
			bestDistance = distance
		}
	}

	if (best === undefined) throw new Error("A font family without faces")

	return best
}

// Without a FontManager: the family's bundled substitute, else the generic fallback by name.
function defaultResolver(request: PdfFontFaceRequest): PdfFaceSource {
	const substitution = SUBSTITUTIONS.get(request.family.toLowerCase())
	const weight = request.bold ? 700 : (substitution?.weight ?? 400)
	const family = substitution?.family ?? fallbackFor(request.family, NO_HINTS, true).family ?? "arimo"

	return { kind: "bundled", family, weight, italic: request.italic }
}

// Whether a CFF program's Top DICT has the ROS operator (12 30) that makes it CID-keyed.
function cidKeyedCff(sfnt: SfntFont): boolean {
	const range = sfnt.table("CFF ")

	if (range === undefined) return false

	const data = sfnt.bytes.subarray(range.offset, range.offset + range.length)
	const headerSize = data[2] ?? 4
	let at = headerSize

	// Skip the Name INDEX, then read the first Top DICT.
	const skipIndex = (): [number, number] => {
		const count = ((data[at] ?? 0) << 8) | (data[at + 1] ?? 0)

		if (count === 0) {
			at += 2

			return [at, at]
		}

		const offSize = data[at + 2] ?? 1
		const offsets = at + 3
		const readOffset = (index: number): number => {
			let value = 0

			for (let k = 0; k < offSize; k++) value = value * 256 + (data[offsets + index * offSize + k] ?? 0)

			return value
		}
		const base = offsets + (count + 1) * offSize - 1
		const first = base + readOffset(0)
		const second = base + readOffset(1)

		at = base + readOffset(count)

		return [first, second]
	}

	skipIndex()

	const [dictStart, dictEnd] = skipIndex()

	for (let i = dictStart; i < dictEnd && i < data.length;) {
		const b = data[i] ?? 0

		if (b === 12) {
			if (data[i + 1] === 30) return true

			i += 2
		} else if (b <= 21) {
			i += 1
		} else if (b === 28) {
			i += 3
		} else if (b === 29) {
			i += 5
		} else if (b === 30) {
			i++

			while (i < dictEnd && (data[i] ?? 0) % 16 !== 15 && (data[i] ?? 0) >>> 4 !== 15) i++

			i++
		} else if (b >= 247 && b <= 254) {
			i += 2
		} else {
			i += 1
		}
	}

	return false
}
