import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { deflateSync, inflateSync } from "node:zlib"
import { SfntFont } from "../core/fonts/sfnt"
import {
	PdfWriteError,
	PdfWriter,
	pdfName,
	pdfRaw,
	type PdfDecodedImage,
	type PdfImageData,
	type PdfImageDecoder,
	type PdfObjectSink,
	type PdfRef,
	type PdfTextFont,
	type PdfTextRun
} from "../core/pdfwrite"

// Test fixtures for the PDF writer: a whole-font TrueType stand-in for the font module (pdf.js's bundled
// Liberation Sans, SIL OFL, embedded whole as CIDFontType2 with ToUnicode), tiny PNG/JPEG images and a PNG
// decoder for the decode path (node zlib in place of createImageBitmap).

const require = createRequire(import.meta.url)
const PDFJS_DIR = dirname(require.resolve("pdfjs-dist/package.json"))

export const LIBERATION_SANS = join(PDFJS_DIR, "standard_fonts", "LiberationSans-Regular.ttf")

export class StubFont implements PdfTextFont {
	readonly unitsPerEm: number
	readonly postScriptName = "LiberationSans"
	private readonly sfnt: SfntFont
	private readonly bytes: Uint8Array
	private readonly used = new Map<number, string>()
	closed = false

	constructor(bytes: Uint8Array = new Uint8Array(readFileSync(LIBERATION_SANS))) {
		this.bytes = bytes
		this.sfnt = new SfntFont(bytes)
		this.unitsPerEm = this.sfnt.unitsPerEm
	}

	advance(glyph: number): number {
		return Math.round((this.sfnt.advance(glyph) * 1000) / this.unitsPerEm)
	}

	// Left-to-right shaping by cmap alone (what a test needs).
	shape(text: string, options: { readonly actualText?: string } = {}): PdfTextRun {
		const glyphs: number[] = []
		const clusters: number[] = []

		for (let index = 0; index < text.length; index++) {
			const code = text.codePointAt(index) ?? 0
			const glyph = this.sfnt.glyphId(code)

			glyphs.push(glyph)
			clusters.push(index)

			if (!this.used.has(glyph)) this.used.set(glyph, String.fromCodePoint(code))
			if (code > 0xffff) index++
		}

		return {
			font: this,
			glyphs: Uint16Array.from(glyphs),
			advances: Float32Array.from(glyphs, glyph => this.advance(glyph)),
			dx: null,
			dy: null,
			clusters: Uint32Array.from(clusters),
			actualText: options.actualText
		}
	}

	async write(sink: PdfObjectSink, ref: PdfRef): Promise<void> {
		const descendant = sink.allocate()
		const descriptor = sink.allocate()
		const file = sink.allocate()
		const toUnicode = sink.allocate()
		const glyphs = [...this.used.keys()].sort((a, b) => a - b)
		const widths = glyphs.map(glyph => `${glyph} [${this.advance(glyph)}]`).join(" ")
		const scale = 1000 / this.unitsPerEm
		const m = this.sfnt.metrics

		await sink.stream(file, { Length1: this.bytes.length }, this.bytes, { compress: true })
		await sink.stream(toUnicode, {}, new TextEncoder().encode(toUnicodeCmap(this.used)), { compress: true })
		sink.object(descriptor, {
			Type: pdfName("FontDescriptor"),
			FontName: pdfName(this.postScriptName),
			Flags: 32,
			FontBBox: [-544, -303, 1302, 980],
			ItalicAngle: 0,
			Ascent: Math.round(m.hheaAscender * scale),
			Descent: Math.round(m.hheaDescender * scale),
			CapHeight: Math.round((this.sfnt.capHeight ?? m.hheaAscender) * scale),
			StemV: 80,
			FontFile2: file
		})
		sink.object(descendant, {
			Type: pdfName("Font"),
			Subtype: pdfName("CIDFontType2"),
			BaseFont: pdfName(this.postScriptName),
			CIDSystemInfo: { Registry: "Adobe", Ordering: "Identity", Supplement: 0 },
			FontDescriptor: descriptor,
			W: pdfRaw(`[${widths}]`),
			CIDToGIDMap: pdfName("Identity")
		})
		sink.object(ref, {
			Type: pdfName("Font"),
			Subtype: pdfName("Type0"),
			BaseFont: pdfName(this.postScriptName),
			Encoding: pdfName("Identity-H"),
			DescendantFonts: [descendant],
			ToUnicode: toUnicode
		})
	}

	close(): void {
		this.closed = true
	}
}

function toUnicodeCmap(used: ReadonlyMap<number, string>): string {
	const hex = (value: number): string => value.toString(16).toUpperCase().padStart(4, "0")
	const lines = [...used].map(([glyph, text]) => {
		let units = ""

		for (let index = 0; index < text.length; index++) units += hex(text.charCodeAt(index))

		return `<${hex(glyph)}> <${units}>`
	})

	return [
		"/CIDInit /ProcSet findresource begin",
		"12 dict begin",
		"begincmap",
		"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
		"/CMapName /Adobe-Identity-UCS def",
		"/CMapType 2 def",
		"1 begincodespacerange",
		"<0000> <FFFF>",
		"endcodespacerange",
		`${lines.length} beginbfchar`,
		...lines,
		"endbfchar",
		"endcmap",
		"CMapName currentdict /CMap defineresource pop",
		"end",
		"end"
	].join("\n")
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff

	for (const byte of bytes) {
		crc ^= byte

		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
	}

	return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length)
	const view = new DataView(out.buffer)

	view.setUint32(0, data.length)
	out.set(new TextEncoder().encode(type), 4)
	out.set(data, 8)
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))

	return out
}

export interface PngOptions {
	readonly width: number
	readonly height: number
	// 0 gray, 2 RGB, 3 palette, 6 RGBA.
	readonly colorType: 0 | 2 | 3 | 6
	readonly pixel: (x: number, y: number) => readonly number[]
	readonly palette?: readonly number[]
	readonly transparency?: readonly number[]
	readonly interlaced?: boolean
	// Split the zlib stream over IDAT chunks this long.
	readonly idatSize?: number
}

// A PNG with filter type 0 on every row (interlaced files are only flagged: tests use them for routing).
export function encodePng(options: PngOptions): Uint8Array {
	const channels = options.colorType === 0 || options.colorType === 3 ? 1 : options.colorType === 2 ? 3 : 4
	const raw = new Uint8Array(options.height * (1 + options.width * channels))
	let at = 0

	for (let y = 0; y < options.height; y++) {
		raw[at++] = 0

		for (let x = 0; x < options.width; x++) for (const value of options.pixel(x, y).slice(0, channels)) raw[at++] = value
	}

	const header = new Uint8Array(13)
	const view = new DataView(header.buffer)

	view.setUint32(0, options.width)
	view.setUint32(4, options.height)
	header[8] = 8
	header[9] = options.colorType
	header[12] = options.interlaced === true ? 1 : 0

	const zlib = new Uint8Array(deflateSync(raw))
	const idatSize = options.idatSize ?? zlib.length
	const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header)]

	if (options.palette !== undefined) parts.push(chunk("PLTE", Uint8Array.from(options.palette)))
	if (options.transparency !== undefined) parts.push(chunk("tRNS", Uint8Array.from(options.transparency)))

	for (let offset = 0; offset < zlib.length; offset += idatSize) parts.push(chunk("IDAT", zlib.subarray(offset, offset + idatSize)))

	parts.push(chunk("IEND", new Uint8Array(0)))

	return Buffer.concat(parts)
}

// Decodes the RGBA (6) and RGB (2) PNGs encodePng writes, like the platform decoder would.
export class TestDecoder implements PdfImageDecoder {
	calls = 0

	async decode(data: PdfImageData, format: string, maxPixels: number): Promise<PdfDecodedImage> {
		this.calls++

		const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer())

		if (format !== "png") throw new PdfWriteError("imageUnsupported", `The test decoder has no ${format}`)

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		let at = 8
		let width = 0
		let height = 0
		let colorType = 0
		const idat: Uint8Array[] = []

		while (at < bytes.length) {
			const length = view.getUint32(at)
			const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))

			if (type === "IHDR") {
				width = view.getUint32(at + 8)
				height = view.getUint32(at + 12)
				colorType = bytes[at + 17] ?? 0
			} else if (type === "IDAT") {
				idat.push(bytes.subarray(at + 8, at + 8 + length))
			}

			at += 12 + length
		}

		if (width * height > maxPixels) throw new PdfWriteError("imageTooLarge", "too many pixels")

		const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
		const raw = inflateSync(Buffer.concat(idat))
		const rgba = new Uint8Array(width * height * 4)

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const from = y * (1 + width * channels) + 1 + x * channels
				const to = (y * width + x) * 4
				const gray = raw[from] ?? 0

				rgba[to] = gray
				rgba[to + 1] = channels >= 3 ? (raw[from + 1] ?? 0) : gray
				rgba[to + 2] = channels >= 3 ? (raw[from + 2] ?? 0) : gray
				rgba[to + 3] = channels === 4 ? (raw[from + 3] ?? 0) : 255
			}
		}

		return { width, height, rgba }
	}
}

// 32 x 24, a red-green ramp over blue (sips, quality 70; JFIF + EXIF without orientation).
export const JPEG_32x24 = Uint8Array.from(
	Buffer.from(
		"/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAAB" +
			"AAAAGAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAGAAgAwEiAAIRAQMRAf/EAB8A" +
			"AAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYX" +
			"GBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfI" +
			"ycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMR" +
			"BAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWG" +
			"h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICBAICBAYEBAQGCAYG" +
			"BgYICggICAgICgwKCgoKCgoMDAwMDAwMDA4ODg4ODhAQEBAQEhISEhISEhISEv/bAEMBAwMDBQQFCAQECBMNCw0TExMTExMTExMTExMTExMTExMTExMTExMT" +
			"ExMTExMTExMTExMTExMTExMTExMTExMTE//dAAQAAv/aAAwDAQACEQMRAD8A/K3SfBPT5K9N0nwV0+Svb9J8E9Pkr0zSfBXT5K/Tcw4o3948Dg7jP4fePENJ" +
			"8FdPkr03SfBXT5K9v0nwV0+SvTdJ8FdPkr4bMOKN/eP6q4O4z+H3j//Q6bSfBXT5K9M0nwV0+SptJ7V6bpXavlcwzCtrqfyTwdmuI933iHSfBXT5K9M0nwV0" +
			"+SptJ7V6bpPavhswzCtrqf1VwdmuI933j//Z",
		"base64"
	)
)

export function naturalWidth(runs: readonly PdfTextRun[], size: number): number {
	let width = 0

	for (const run of runs) for (const advance of run.advances) width += (advance * size) / 1000

	return width
}

export interface SyntheticOptions {
	readonly pages: number
	readonly password?: string
	readonly tagged?: boolean
	readonly deterministic?: boolean
	readonly signal?: { readonly aborted: boolean; readonly reason?: unknown }
	readonly decoder?: PdfImageDecoder
	readonly font?: StubFont
}

const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."

// A multi-page document exercising every writer feature: tagged headings, paragraphs (Latin, Greek,
// Cyrillic), a list, a table, paths (fills, dashed strokes, even-odd, quadratics, clips), transparency,
// gradients (axial, radial with an alpha ramp, repeating), JPEG and PNG (passthrough, palette colour key,
// alpha through the decoder), links (web, internal, to an undefined anchor, refused), outlines and header artifacts.
export async function buildSyntheticPdf(options: SyntheticOptions): Promise<{ readonly bytes: Uint8Array; readonly refusedLink: boolean }> {
	const font = options.font ?? new StubFont()
	const writer = await PdfWriter.create({
		title: "Synthetic PDF – Ünïcode",
		lang: "en-US",
		tagged: options.tagged ?? true,
		deterministic: options.deterministic ?? true,
		...(options.password === undefined ? {} : { password: options.password }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
		decoder: options.decoder ?? new TestDecoder()
	})
	const jpeg = await writer.image({ data: JPEG_32x24, key: "media/image1.jpeg" })
	const pngRgb = await writer.image({
		data: encodePng({ width: 40, height: 30, colorType: 2, pixel: (x, y) => [x * 6, y * 8, 200], idatSize: 300 })
	})
	const pngPalette = await writer.image({
		data: encodePng({
			width: 16,
			height: 16,
			colorType: 3,
			palette: [255, 0, 0, 0, 128, 0, 0, 0, 255],
			transparency: [255, 0, 255],
			pixel: (x, y) => [(x + y) % 3]
		})
	})
	const pngAlpha = await writer.image({
		data: encodePng({ width: 24, height: 24, colorType: 6, pixel: (x, y) => [255, x * 10, 0, Math.min(255, y * 11)] })
	})
	let refusedLink = false
	const W = 816
	const H = 1056

	for (let index = 0; index < options.pages; index++) {
		const page = writer.beginPage(W, H)
		const line = (text: string, x: number, y: number, size: number): void => {
			page.text([font.shape(text)], { x, y, size, text })
		}

		page.beginArtifact({ type: "Pagination", subtype: "Header" })
		line(`Page ${index + 1}`, 700, 40, 12)
		page.endArtifact()

		const heading = writer.open(index === 0 ? "H1" : "H2")

		page.beginContent(heading)
		line(index === 0 ? "Synthetic document" : `Section ${index + 1}`, 96, 110, 28)
		page.endContent()
		writer.close(heading)
		writer.destination(`section-${index + 1}`, { page: index, x: 96, y: 80 })
		writer.outline(index === 0 ? "Synthetic document" : `Section ${index + 1}`, index === 0 ? 1 : 2, `section-${index + 1}`)

		const paragraph = writer.open("P")

		page.beginContent(paragraph)
		line(LOREM, 96, 160, 14)
		line("Ελληνικά: Καλημέρα κόσμε. Русский: Привет, мир.", 96, 184, 14)
		const spreadText = "Justified spread text over a set width"
		const spreadRuns = [font.shape(spreadText)]

		page.text(spreadRuns, {
			x: 96,
			y: 208,
			size: 14,
			// The layout's width: a little wider than the font's own advances plus the word spacing.
			width: naturalWidth(spreadRuns, 14) + 6 * 2 + 4,
			text: spreadText,
			wordSpacing: 2,
			color: 0x204080ff
		})
		page.text([font.shape("fi", { actualText: "fi" })], { x: 96, y: 232, size: 14, text: "fi" })
		page.endContent()
		writer.close(paragraph)

		// A link sentence: web, internal, and a refused scheme.
		const link = writer.open("Link")

		page.beginContent(link)
		line("Filen website", 96, 270, 14)
		page.endContent()
		page.link([96, 256, 100, 18], { uri: "https://filen.io/" }, { node: link, contents: "Filen website" })
		writer.close(link)

		const internal = writer.open("Link")

		page.beginContent(internal)
		line("Go to the first section", 260, 270, 14)
		page.endContent()
		page.link([260, 256, 160, 18], { dest: "section-1" }, { node: internal, contents: "Go to the first section" })
		writer.close(internal)

		// A link to an anchor the document never defines: kept, without a destination.
		const dangling = writer.open("Link")

		page.beginContent(dangling)
		line("Missing anchor", 600, 270, 14)
		page.endContent()
		page.link([600, 256, 110, 18], { uri: "#no-such-anchor" }, { node: dangling, contents: "Missing anchor" })
		writer.close(dangling)

		refusedLink = !page.link([450, 256, 100, 18], { uri: "javascript:alert(1)" })

		// A list.
		const list = writer.open("L", { listNumbering: "Decimal" })

		for (let item = 0; item < 2; item++) {
			const li = writer.open("LI")
			const label = writer.open("Lbl")

			page.beginContent(label)
			line(`${item + 1}.`, 96, 310 + item * 22, 14)
			page.endContent()
			writer.close(label)

			const body = writer.open("LBody")

			page.beginContent(body)
			line(`List item ${item + 1}`, 120, 310 + item * 22, 14)
			page.endContent()
			writer.close(body)
			writer.close(li)
		}

		writer.close(list)

		// A table with a header row.
		const table = writer.open("Table", { bbox: [96, 360, 496, 420] })

		for (let row = 0; row < 2; row++) {
			const tr = writer.open("TR")

			for (let column = 0; column < 2; column++) {
				const cell = writer.open(row === 0 ? "TH" : "TD", row === 0 ? { scope: "Column" } : {})

				page.beginContent(cell)
				line(row === 0 ? `Head ${column + 1}` : `Cell ${column + 1}`, 100 + column * 200, 380 + row * 30, 12)
				page.endContent()
				writer.close(cell)
			}

			writer.close(tr)
		}

		writer.close(table)

		// Table rules and decorations are artifacts.
		page.beginArtifact({ type: "Layout" })
		page.strokeColor(0x808080ff).lineWidth(1)
		page.moveTo(96, 390).lineTo(496, 390).stroke()

		// Paths: a translucent fill, a dashed curve, an even-odd star, quadratic curves.
		page.fillColor(0xff000080).rect(96, 450, 120, 80).fill()
		page.saveState()
		page.strokeColor(0x0000ffff).lineWidth(3).lineCap("round").lineJoin("bevel").dash([6, 4])
		page.moveTo(240, 530).curveTo(280, 440, 340, 620, 380, 450).stroke()
		page.restoreState()

		const commands = new Uint8Array([0, 1, 1, 1, 1, 4])
		const coords = new Float32Array([50, 0, 79, 90, 2, 35, 98, 35, 21, 90])

		page.fillColor(0x00a000ff)
		page.pathCommands(commands, coords, 0, commands.length, 0, [1, 0, 0, 1, 400, 445])
		page.fill(true)
		page.fillColor(0xffa500ff).moveTo(520, 530).quadTo(570, 430, 620, 530).closePath().fill()
		page.endArtifact()

		// Gradients inside a figure.
		const figure = writer.open("Figure", { alt: "Gradient swatches and sample pictures", bbox: [96, 560, 720, 760] })

		page.beginContent(figure)
		page.saveState()
		page.rect(96, 560, 160, 80).clip()
		await page.gradient({
			type: "axial",
			coords: [96, 0, 256, 0],
			offsets: [0, 0.5, 1],
			colors: [0xff0000ff, 0xffff00ff, 0x0000ffff],
			bounds: [96, 560, 256, 640]
		})
		page.restoreState()
		page.saveState()
		page.rect(280, 560, 160, 80).clip()
		await page.gradient({
			type: "radial",
			coords: [360, 600, 0, 360, 600, 80],
			offsets: [0, 1],
			colors: [0x00ff00ff, 0x00ff0000],
			bounds: [280, 560, 440, 640]
		})
		page.restoreState()
		page.saveState()
		page.rect(460, 560, 160, 80).clip()
		await page.gradient({
			type: "axial",
			coords: [460, 0, 500, 0],
			offsets: [0, 1],
			colors: [0x000000ff, 0xffffffff],
			spread: "reflect",
			bounds: [460, 560, 620, 640]
		})
		page.restoreState()

		// Pictures: JPEG and PNG passthrough, palette colour key, alpha through the decoder.
		page.drawImage(jpeg, 96, 660, 128, 96)
		page.drawImage(pngRgb, 240, 660, 120, 90)
		page.drawImage(pngPalette, 380, 660, 96, 96)
		page.fillColor(0x000000ff).rect(500, 660, 96, 96).fill()
		page.drawImage(pngAlpha, 500, 660, 96, 96)
		page.endContent()
		writer.close(figure)

		page.beginArtifact({ type: "Pagination", subtype: "Footer" })
		line(`Footer ${index + 1}`, 96, 1010, 10)
		page.endArtifact()

		await writer.endPage(page)
	}

	const output = await writer.finish()
	const chunks: Uint8Array[] = []

	for (const part of output.parts) chunks.push(part instanceof Uint8Array ? part : new Uint8Array(await part.arrayBuffer()))

	return { bytes: Buffer.concat(chunks), refusedLink }
}

export function latin1(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("latin1")
}

// The decoded content of every FlateDecode stream (object streams included), for looking at what was written.
export function inflatedStreams(bytes: Uint8Array): string {
	const text = latin1(bytes)
	const out: string[] = []
	const pattern = /stream\n/g
	let match: RegExpExecArray | null

	while ((match = pattern.exec(text)) !== null) {
		const start = match.index + match[0].length
		const end = text.indexOf("\nendstream", start)
		const data = bytes.subarray(start, end)

		try {
			out.push(latin1(inflateSync(data)))
		} catch {
			out.push(latin1(data))
		}
	}

	return out.join("\n")
}

// The names of the fonts a PDF embeds (the font dictionaries sit in compressed object streams, and pdf.js
// stopped exposing font names on its font objects).
export function embeddedFontNames(bytes: Uint8Array): string[] {
	return [...new Set(Array.from(inflatedStreams(bytes).matchAll(/\/BaseFont\s*\/([^\s/<>[\]()]+)/g), match => match[1] ?? ""))]
}
