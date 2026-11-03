import { classifyLink } from "@filen/shared/linkPolicy"
import { ByteWriter, writeHex } from "./bytes"
import { ContentBuilder, type Matrix } from "./content"
import { PdfWriteError } from "./errors"
import { orientationMatrix } from "./images"
import { pdfName, textStringBytes, writeName, type PdfDict, type PdfRef, type PdfValue } from "./objects"
import type { PdfGradient, PdfMesh } from "./shading"
import type { PdfStructOptions } from "./tagged"
import type { PdfObjectSink, PdfWriter } from "./writer"

// One page under construction. Drawing uses px (96 per inch) from the page's top-left with y down, as the
// layout display lists do: the page's first operator maps that space onto PDF's points (y up).
//
// Tagged documents: every painting operator belongs either to a structure element (beginContent/endContent
// around it) or to an artifact (beginArtifact/endArtifact) — ISO 14289-1 §7.1. Untagged documents ignore
// both (they still have to balance).

// A font as the font module provides it (core/pdfwrite/fonts): Type0, Identity-H, CID = glyph id.
export interface PdfTextFont {
	readonly unitsPerEm: number
	readonly postScriptName: string
	// The glyph's advance as /W states it, 1/1000 em.
	advance(glyph: number): number
	write(sink: PdfObjectSink, ref: PdfRef): Promise<void>
	close(): void
}

// Shaped glyphs of one font, in visual order.
export interface PdfTextRun {
	readonly font: PdfTextFont
	readonly glyphs: Uint16Array
	// Advances wanted, 1/1000 em (shaping applied).
	readonly advances: Float32Array
	readonly dx: Float32Array | null
	readonly dy: Float32Array | null
	// Per glyph, the UTF-16 offset of its cluster in the fragment's text.
	readonly clusters: Uint32Array
	// Set when ToUnicode cannot reproduce the run's text.
	readonly actualText: string | undefined
}

export interface PdfTextOptions {
	// The pen's start on the baseline, px.
	readonly x: number
	readonly y: number
	// The font size, px per em.
	readonly size: number
	// 0xRRGGBBAA; default opaque black.
	readonly color?: number
	// The fragment's text the runs' clusters index (word spacing goes after U+0020).
	readonly text?: string
	// Extra px after each space and after each glyph.
	readonly wordSpacing?: number
	readonly letterSpacing?: number
	// The width the layout gave the fragment, px: the difference to the natural width is spread between
	// glyphs ("spread", default) or taken by horizontal scaling ("scale", for faces drawn in place of another).
	readonly width?: number
	readonly fit?: "spread" | "scale"
	// A linear transform of the text about its origin (rotation, synthetic italic shear): a b c d.
	readonly transform?: readonly [number, number, number, number]
	// Text rendering mode (§9.3.6); "fillStroke" with strokeWidth emboldens; "clip" (mode 7) adds the glyphs to the
	// clipping path, which applies after ET (wrap the call in saveState/restoreState).
	readonly render?: "fill" | "stroke" | "fillStroke" | "invisible" | "clip"
	readonly strokeWidth?: number
	// The stroke colour of "stroke" and "fillStroke" (0xRRGGBBAA); default `color`.
	readonly strokeColor?: number
}

export type PdfLinkTarget =
	| { readonly uri: string }
	// A named destination (see PdfWriter.destination).
	| { readonly dest: string }
	// A page (index) and optionally a position on it (px).
	| { readonly page: number; readonly x?: number; readonly y?: number }

export interface PdfArtifact {
	readonly type?: "Pagination" | "Layout" | "Page" | "Background"
	readonly subtype?: "Header" | "Footer" | "Watermark"
}

export interface PdfImage {
	readonly ref: PdfRef
	readonly name: string
	// Pixels as stored; EXIF orientation 1-8 (drawImage turns the image upright).
	readonly width: number
	readonly height: number
	readonly orientation: number
}

interface GraphicsState {
	fillAlpha: number
	strokeAlpha: number
	fill: number
	stroke: number
	// User space to the page's default space (tiling patterns are placed in the latter).
	ctm: Matrix
}

function codeByte(out: ByteWriter, byte: number): void {
	if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out.byte(0x5c).byte(byte)
	else if (byte === 0x0d) out.byte(0x5c).byte(0x72)
	else if (byte === 0x0a) out.byte(0x5c).byte(0x6e)
	else out.byte(byte)
}

// The smallest pen move written into a TJ array, 1/1000 em (smaller ones are carried on).
const MIN_MOVE = 1.5

const DEFAULT_STATE: GraphicsState = { fillAlpha: 1, strokeAlpha: 1, fill: 0, stroke: 0, ctm: [1, 0, 0, 1, 0, 0] }

// `first` then `second` (row vectors, as cm composes).
function multiply(first: Matrix, second: Matrix): Matrix {
	return [
		first[0] * second[0] + first[1] * second[2],
		first[0] * second[1] + first[1] * second[3],
		first[2] * second[0] + first[3] * second[2],
		first[2] * second[1] + first[3] * second[3],
		first[4] * second[0] + first[5] * second[2] + second[4],
		first[4] * second[1] + first[5] * second[3] + second[5]
	]
}

// A picture repeated over an area: `width` x `height` units of tile space, placed by `matrix` (tile space to user
// space), mirrored across the next cell per flip, cropped by `crop` (fractions of each side).
export interface PdfTile {
	readonly width: number
	readonly height: number
	readonly matrix: Matrix
	readonly flipX: boolean
	readonly flipY: boolean
	readonly crop: readonly [number, number, number, number]
}

export class PdfPage extends ContentBuilder {
	readonly fonts = new Map<string, PdfRef>()
	readonly xobjects = new Map<string, PdfRef>()
	readonly extGStates = new Map<string, PdfRef>()
	readonly shadings = new Map<string, PdfRef>()
	readonly patterns = new Map<string, PdfRef>()
	readonly annotations: PdfRef[] = []
	private states: GraphicsState[] = [{ ...DEFAULT_STATE }]
	// Open marked content: "c" structure content (with MCID), "a" artifact, "s" span.
	private marks: ("c" | "a" | "s")[] = []
	finished = false

	private readonly writer: PdfWriter
	readonly index: number
	readonly ref: PdfRef
	// px
	readonly width: number
	readonly height: number

	constructor(writer: PdfWriter, index: number, ref: PdfRef, width: number, height: number, out: ByteWriter) {
		super(out)
		this.writer = writer
		this.index = index
		this.ref = ref
		this.width = width
		this.height = height
		this.concat([0.75, 0, 0, -0.75, 0, height * 0.75])
	}

	get heightPt(): number {
		return this.height * 0.75
	}

	private get state(): GraphicsState {
		return this.states[this.states.length - 1] ?? DEFAULT_STATE
	}

	private live(): void {
		if (this.finished) throw new PdfWriteError("state", "The page is finished")
	}

	override saveState(): this {
		this.live()
		this.states.push({ ...this.state })

		return super.saveState()
	}

	override restoreState(): this {
		if (this.states.length <= 1) throw new PdfWriteError("unbalanced", "Restore without save")

		this.states.pop()

		return super.restoreState()
	}

	override concat(m: Matrix): this {
		this.state.ctm = multiply(m, this.state.ctm)

		return super.concat(m)
	}

	get depth(): number {
		return this.states.length - 1
	}

	get openMarks(): number {
		return this.marks.length
	}

	// Fill colour 0xRRGGBBAA (alpha through an ExtGState, §11.6.4.4).
	fillColor(rgba: number): this {
		const state = this.state
		const rgb = rgba >>> 8
		const alpha = (rgba & 255) / 255

		if (state.fill !== rgb) {
			this.fillRgb(rgb)
			state.fill = rgb
		}
		if (state.fillAlpha !== alpha) {
			this.alpha(alpha, state.strokeAlpha)
			state.fillAlpha = alpha
		}

		return this
	}

	strokeColor(rgba: number): this {
		const state = this.state
		const rgb = rgba >>> 8
		const alpha = (rgba & 255) / 255

		if (state.stroke !== rgb) {
			this.strokeRgb(rgb)
			state.stroke = rgb
		}
		if (state.strokeAlpha !== alpha) {
			this.alpha(state.fillAlpha, alpha)
			state.strokeAlpha = alpha
		}

		return this
	}

	private alpha(fill: number, stroke: number): void {
		this.graphicsState({ fillAlpha: fill, strokeAlpha: stroke })
	}

	// Sets an ExtGState: constant alpha, blend mode (§11.3.5).
	graphicsState(options: {
		readonly fillAlpha?: number
		readonly strokeAlpha?: number
		readonly blend?: "Normal" | "Multiply" | "Screen" | "Lighten" | "Darken" | "Difference"
	}): this {
		const name = this.writer.extGState(options)

		this.extGStates.set(name.name, name.ref)

		if (options.fillAlpha !== undefined) this.state.fillAlpha = options.fillAlpha
		if (options.strokeAlpha !== undefined) this.state.strokeAlpha = options.strokeAlpha

		return this.named(name.name, "gs")
	}

	// Paints a gradient over the current clip (set one with a path and clip() first), inside q/Q.
	async gradient(gradient: PdfGradient): Promise<void> {
		this.live()

		const resources = await this.writer.gradient(gradient)

		this.saveState()
		this.shadings.set(resources.shading.name, resources.shading.ref)

		if (resources.state !== undefined) {
			this.extGStates.set(resources.state.name, resources.state.ref)
			this.named(resources.state.name, "gs")
		}

		this.named(resources.shading.name, "sh")
		this.restoreState()
	}

	// Paints a Gouraud mesh over the current clip, inside q/Q; false (nothing painted) for a mesh the writer refuses.
	async mesh(mesh: PdfMesh): Promise<boolean> {
		this.live()

		const resources = await this.writer.mesh(mesh)

		if (resources === undefined) return false

		this.saveState()
		this.shadings.set(resources.shading.name, resources.shading.ref)

		if (resources.state !== undefined) {
			this.extGStates.set(resources.state.name, resources.state.ref)
			this.named(resources.state.name, "gs")
		}

		this.named(resources.shading.name, "sh")
		this.restoreState()

		return true
	}

	// Draws an image into the box (px), upright for its EXIF orientation unless `asStored`.
	drawImage(image: PdfImage, x: number, y: number, width: number, height: number, asStored: boolean = false): this {
		this.live()

		const [a, b, c, d, e, f] = asStored ? orientationMatrix(1) : orientationMatrix(image.orientation)

		this.xobjects.set(image.name, image.ref)
		this.saveState()
		this.concat([width * a, height * b, -width * c, -height * d, x + width * (c + e), y + height * (d + f)])
		this.named(image.name, "Do")

		return this.restoreState()
	}

	// Paints the rectangle (inside the current clip) with a picture tiled through a tiling pattern (§8.7.3): the
	// picture is embedded once and the cell drawn by the viewer as often as the area needs.
	async tile(image: PdfImage, tile: PdfTile, x: number, y: number, width: number, height: number): Promise<void> {
		this.live()

		const flips: readonly (readonly [number, number])[] = [
			[1, 1],
			...(tile.flipX ? ([[-1, 1]] as const) : []),
			...(tile.flipY ? ([[1, -1]] as const) : []),
			...(tile.flipX && tile.flipY ? ([[-1, -1]] as const) : [])
		]
		const cell = new ContentBuilder(new ByteWriter(256))
		const [left, top, right, bottom] = tile.crop
		const cropped = left !== 0 || top !== 0 || right !== 0 || bottom !== 0
		const fullWidth = tile.width / Math.max(0.0001, 1 - left - right)
		const fullHeight = tile.height / Math.max(0.0001, 1 - top - bottom)
		const ix = -left * fullWidth
		const iy = -top * fullHeight
		const [a, b, c, d, e, f] = orientationMatrix(image.orientation)

		for (const [fx, fy] of flips) {
			cell.saveState().concat([fx, 0, 0, fy, fx < 0 ? tile.width * 2 : 0, fy < 0 ? tile.height * 2 : 0])

			if (cropped) cell.rect(0, 0, tile.width, tile.height).clip()

			cell.concat([
				fullWidth * a,
				fullHeight * b,
				-fullWidth * c,
				-fullHeight * d,
				ix + fullWidth * (c + e),
				iy + fullHeight * (d + f)
			])
			cell.named(image.name, "Do").restoreState()
		}

		const pattern = await this.writer.tilingPattern({
			width: tile.width * (tile.flipX ? 2 : 1),
			height: tile.height * (tile.flipY ? 2 : 1),
			matrix: multiply(tile.matrix, this.state.ctm),
			content: cell.out.take(),
			image
		})

		this.patterns.set(pattern.name, pattern.ref)
		this.saveState()
		this.op("/Pattern cs")
		this.named(pattern.name, "scn")
		this.rect(x, y, width, height).fill()
		this.restoreState()
	}

	// Draws an image through an arbitrary matrix from its unit square (PDF image space, y up).
	drawImageMatrix(image: PdfImage, matrix: Matrix): this {
		this.live()
		this.xobjects.set(image.name, image.ref)
		this.saveState()
		this.concat(matrix)
		this.named(image.name, "Do")

		return this.restoreState()
	}

	// Shows shaped runs (one fragment) on one baseline.
	text(runs: readonly PdfTextRun[], options: PdfTextOptions): this {
		this.live()

		const size = options.size

		// Zero-size text shows nothing (and has no text space to position in).
		if (runs.length === 0 || !(size > 0)) return this

		const word = options.wordSpacing ?? 0
		const letter = options.letterSpacing ?? 0
		const text = options.text
		const isSpace = (run: PdfTextRun, index: number): boolean =>
			text !== undefined && text.charCodeAt(run.clusters[index] ?? -1) === 0x20
		let natural = 0
		let glyphCount = 0

		for (const run of runs) {
			for (let index = 0; index < run.glyphs.length; index++) {
				natural += ((run.advances[index] ?? 0) * size) / 1000 + letter + (word !== 0 && isSpace(run, index) ? word : 0)
				glyphCount++
			}
		}

		const target = options.width
		const scaling = target !== undefined && options.fit === "scale" && natural > 0 ? target / natural : 1
		const spread = target !== undefined && options.fit !== "scale" && glyphCount > 1 ? (target - natural) / (glyphCount - 1) : 0
		// The spacing every glyph gets alike (letter spacing and the spread) is character spacing (Tc, §9.3.2, text
		// space units: px here, scaled with Tz), not a number per glyph.
		const charSpacing = Math.round((letter + spread) * 100) / 100

		this.fillColor(options.color ?? 0x000000ff)

		if (options.render === "stroke" || options.render === "fillStroke") {
			this.strokeColor(options.strokeColor ?? options.color ?? 0x000000ff)
			this.lineWidth(options.strokeWidth ?? size / 30)
		}

		const out = this.out
		const [ta, tb, tc, td] = options.transform ?? [1, 0, 0, 1]

		this.op("BT")

		if (options.render !== undefined && options.render !== "fill") {
			this.op(`${options.render === "stroke" ? 1 : options.render === "fillStroke" ? 2 : options.render === "clip" ? 7 : 3} Tr`)
		}

		// Text space: y up, so the matrix flips the page's y-down space back (d negated).
		this.s(ta).s(tb).s(-tc).s(-td).n(options.x).n(options.y).op("Tm")

		if (scaling !== 1) this.n(scaling * 100).op("Tz")
		if (charSpacing !== 0) this.n(charSpacing).op("Tc")

		let rise = 0
		let last: PdfTextFont | undefined
		// What the pen still has to move before the next glyph's origin (its dx aside), 1/1000 em: the wanted
		// advance of the glyph before minus what the font's /W advances it, minus that glyph's own dx. Moves under
		// MIN_MOVE are carried to the next glyph rather than written (the error never reaches MIN_MOVE).
		let pending = 0
		const perPx = 1000 / size

		for (const run of runs) {
			const fontName = this.writer.fontName(run.font)

			this.fonts.set(fontName.name, fontName.ref)

			if (run.font !== last) {
				out.byte(0x2f).ascii(fontName.name).space()
				this.n(size).op("Tf")
				last = run.font
			}

			if (run.actualText !== undefined) this.beginSpan(run.actualText)

			let open = false
			let inString = false

			for (let index = 0; index < run.glyphs.length; index++) {
				const glyph = run.glyphs[index] ?? 0
				const dx = run.dx?.[index] ?? 0
				const wantedRise = ((run.dy?.[index] ?? 0) * size) / 1000

				if (Math.abs(wantedRise - rise) > 1e-4) {
					if (inString) out.byte(0x29)
					if (open) out.ascii("] TJ").newline()

					open = false
					inString = false
					this.n(wantedRise).op("Ts")
					rise = wantedRise
				}

				if (!open) {
					out.byte(0x5b)
					open = true
				}

				const move = pending + dx
				const written = Math.abs(move) >= MIN_MOVE ? Math.round(move) : 0

				if (written !== 0) {
					if (inString) out.byte(0x29).space()

					out.int(-written).space()
					inString = false
				}

				// Consecutive codes share one literal string, two bytes each (§7.3.4.2: ( ) \ escaped, and CR and LF
				// so no end of line is read as one).
				if (!inString) {
					out.byte(0x28)
					inString = true
				}

				codeByte(out, glyph >>> 8)
				codeByte(out, glyph & 255)

				const wanted = (run.advances[index] ?? 0) + (word !== 0 && isSpace(run, index) ? word * perPx : 0)

				pending = move - written + wanted - run.font.advance(glyph) - dx
			}

			if (inString) out.byte(0x29)
			if (open) out.ascii("] TJ").newline()
			if (run.actualText !== undefined) this.endMark("s")
		}

		// Text state outlives ET (§9.3.1): put back what this fragment changed.
		if (charSpacing !== 0) this.op("0 Tc")
		if (rise !== 0) this.op("0 Ts")
		if (scaling !== 1) this.op("100 Tz")
		if (options.render !== undefined && options.render !== "fill") this.op("0 Tr")

		this.op("ET")

		return this
	}

	private beginSpan(actualText: string): void {
		this.marks.push("s")
		this.out.ascii("/Span <</ActualText <")
		writeHex(this.out, textStringBytes(actualText))
		this.out.ascii(">>> BDC").newline()
	}

	// Content of structure element `node` (a new marked-content sequence with its MCID).
	beginContent(node: number): this {
		this.live()

		const mcid = this.writer.mark(node, this.index)

		this.marks.push("c")

		if (mcid !== undefined) {
			writeName(this.out, this.writer.structType(node))
			this.out.ascii(" <</MCID ").int(mcid).ascii(">> BDC").newline()
		}

		return this
	}

	endContent(): this {
		return this.endMark("c")
	}

	beginArtifact(artifact: PdfArtifact = {}): this {
		this.live()
		this.marks.push("a")

		if (this.writer.tagged) {
			this.out.ascii("/Artifact")

			if (artifact.type !== undefined) {
				this.out.ascii(" <</Type /").ascii(artifact.type)

				if (artifact.subtype !== undefined) this.out.ascii(" /Subtype /").ascii(artifact.subtype)

				this.out.ascii(">> BDC").newline()
			} else {
				this.out.ascii(" BMC").newline()
			}
		}

		return this
	}

	endArtifact(): this {
		return this.endMark("a")
	}

	private endMark(kind: "c" | "a" | "s"): this {
		if (this.marks[this.marks.length - 1] !== kind) throw new PdfWriteError("unbalanced", "Marked content closed out of order")

		this.marks.pop()

		if (this.writer.tagged || kind === "s") this.op("EMC")

		return this
	}

	// A link over the box (px). URIs pass the shared link policy (a refused one returns false and adds no
	// annotation); `node` is the Link structure element in a tagged document (one is opened under the current
	// element when omitted). `contents` is the alternate description (ISO 14289-1 §7.18.5).
	link(
		box: readonly [number, number, number, number],
		target: PdfLinkTarget,
		options: { readonly contents?: string; readonly node?: number } = {}
	): boolean {
		this.live()

		let action: PdfDict | undefined
		let dest: PdfValue | undefined

		if ("uri" in target) {
			const verdict = classifyLink(target.uri)

			if (verdict.kind === "internal") dest = verdict.fragment
			else if (verdict.kind === "external") action = { S: pdfName("URI"), URI: asciiUri(verdict.url) }
			else return false
		} else if ("dest" in target) {
			dest = target.dest
		} else {
			dest = this.writer.explicitDestination(target.page, target.x, target.y)
		}

		const ref = this.writer.allocate()
		const [x, y, width, height] = box
		let structParent: number | undefined

		if (this.writer.tagged) {
			let node = options.node

			if (node === undefined) {
				node = this.writer.struct.open("Link")
				structParent = this.writer.struct.annotation(node, this.index, ref)
				this.writer.struct.close(node)
			} else {
				structParent = this.writer.struct.annotation(node, this.index, ref)
			}
		}

		const annotation: PdfDict = {
			Type: pdfName("Annot"),
			Subtype: pdfName("Link"),
			Rect: [x * 0.75, this.heightPt - (y + height) * 0.75, (x + width) * 0.75, this.heightPt - y * 0.75],
			Border: [0, 0, 0],
			F: 4,
			P: this.ref,
			A: action,
			Dest: dest,
			Contents: options.contents ?? ("uri" in target ? target.uri : undefined),
			StructParent: structParent
		}

		// A named destination may be defined later (or never): the writer resolves it at the end.
		if (typeof dest === "string") this.writer.namedLink(ref, annotation, dest)
		else this.writer.object(ref, annotation)

		this.annotations.push(ref)

		return true
	}

	// Checks the page closes cleanly.
	checkBalanced(): void {
		if (this.marks.length > 0) throw new PdfWriteError("unbalanced", "Marked content left open at the end of the page")
		if (this.states.length !== 1) throw new PdfWriteError("unbalanced", "Graphics state left saved at the end of the page")
	}
}

// §12.6.4.7: a URI is 7-bit ASCII; anything else is percent-encoded as UTF-8.
function asciiUri(uri: string): PdfValue {
	let out = ""

	for (const char of uri) {
		const code = char.codePointAt(0) ?? 0

		if (code < 0x80) {
			out += char
			continue
		}

		for (const byte of textStringBytesUtf8(char)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
	}

	return out
}

function textStringBytesUtf8(char: string): number[] {
	const code = char.codePointAt(0) ?? 0

	if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 63)]
	if (code < 0x10000) return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)]

	return [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)]
}

export type { PdfStructOptions }
