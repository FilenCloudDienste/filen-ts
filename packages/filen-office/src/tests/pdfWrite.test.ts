import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { describe, expect, it } from "vitest"
import { ByteWriter } from "../core/pdfwrite/bytes"
import { preparePassword } from "../core/pdfwrite/crypto"
import { ByteSource, readJpeg } from "../core/pdfwrite/images"
import { serialize } from "../core/pdfwrite/objects"
import { PdfWriteError, PdfWriter, pdfName, type PdfBlobLike, type PdfImageDecoder, type PdfTextRun } from "../core/pdfwrite"
import { buildSyntheticPdf, encodePng, inflatedStreams, JPEG_32x24, latin1, naturalWidth, StubFont, TestDecoder } from "./pdfWriteFixtures"

async function bytesOf(writer: PdfWriter): Promise<Uint8Array> {
	const output = await writer.finish()
	const chunks: Uint8Array[] = []

	for (const part of output.parts) chunks.push(part instanceof Uint8Array ? part : new Uint8Array(await part.arrayBuffer()))

	const bytes = Buffer.concat(chunks)

	expect(bytes.length).toBe(output.size)

	return bytes
}

// Glyph codes as a TJ literal string writes them: two bytes each, ( ) \\ CR and LF escaped (latin1, as decoded).
function codes(...glyphs: number[]): string {
	const escaped = (byte: number): string =>
		byte === 0x28 || byte === 0x29 || byte === 0x5c
			? `\\${String.fromCharCode(byte)}`
			: byte === 0x0d
				? "\\r"
				: byte === 0x0a
					? "\\n"
					: String.fromCharCode(byte)

	return `(${glyphs.map(glyph => escaped(glyph >>> 8) + escaped(glyph & 255)).join("")})`
}

async function open(bytes: Uint8Array, password?: string): Promise<pdfjs.PDFDocumentProxy> {
	return pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, ...(password === undefined ? {} : { password }) }).promise
}

describe("PDF writer", () => {
	it("writes a tagged multi-page document pdf.js reads back with its text, links, outline and structure", async () => {
		const { bytes, refusedLink } = await buildSyntheticPdf({ pages: 3 })
		const doc = await open(bytes)

		expect(refusedLink).toBe(true)
		expect(doc.numPages).toBe(3)

		const page = await doc.getPage(2)
		const text = (await page.getTextContent()).items.map(item => ("str" in item ? item.str : "")).join("|")

		expect(text).toContain("Section 2")
		expect(text).toContain("Καλημέρα κόσμε")
		expect(text).toContain("Привет, мир")
		expect(text).toContain("Justified spread text over a set width")

		const annotations = await page.getAnnotations()

		expect(annotations.map(annotation => [annotation.subtype, annotation.url ?? annotation.dest])).toEqual([
			["Link", "https://filen.io/"],
			["Link", "section-1"],
			["Link", undefined]
		])

		const outline = await doc.getOutline()

		expect(outline.map(item => [item.title, item.dest, item.items.map(child => child.title)])).toEqual([
			["Synthetic document", "section-1", ["Section 2", "Section 3"]]
		])

		const tree = JSON.stringify(await page.getStructTree())

		for (const role of ["Document", "H2", "P", "Link", "L", "LI", "Lbl", "LBody", "Table", "TR", "TH", "TD", "Figure"]) {
			expect(tree).toContain(`"role":"${role}"`)
		}

		const operators = await page.getOperatorList()
		const counts = new Map<number, number>()

		for (const fn of operators.fnArray) counts.set(fn, (counts.get(fn) ?? 0) + 1)

		expect(counts.get(pdfjs.OPS.paintImageXObject)).toBe(4)
		// Three gradients and the alpha ramp inside the soft mask.
		expect(counts.get(pdfjs.OPS.shadingFill)).toBe(4)

		const metadata = await doc.getMetadata()

		expect(metadata.info).toMatchObject({
			Title: "Synthetic PDF – Ünïcode",
			Producer: "Filen",
			Language: "en-US",
			PDFFormatVersion: "1.7"
		})
		expect(metadata.info).not.toHaveProperty("CreationDate")
	})

	it("gives the same bytes for the same input in deterministic mode", async () => {
		const first = await buildSyntheticPdf({ pages: 2 })
		const second = await buildSyntheticPdf({ pages: 2 })

		expect(Buffer.compare(first.bytes, second.bytes)).toBe(0)
	})

	it("encrypts with AES-256 so that only the password opens the document", async () => {
		const { bytes } = await buildSyntheticPdf({ pages: 2, password: "pässwörd 1" })

		await expect(open(bytes)).rejects.toMatchObject({ name: "PasswordException" })
		await expect(open(bytes, "wrong")).rejects.toMatchObject({ name: "PasswordException" })

		const doc = await open(bytes, "pässwörd 1")
		const text = (await (await doc.getPage(1)).getTextContent()).items.map(item => ("str" in item ? item.str : "")).join("|")

		expect(text).toContain("Synthetic document")
		expect((await doc.getMetadata()).info).toMatchObject({ EncryptFilterName: "Standard", Title: "Synthetic PDF – Ünïcode" })
		expect(latin1(bytes)).toContain("/R 6")
		// Nothing readable outside the encryption: no text strings, no plain content.
		expect(latin1(bytes)).not.toContain("Synthetic PDF")
	})

	it("passes JPEG through and turns it upright for its EXIF orientation", async () => {
		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const image = await writer.image({ data: JPEG_32x24 })
		const page = writer.beginPage(100, 100)

		page.drawImage({ ...image, orientation: 6 }, 10, 20, 30, 40)
		await writer.endPage(page)

		const bytes = await bytesOf(writer)
		const text = latin1(bytes)

		expect(text).toContain("/Filter /DCTDecode")
		expect(text).toContain("/Width 32 /Height 24")
		// The whole JPEG as the stream.
		expect(Buffer.from(bytes).indexOf(Buffer.from(JPEG_32x24))).toBeGreaterThan(0)
		// Orientation 6 (a quarter turn clockwise): image x runs down the box, y runs leftwards.
		expect(text).toContain("0 40 30 0 10 20 cm")
	})

	it("reads Adobe CMYK JPEG frames as inverted and refuses frames DCTDecode cannot take", async () => {
		const segment = (marker: number, body: number[]): number[] => [
			0xff,
			marker,
			(body.length + 2) >> 8,
			(body.length + 2) & 255,
			...body
		]
		const adobe = segment(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 2])
		const frame = (marker: number, precision: number, components: number): number[] =>
			segment(marker, [precision, 0, 10, 0, 20, components, ...Array.from({ length: components * 3 }, () => 1)])
		const jpeg = (...segments: number[][]): ByteSource => new ByteSource(Uint8Array.from([0xff, 0xd8, ...segments.flat()]))

		expect(await readJpeg(jpeg(adobe, frame(0xc2, 8, 4)))).toMatchObject({
			width: 20,
			height: 10,
			components: 4,
			adobe: true,
			passthrough: true
		})
		expect(await readJpeg(jpeg(frame(0xc0, 12, 3)))).toMatchObject({ passthrough: false })
		expect(await readJpeg(jpeg(frame(0xc9, 8, 3)))).toMatchObject({ passthrough: false })

		const writer = await PdfWriter.create({ deterministic: true, deflate: null })

		await writer.image({ data: Uint8Array.from([0xff, 0xd8, ...adobe, ...frame(0xc0, 8, 4), 0xff, 0xd9]) })

		const text = latin1(await bytesOf(writer))

		expect(text).toContain("/ColorSpace /DeviceCMYK")
		expect(text).toContain("/Decode [1 0 1 0 1 0 1 0]")
	})

	it("reads the EXIF orientation of a JPEG", async () => {
		// APP1 "Exif\0\0", big-endian TIFF header, one IFD entry: Orientation (0x0112) SHORT 1 = 6.
		const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]
		const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
		const bytes = Uint8Array.from([
			0xff,
			0xd8,
			0xff,
			0xe1,
			0,
			app1.length + 2,
			...app1,
			0xff,
			0xc0,
			0,
			17,
			8,
			0,
			10,
			0,
			20,
			3,
			...Array.from({ length: 9 }, () => 1)
		])

		expect(await readJpeg(new ByteSource(bytes))).toMatchObject({ orientation: 6, width: 20, height: 10, passthrough: true })
	})

	it("draws display-list paths: quadratics as the same cubic, points through the matrix, even-odd fill", async () => {
		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const page = writer.beginPage(100, 100)
		// MOVE 0,0  QUAD 30,60 60,0  CLOSE
		const commands = new Uint8Array([0, 3, 4])
		const coords = new Float32Array([0, 0, 30, 60, 60, 0])

		page.pathCommands(commands, coords, 0, 3, 0, [1, 0, 0, 1, 10, 5])
		page.fill(true)
		await writer.endPage(page)

		const text = inflatedStreams(await bytesOf(writer))

		expect(text).toContain("10 5 m\n30 45 50 45 70 5 c\nh\nf*")
	})

	it("passes non-interlaced PNG through as its IDAT data and decodes alpha and interlaced PNG", async () => {
		const decoder = new TestDecoder()
		const writer = await PdfWriter.create({ deterministic: true, deflate: null, decoder })
		const rgb = encodePng({ width: 9, height: 7, colorType: 2, pixel: (x, y) => [x, y, 7], idatSize: 20 })
		const gray = encodePng({ width: 5, height: 5, colorType: 0, pixel: x => [x * 50], transparency: [0, 0] })

		await writer.image({ data: rgb })
		await writer.image({ data: gray })
		expect(decoder.calls).toBe(0)

		await writer.image({ data: encodePng({ width: 4, height: 4, colorType: 6, pixel: () => [1, 2, 3, 128] }) })
		await expect(
			writer.image({ data: encodePng({ width: 4, height: 4, colorType: 2, pixel: () => [1, 2, 3], interlaced: true }) })
		).resolves.toBeDefined()
		expect(decoder.calls).toBe(2)

		const text = latin1(await bytesOf(writer))

		expect(text).toContain("/DecodeParms <</Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns 9>>")
		expect(text).toContain("/Mask [0 0]")
		expect(text).toMatch(/\/SMask \d+ 0 R/)
	})

	it("keeps one transparent palette entry as a colour key and decodes partial palette alpha", async () => {
		const decoder: PdfImageDecoder = { decode: () => Promise.reject(new PdfWriteError("imageUnsupported", "test")) }
		const writer = await PdfWriter.create({ deterministic: true, deflate: null, decoder })
		const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255]

		await writer.image({ data: encodePng({ width: 3, height: 1, colorType: 3, palette, transparency: [255, 0], pixel: x => [x] }) })
		await expect(
			writer.image({ data: encodePng({ width: 3, height: 1, colorType: 3, palette, transparency: [128], pixel: x => [x] }) })
		).rejects.toMatchObject({ reason: "imageUnsupported" })

		const text = latin1(await bytesOf(writer))

		expect(text).toContain("/ColorSpace [/Indexed /DeviceRGB 2 <FF000000FF000000FF>]")
		expect(text).toContain("/Mask [1 1]")
	})

	it("embeds the same image once per key", async () => {
		const writer = await PdfWriter.create({ deterministic: true })
		const a = await writer.image({ data: JPEG_32x24, key: "word/media/image1.jpeg" })
		const b = await writer.image({ data: JPEG_32x24.slice(), key: "word/media/image1.jpeg" })
		const c = await writer.image({ data: JPEG_32x24 })

		expect(b).toBe(a)
		// Same bytes without a key: found by content.
		expect(c).toBe(a)
	})

	it("embeds identical bytes once whatever object holds them, and keeps different bytes apart", async () => {
		const writer = await PdfWriter.create({ deterministic: true })
		const big = encodePng({ width: 300, height: 200, colorType: 2, pixel: (x, y) => [x & 255, y, (x * y) & 255] })
		// Copies (Buffer.slice would share memory).
		const changed = new Uint8Array(big)

		// One byte inside the image data, wherever the hash samples.
		const at = Math.floor(changed.length / 2) + 3

		changed[at] = (changed[at] ?? 0) ^ 1

		const a = await writer.image({ data: big })
		const b = await writer.image({ data: new Uint8Array(big) })
		const c = await writer.image({ data: new Blob([big]) })
		const d = await writer.image({ data: changed })

		expect(b).toBe(a)
		expect(c).toBe(a)
		expect(d).not.toBe(a)
	})

	it("reads an image source only once when the same object comes again", async () => {
		const writer = await PdfWriter.create({ deterministic: true })
		const blob = new Blob([JPEG_32x24])
		let reads = 0
		const counting = (inner: Blob): PdfBlobLike => ({
			size: inner.size,
			slice: (start, end) => counting(inner.slice(start, end)),
			arrayBuffer: () => {
				reads++

				return inner.arrayBuffer()
			}
		})
		const source = counting(blob)
		const first = await writer.image({ data: source })
		const seen = reads

		expect(await writer.image({ data: source })).toBe(first)
		expect(reads).toBe(seen)
	})

	it("leaves no dangling name when a link or bookmark targets a destination never defined", async () => {
		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const page = writer.beginPage(100, 100)

		page.link([0, 0, 10, 10], { uri: "#missing-anchor" })
		page.link([0, 20, 10, 10], { dest: "kept-anchor" })
		writer.destination("kept-anchor", { page: 0, y: 10 })
		writer.outline("Nowhere", 1, "missing-bookmark")
		writer.outline("Somewhere", 1, "kept-anchor")
		await writer.endPage(page)

		const bytes = await bytesOf(writer)
		const text = inflatedStreams(bytes)

		expect(text).not.toMatch(/\/(Dest|Names)[^\n]*missing/)
		// A link's name is the name tree key's bytes (hex: "kept-anchor").
		expect(text.toLowerCase()).toContain(`/dest <${Buffer.from("kept-anchor").toString("hex")}>`)

		const doc = await open(bytes)
		const annotations = await (await doc.getPage(1)).getAnnotations()

		// Both links stay; the one to the undefined name has no destination.
		expect(annotations.map(annotation => [annotation.subtype, annotation.dest ?? null])).toEqual([
			["Link", null],
			["Link", "kept-anchor"]
		])
		expect((await doc.getOutline()).map(item => [item.title, item.dest])).toEqual([
			["Nowhere", null],
			["Somewhere", "kept-anchor"]
		])
	})

	it("resolves links and bookmarks to destinations named outside ASCII", async () => {
		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const page = writer.beginPage(100, 100)

		for (const [index, name] of ["Глава", "第一章", "Café"].entries()) {
			page.link([0, index * 20, 10, 10], { dest: name })
			writer.destination(name, { page: 0, y: 10 + index })
			writer.outline(name, 1, name)
		}

		await writer.endPage(page)

		const doc = await open(await bytesOf(writer))
		const annotations = await (await doc.getPage(1)).getAnnotations()
		const resolved = async (dest: unknown): Promise<unknown> => (typeof dest === "string" ? await doc.getDestination(dest) : dest)
		const links = await Promise.all(annotations.map(annotation => resolved(annotation.dest)))
		const bookmarks = await Promise.all((await doc.getOutline()).map(item => resolved(item.dest)))

		expect(links.map(dest => (dest as unknown[] | null)?.[3] ?? null)).toEqual([67.5, 66.75, 66])
		expect(bookmarks).toEqual(links)
	})

	it("refuses links outside the link policy and maps fragments to named destinations", async () => {
		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const page = writer.beginPage(100, 100)

		expect(page.link([0, 0, 10, 10], { uri: "javascript:alert(1)" })).toBe(false)
		expect(page.link([0, 0, 10, 10], { uri: "file:///etc/passwd" })).toBe(false)
		expect(page.link([0, 0, 10, 10], { uri: "#chapter" })).toBe(true)
		expect(page.link([0, 0, 10, 10], { uri: "https://例え.jp/ä" })).toBe(true)
		writer.destination("chapter", { page: 0, y: 50 })
		await writer.endPage(page)

		const text = inflatedStreams(await bytesOf(writer))

		expect(text).not.toContain("javascript")
		expect(text.toLowerCase()).toContain(`/dest <${Buffer.from("chapter").toString("hex")}>`)
		expect(text).toContain("/URI (https://%E4%BE%8B%E3%81%88.jp/%C3%A4)")
		expect(text).toMatch(/\/Names \[<63686170746572> \[\d+ 0 R \/XYZ null 37.5 null\]\]/)
	})

	it("refuses unbalanced marked content and graphics states", async () => {
		const writer = await PdfWriter.create({ tagged: true })
		const page = writer.beginPage(100, 100)
		const node = writer.open("P")

		page.beginContent(node)
		expect(() => page.endArtifact()).toThrow(PdfWriteError)
		await expect(writer.endPage(page)).rejects.toMatchObject({ reason: "unbalanced" })

		page.endContent()
		page.saveState()
		await expect(writer.endPage(page)).rejects.toMatchObject({ reason: "unbalanced" })
		page.restoreState()
		expect(() => page.restoreState()).toThrow(PdfWriteError)
		await writer.endPage(page)
		await expect(writer.finish()).rejects.toMatchObject({ reason: "unbalanced" })
		expect(() => writer.open("Heading9")).toThrow(PdfWriteError)
	})

	it("claims PDF/UA only with a title to show (dc:title, Info /Title, DisplayDocTitle; ISO 14289-1 §7.1)", async () => {
		const written = async (title: string | undefined): Promise<string> => {
			const writer = await PdfWriter.create({
				tagged: true,
				deterministic: true,
				deflate: null,
				...(title === undefined ? {} : { title })
			})
			const page = writer.beginPage(100, 100)
			const node = writer.open("P")

			page.beginContent(node)
			page.rect(0, 0, 1, 1).fill()
			page.endContent()
			writer.close(node)
			await writer.endPage(page)

			return new TextDecoder("latin1").decode(await bytesOf(writer))
		}
		const titled = await written("Report")

		expect(titled).toContain("<pdfuaid:part>1</pdfuaid:part>")
		expect(titled).toContain('<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Report</rdf:li></rdf:Alt></dc:title>')
		expect(titled).toContain("/Title (Report)")
		expect(titled).toContain("/DisplayDocTitle true")

		// No title, or a blank one: still tagged, but no claim a reader would find false.
		for (const title of [undefined, " \t"]) {
			const untitled = await written(title)

			expect(untitled).toContain("/StructTreeRoot")
			expect(untitled).not.toContain("pdfuaid:part")
			expect(untitled).not.toContain("dc:title")
			expect(untitled).not.toContain("/DisplayDocTitle")
		}
	})

	it("maps a non-standard structure type through the role map", async () => {
		const writer = await PdfWriter.create({ tagged: true, deterministic: true, deflate: null })
		const page = writer.beginPage(100, 100)
		const title = writer.open("Title", { role: "H1" })

		page.beginContent(title)
		page.rect(0, 0, 1, 1).fill()
		page.endContent()
		writer.close(title)
		await writer.endPage(page)

		const text = inflatedStreams(await bytesOf(writer))

		expect(text).toContain("/RoleMap <</Title /H1>>")
		expect(text).toContain("/Title <</MCID 0>> BDC")
	})

	it("writes no marked content in an untagged document", async () => {
		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const page = writer.beginPage(100, 100)
		const node = writer.open("P")

		page.beginArtifact({ type: "Pagination" })
		page.beginContent(node)
		page.rect(0, 0, 1, 1).fill()
		page.endContent()
		page.endArtifact()
		writer.close(node)
		await writer.endPage(page)

		const text = inflatedStreams(await bytesOf(writer))

		expect(text).not.toContain("BDC")
		expect(text).not.toContain("StructTreeRoot")
		expect(text).not.toContain("MarkInfo")
	})

	it("aborts at the next page when the signal fires", async () => {
		const signal = { aborted: false, reason: new Error("stop") as unknown }
		const writer = await PdfWriter.create({ signal })
		const page = writer.beginPage(100, 100)

		signal.aborted = true
		await expect(writer.endPage(page)).rejects.toBe(signal.reason)
	})

	it("gives the host a turn once a slice is up", async () => {
		let now = 0
		let pauses = 0
		const writer = await PdfWriter.create({
			slicing: {
				sliceMs: 16,
				now: () => now,
				pause: () => {
					pauses++

					return Promise.resolve()
				}
			}
		})

		for (let index = 0; index < 4; index++) {
			const page = writer.beginPage(100, 100)

			now += index % 2 === 0 ? 20 : 1
			await writer.endPage(page)
		}

		await bytesOf(writer)
		expect(pauses).toBe(2)
	})

	it("positions shaped glyphs with TJ: shaping advances, mark offsets, rise and the spread to the layout width", async () => {
		const font = new StubFont()
		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const page = writer.beginPage(200, 100)
		const shaped = font.shape("AV A")
		const a = font.advance(shaped.glyphs[0] ?? 0)
		const run: PdfTextRun = {
			...shaped,
			// Kerning AV by -80, a mark offset +30 x and +100 y on the last glyph.
			advances: Float32Array.from(shaped.advances, (advance, index) => (index === 0 ? advance - 80 : advance)),
			dx: Float32Array.from([0, 0, 0, 30]),
			dy: Float32Array.from([0, 0, 0, 100])
		}

		page.text([run], {
			x: 10,
			y: 50,
			size: 10,
			text: "AV A",
			wordSpacing: 1,
			width: naturalWidth([run], 10) + 1 + 3,
			color: 0xff000080
		})
		page.text([font.shape("Wide")], { x: 10, y: 80, size: 10, width: 100, fit: "scale" })
		await writer.endPage(page)

		const text = inflatedStreams(await bytesOf(writer))
		const glyph = (index: number): number => shaped.glyphs[index] ?? 0

		expect(a).toBeGreaterThan(0)
		// 1/1000 em at 10 px: 1 px is 100. The spread (1 px per gap) is character spacing; kerned -80; the space adds
		// 1 px of word spacing; the mark goes 0.3 px right of its pen position, raised 1 px in a TJ of its own.
		expect(text).toContain("1 Tc\n")
		expect(text).toContain(`[${codes(glyph(0))} 80 ${codes(glyph(1), glyph(2))}] TJ\n1 Ts\n[-130 ${codes(glyph(3))}] TJ`)
		expect(text).toContain("0 Ts")
		expect(text).toContain("0 Tc")
		expect(text).toMatch(/1 0 0 -1 10 50 Tm/)
		expect(text).toContain("1 0 0 rg")
		expect(text).toMatch(/\d+(\.\d+)? Tz/)
		expect(text).toContain("100 Tz")
	})

	it("writes no pen move under 1.5/1000 em, carrying it to the next glyph", async () => {
		const font = new StubFont()
		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const page = writer.beginPage(200, 100)
		const shaped = font.shape("AAAA")
		// Each advance 0.6/1000 em past what /W says: 0.6 and 1.2 are carried, 1.8 is written (as 2) before the fourth.
		const run: PdfTextRun = { ...shaped, advances: Float32Array.from(shaped.advances, advance => advance + 0.6) }

		page.text([run], { x: 0, y: 50, size: 10 })
		await writer.endPage(page)

		const glyph = shaped.glyphs[0] ?? 0

		expect(inflatedStreams(await bytesOf(writer))).toContain(`[${codes(glyph, glyph, glyph)} -2 ${codes(glyph)}] TJ`)
	})

	it("wraps runs ToUnicode cannot express in an ActualText span", async () => {
		const font = new StubFont()
		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const page = writer.beginPage(100, 100)

		page.text([font.shape("f", { actualText: "ffi" })], { x: 0, y: 10, size: 10 })
		await writer.endPage(page)

		const text = inflatedStreams(await bytesOf(writer))

		// ASCII text strings are PDFDocEncoding (no byte order mark).
		expect(text).toContain("/Span <</ActualText <666669>>> BDC")
		expect(text).toContain("EMC")
	})

	it("writes gradients as stitched shadings with a soft mask for varying alpha", async () => {
		const writer = await PdfWriter.create({ deterministic: true, deflate: null })
		const page = writer.beginPage(100, 100)

		await page.gradient({
			type: "axial",
			coords: [0, 0, 100, 0],
			offsets: [0, 0.5, 0.5, 1],
			colors: [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff],
			bounds: [0, 0, 100, 100]
		})
		await page.gradient({
			type: "radial",
			coords: [50, 50, 0, 50, 50, 50],
			offsets: [0, 1],
			colors: [0x000000ff, 0x00000000],
			bounds: [0, 0, 100, 100]
		})
		await page.gradient({
			type: "axial",
			coords: [0, 0, 10, 0],
			offsets: [0, 1],
			colors: [0x00000080, 0xffffff80],
			spread: "repeat",
			bounds: [0, 0, 100, 100]
		})
		await writer.endPage(page)

		const text = inflatedStreams(await bytesOf(writer))

		// A hard stop at 0.5 is a bound, never an empty interval.
		expect(text).toContain(
			"/FunctionType 3 /Domain [0 1] /Functions [<</FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 1 0] /N 1>> <</FunctionType 2 /Domain [0 1] /C0 [0 0 1] /C1 [1 1 1] /N 1>>] /Bounds [0.5]"
		)
		expect(text).toContain("/S /Luminosity")
		expect(text).toContain("/ColorSpace /DeviceGray")
		// Repeat over 100 px of a 10 px period: domain 0..10, ten periods.
		expect(text).toContain("/Coords [0 0 100 0] /Domain [0 10]")
		expect(text).toContain("/ca 0.502")
	})

	it("writes numbers without exponents and escapes names and strings", () => {
		const out = new ByteWriter(8)

		out.num(1e-7).space().num(-0.0004).space().num(123456.78912).space().num(-2.5).space().int(-1203)
		expect(Buffer.from(out.view()).toString()).toBe("0 0 123456.789 -2.5 -1203")
		expect(Buffer.from(serialize({ "A B": pdfName("x/y#z"), S: "a(b)\\c", U: "ü" })).toString("latin1")).toBe(
			"<</A#20B /x#2Fy#23z /S (a\\(b\\)\\\\c) /U <FEFF00FC>>>"
		)
	})

	it("prepares passwords with SASLprep and refuses what it prohibits", () => {
		expect(Buffer.from(preparePassword("a b­c")).toString()).toBe("a bc")
		expect(Buffer.from(preparePassword("Ⅸ")).toString()).toBe("IX")
		expect(preparePassword("x".repeat(200)).length).toBe(127)
		expect(preparePassword("é".repeat(100)).length).toBe(126)
		expect(() => preparePassword("a\u0007b")).toThrow(PdfWriteError)
		expect(() => preparePassword("אaב")).toThrow(PdfWriteError)
		expect(Buffer.from(preparePassword("אב")).length).toBe(4)
	})

	it("writes a page link to a later page and refuses one to a page never written", async () => {
		const writer = await PdfWriter.create({ deterministic: true })
		const first = writer.beginPage(100, 100)

		first.link([0, 0, 10, 10], { page: 1 })
		first.link([0, 0, 10, 10], { page: 5 })
		await writer.endPage(first)
		await writer.endPage(writer.beginPage(100, 100))
		await expect(writer.finish()).rejects.toMatchObject({ reason: "state" })
	})

	it("closes every font after writing it", async () => {
		const font = new StubFont()
		const writer = await PdfWriter.create({ deterministic: true })
		const page = writer.beginPage(100, 100)

		page.text([font.shape("Hi")], { x: 0, y: 10, size: 10 })
		await writer.endPage(page)

		const doc = await open(await bytesOf(writer))

		expect(font.closed).toBe(true)
		expect((await (await doc.getPage(1)).getTextContent()).items.map(item => ("str" in item ? item.str : ""))).toContain("Hi")
	})
})
