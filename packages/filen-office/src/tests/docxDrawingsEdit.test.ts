import type { Node } from "prosemirror-model"
import { NodeSelection, TextSelection, type EditorState } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { Item, type DrawingInfo } from "@filen/office/core/docx"
import { docxSchema, type DocxEditorCommand } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { saveDocx } from "@filen/office/core/docx/write"
import { parseXml } from "@filen/office/core/xml"
import { changeDrawing, drawingState, mediaInUse, releaseUnusedMedia, settleMedia } from "../core/docx/objects/edit"
import { editHeader } from "../core/docx/stories/headers"
import { MAX_IMAGE_PIXELS, naturalExtent, sniffImage, type DocxImageInfo } from "../core/docx/objects/images"
import { editStyle } from "../core/docx/write/atoms/drawings"
import { openBytes } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { pageDigest, pagedEditor, savedDigest, settleAll } from "./pagedFixtures"
import { CropDrag, DrawingDrag, cropSides, handlePoints, moveCommand, resizedBox } from "../react/docx/edit/objects"

const nodes = docxSchema.nodes
const decoder = new TextDecoder()

// ---- pictures --------------------------------------------------------------------------------------------

function u32(value: number): number[] {
	return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
}

function chunk(type: string, data: readonly number[]): number[] {
	return [...u32(data.length), ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0]
}

// A PNG header of a width x height picture (pHYs for `dpi`); the pixels are not needed to place it.
export function png(width: number, height: number, dpi?: number): Uint8Array {
	const ppm = dpi === undefined ? 0 : Math.round(dpi / 0.0254)

	return new Uint8Array([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...chunk("IHDR", [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
		...(dpi === undefined ? [] : chunk("pHYs", [...u32(ppm), ...u32(ppm), 1])),
		...chunk("IEND", [])
	])
}

function jpeg(width: number, height: number, dpi: number): Uint8Array {
	return new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xe0,
		0,
		16,
		0x4a,
		0x46,
		0x49,
		0x46,
		0,
		1,
		1,
		1,
		dpi >> 8,
		dpi & 255,
		dpi >> 8,
		dpi & 255,
		0,
		0,
		0xff,
		0xc0,
		0,
		11,
		8,
		height >> 8,
		height & 255,
		width >> 8,
		width & 255,
		1,
		1,
		0x11,
		0,
		0xff,
		0xd9
	])
}

const SVG = new TextEncoder().encode(
	'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1in" viewBox="0 0 200 100"/>'
)

function inlinePicture(cx: number, cy: number, id = 1, rel = "rIdImg", descr?: string): string {
	return (
		`<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" wp14:anchorId="1A2B3C4D"><wp:extent cx="${cx}" cy="${cy}"/>` +
		`<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}"${descr === undefined ? "" : ` descr="${descr}"`}/>` +
		'<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
		'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr>' +
		`<pic:cNvPr id="0" name="a.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
		`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
		"</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
	)
}

function anchoredShape(cx: number, cy: number): string {
	const choice =
		'<w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
		'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>12700</wp:posOffset></wp:positionH>' +
		'<wp:positionV relativeFrom="paragraph"><wp:posOffset>25400</wp:posOffset></wp:positionV>' +
		`<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
		'<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon edited="1"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21000"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon></wp:wrapTight>' +
		'<wp:docPr id="7" name="Rectangle 7"/><wp:cNvGraphicFramePr/>' +
		'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/>' +
		`<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>` +
		"<wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>"
	const fallback =
		'<w:pict><v:rect id="Rectangle 7" o:spid="_x0000_s1026" style="position:absolute;margin-left:1pt;margin-top:2pt;width:150pt;height:75pt;z-index:251659264;mso-position-horizontal-relative:text;mso-position-vertical-relative:text">' +
		'<w10:wrap type="tight"/></v:rect></w:pict>'

	return `<w:r><mc:AlternateContent><mc:Choice Requires="wps">${choice}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent></w:r>`
}

const W10 = 'xmlns:w10="urn:schemas-microsoft-com:office:word"'

function docx(body: string, media = true): Uint8Array {
	return buildDocx({
		document:
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
			'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
			'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
			'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
			'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" ' +
			`${W10} mc:Ignorable="wp14"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
		...(media
			? {
					relationships: [{ id: "rIdImg", type: "image", target: "media/a.png" }],
					parts: [{ name: "word/media/a.png", data: png(200, 100) }]
				}
			: {})
	})
}

// An inline picture with a:srcRect `rect` after its blip.
function croppedPicture(cx: number, cy: number, rect: string): string {
	return inlinePicture(cx, cy).replace('<a:blip r:embed="rIdImg"/>', `<a:blip r:embed="rIdImg"/>${rect}`)
}

// A picture in mc:AlternateContent with the VML copy Word keeps for older readers.
function alternatePicture(cx: number, cy: number): string {
	const fallback =
		'<w:pict><v:shape id="Picture 1" o:spid="_x0000_i1025" type="#_x0000_t75" style="width:150pt;height:75pt">' +
		'<v:imagedata r:id="rIdImg" o:title=""/></v:shape></w:pict>'

	return inlinePicture(cx, cy).replace(
		/<w:drawing>.*<\/w:drawing>/,
		drawing =>
			`<mc:AlternateContent><mc:Choice Requires="wps">${drawing}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`
	)
}

const INLINE = docx(
	p("Before") + `<w:p>${'<w:r><w:t xml:space="preserve">Picture </w:t></w:r>'}${inlinePicture(1905000, 952500)}</w:p>` + p("After")
)
const ANCHORED = docx(
	`<w:p>${anchoredShape(1905000, 952500)}<w:r><w:t>Text beside a shape that wraps tightly.</w:t></w:r></w:p>` + p("After")
)

// ---- helpers ---------------------------------------------------------------------------------------------

function drawingPos(doc: Node, index = 0): number {
	let found = -1
	let count = 0

	doc.descendants((node, pos) => {
		if (found >= 0) return false
		if (node.type === nodes.drawing) {
			if (count++ === index) found = pos
		}

		return true
	})

	if (found < 0) throw new Error("no drawing")

	return found
}

function select(editor: PagedEditor, index = 0): void {
	const doc = editor.session.state.doc

	editor.dispatch(editor.session.state.tr.setSelection(NodeSelection.create(doc, drawingPos(doc, index))))
}

async function run(editor: PagedEditor, command: DocxEditorCommand): Promise<boolean> {
	const result = await editor.execute(command)

	await settleAll(editor)

	return result
}

interface Saved {
	readonly bytes: Uint8Array
	readonly drawings: readonly DrawingInfo[]
}

async function saved(
	editor: PagedEditor,
	pkg: Parameters<typeof saveDocx>[0]["pkg"],
	context: Parameters<typeof saveDocx>[0]["context"]
): Promise<Saved> {
	const result = await saveDocx({ pkg, context, sessions: editor.sessions })
	const bytes = result.bytes as Uint8Array
	const opened = await openBytes(bytes)

	return {
		bytes,
		drawings: opened.model.drawings.filter((drawing): drawing is DrawingInfo => drawing !== undefined)
	}
}

async function partText(bytes: Uint8Array, name: string): Promise<string | undefined> {
	const opened = await openBytes(bytes)

	return opened.pkg.has(name) ? decoder.decode(await opened.pkg.opc.read(name)) : undefined
}

async function sameLayout(editor: PagedEditor, bytes: Uint8Array): Promise<void> {
	await settleAll(editor)
	expect(pageDigest(editor.layout)).toEqual(await savedDigest(bytes))
}

// ---- tests -----------------------------------------------------------------------------------------------

describe("docx picture sniffing", () => {
	it("reads format, pixel size and resolution from headers only", () => {
		expect(sniffImage(png(300, 150, 300))).toMatchObject({ format: "png", width: 300, height: 150, contentType: "image/png" })
		expect((sniffImage(png(300, 150, 300)) as DocxImageInfo).dpiX).toBeCloseTo(300, 0)
		expect(sniffImage(jpeg(640, 480, 72))).toMatchObject({ format: "jpeg", width: 640, height: 480, dpiX: 72, extension: "jpeg" })
		expect(sniffImage(SVG)).toMatchObject({ format: "svg", width: 192, height: 96 })
		expect(naturalExtent(sniffImage(png(96, 48)) as DocxImageInfo)).toEqual({ cx: 914400, cy: 457200 })
		expect(naturalExtent(sniffImage(png(300, 150, 300)) as DocxImageInfo).cx).toBeCloseTo(914400, -3)

		// An EXIF orientation of a quarter turn (6: turned clockwise) shows the frame turned.
		const exif = (orientation: number): Uint8Array => {
			const frame = jpeg(640, 480, 72)
			// APP1 "Exif": a big-endian TIFF header, IFD0 with the orientation (a SHORT) alone.
			const app1 = [0xff, 0xe1, 0, 34, ..."Exif\0\0", ..."MM\0*"].map(value =>
				typeof value === "string" ? value.charCodeAt(0) : value
			)

			return new Uint8Array([
				...frame.slice(0, 2),
				...app1,
				0,
				0,
				0,
				8,
				0,
				1,
				0x01,
				0x12,
				0,
				3,
				0,
				0,
				0,
				1,
				0,
				orientation,
				0,
				0,
				0,
				0,
				0,
				0,
				...frame.slice(2)
			])
		}

		expect(sniffImage(exif(6))).toMatchObject({ format: "jpeg", width: 480, height: 640 })
		expect(sniffImage(exif(3))).toMatchObject({ format: "jpeg", width: 640, height: 480 })
	})

	it("refuses what Word does not read, and pictures past the limits", () => {
		expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp")
		expect(sniffImage(new Uint8Array([1, 2, 3, 4]))).toBe("format")
		expect(sniffImage(png(5000, 5000))).toBe("pixels")
		expect(5000 * 5000).toBeGreaterThan(MAX_IMAGE_PIXELS)
		expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("corrupt")

		const svg = (text: string): ReturnType<typeof sniffImage> => sniffImage(new TextEncoder().encode(text))

		// A DOCTYPE that could expand is refused, judged over its whole subset; plain string entities are fine.
		expect(svg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "x"><!ENTITY b "&a;&a;">]><svg width="10" height="10"/>')).toBe("format")
		expect(svg('<!DOCTYPE svg [<!ENTITY a "]>"><!ENTITY % p "x">]><svg width="10" height="10"/>')).toBe("format")
		expect(svg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>')).toBe("format")
		expect(svg('<!DOCTYPE svg [<!ENTITY ns_svg "http://www.w3.org/2000/svg">]><svg width="10" height="20"/>')).toMatchObject({
			format: "svg",
			width: 10,
			height: 20
		})
		expect(svg('<!DOCTYPE svg [<!ENTITY a "<svg">')).toBe("corrupt")
		// Vector pictures are not held to the pixel limit by the size they declare.
		expect(svg('<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"/>')).toMatchObject({ format: "svg" })
	})

	it("edits VML styles property by property", () => {
		expect(
			editStyle(
				"position:absolute;width:10pt;height:5pt",
				new Map([
					["width", "20pt"],
					["rotation", "90"]
				])
			)
		).toBe("position:absolute;width:20pt;height:5pt;rotation:90")
		expect(editStyle("width:1pt;Margin-Left:3pt", new Map([["margin-left", null]]))).toBe("width:1pt")
	})
})

describe("docx drawing commands", () => {
	it("resizes an inline picture keeping its proportions, writes extent and transform, and undoes to the source", async () => {
		const { editor, pkg, context } = await pagedEditor(INLINE)

		select(editor)
		expect(editor.snapshot().context.drawing).toMatchObject({
			kind: "picture",
			wrap: "inline",
			cx: 1905000,
			cy: 952500,
			resizable: true
		})
		expect(editor.canExecute("drawing.resize")).toBe(true)
		expect(editor.canExecute("drawing.position")).toBe(false)

		expect(await run(editor, { type: "drawing.resize", cx: 3810000, cy: 100, keepRatio: true })).toBe(true)
		expect(editor.snapshot().context.drawing).toMatchObject({ cx: 3810000, cy: 1905000 })

		const after = await saved(editor, pkg, context)

		expect(after.drawings[0]).toMatchObject({ width: 3810000, height: 1905000, placement: "inline" })

		const xml = (await partText(after.bytes, "word/document.xml")) ?? ""

		expect(xml).toContain('<a:ext cx="3810000" cy="1905000"/>')
		expect(xml).toContain('wp14:anchorId="1A2B3C4D"')
		await sameLayout(editor, after.bytes)

		expect(await run(editor, { type: "history.undo" })).toBe(true)

		const back = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(await partText(back.bytes as Uint8Array, "word/document.xml")).toBe(await partText(INLINE, "word/document.xml"))
	})

	// A percentage as thousandths of a percent, or as Strict writes it ("NN%").
	for (const height of ["20000", "20%"]) {
		it(`turns a relative size (${height}) absolute along the axis a resize sets, as Word writes an absolute size`, async () => {
			const relative = docx(
				`<w:p>${anchoredShape(1905000, 952500)
					.replace(
						"</wp:anchor>",
						`<wp14:sizeRelH relativeFrom="margin"><wp14:pctWidth>40000</wp14:pctWidth></wp14:sizeRelH><wp14:sizeRelV relativeFrom="margin"><wp14:pctHeight>${height}</wp14:pctHeight></wp14:sizeRelV></wp:anchor>`
					)
					.replace("height:75pt;", "height:75pt;mso-width-percent:400;mso-height-percent:200;mso-height-percent:200;")}</w:p>` +
					p("After")
			)
			const { editor, pkg, context } = await pagedEditor(relative)

			select(editor)
			expect(await run(editor, { type: "drawing.resize", cx: 1905000, cy: 1905000 })).toBe(true)

			const after = await saved(editor, pkg, context)
			const xml = (await partText(after.bytes, "word/document.xml")) ?? ""

			expect(xml).toContain("<wp14:pctWidth>40000</wp14:pctWidth>")
			expect(xml).toContain("<wp14:pctHeight>0</wp14:pctHeight>")
			expect(xml).toContain("height:150pt;mso-width-percent:400;mso-height-percent:0;")
			await sameLayout(editor, after.bytes)
		})
	}

	it("sets and clears alt text on wp:docPr and the picture", async () => {
		const { editor, pkg, context } = await pagedEditor(INLINE)

		select(editor)
		expect(await run(editor, { type: "drawing.altText", text: 'A "bar" chart & <more>' })).toBe(true)

		const xml = (await partText((await saved(editor, pkg, context)).bytes, "word/document.xml")) ?? ""

		expect(xml).toContain('descr="A &quot;bar&quot; chart &amp; &lt;more>"')
		expect(xml.match(/descr=/g)).toHaveLength(2)
		expect(editor.snapshot().context.drawing?.altText).toBe('A "bar" chart & <more>')

		select(editor)
		expect(await run(editor, { type: "drawing.altText", text: "" })).toBe(true)
		expect(editor.snapshot().context.drawing?.altText).toBe("")

		// Described, a picture marked decorative is no longer marked so.
		const decorative = await pagedEditor(
			docx(
				`<w:p>${inlinePicture(1905000, 952500).replace(
					'name="Picture 1"/>',
					'name="Picture 1"><a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst></wp:docPr>'
				)}</w:p>`
			)
		)

		select(decorative.editor)
		expect(await run(decorative.editor, { type: "drawing.altText", text: "A logo" })).toBe(true)

		const described =
			(await partText((await saved(decorative.editor, decorative.pkg, decorative.context)).bytes, "word/document.xml")) ?? ""

		expect(described).toContain('name="Picture 1" descr="A logo"><a:extLst>')
		expect(described).toContain('<adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="0"/>')
	})

	it("rotates in quarter turns, the inline effect extent covering the turned box", async () => {
		const { editor, pkg, context } = await pagedEditor(INLINE)

		select(editor)
		expect(await run(editor, { type: "drawing.rotate", by: 90 })).toBe(true)

		const after = await saved(editor, pkg, context)
		const xml = (await partText(after.bytes, "word/document.xml")) ?? ""

		expect(xml).toContain('<a:xfrm rot="5400000">')
		expect(xml).toContain('<wp:effectExtent l="-476250" t="476250" r="-476250" b="476250"/>')
		expect(after.drawings[0]).toMatchObject({ effectLeft: -476250, effectTop: 476250 })
		await sameLayout(editor, after.bytes)

		select(editor)
		expect(await run(editor, { type: "drawing.rotate", by: 270 })).toBe(true)
		expect(editor.snapshot().context.drawing?.rotation).toBe(0)
		expect(editor.session.state.selection instanceof NodeSelection).toBe(true)
	})

	it("turns an inline picture into a floating one and back, wrapping and moving it", async () => {
		const { editor, pkg, context } = await pagedEditor(INLINE)

		select(editor)
		expect(await run(editor, { type: "drawing.wrap", mode: "square" })).toBe(true)
		expect(editor.snapshot().context.drawing).toMatchObject({ wrap: "square", anchored: true, relH: "column", relV: "paragraph" })

		let after = await saved(editor, pkg, context)

		expect(after.drawings[0]).toMatchObject({ placement: "anchor", anchor: { wrap: "square", behindDoc: false } })
		await sameLayout(editor, after.bytes)
		// The z order it is laid out with in the editor is the one saved, and saved again, the same bytes.
		await settleAll(editor)
		expect(editor.layout.objects.floats.map(float => float?.zOrder).filter(z => z !== undefined)).toEqual([
			after.drawings[0]?.anchor?.relativeHeight
		])
		expect(await partText((await saved(editor, pkg, context)).bytes, "word/document.xml")).toBe(
			await partText(after.bytes, "word/document.xml")
		)

		select(editor)
		expect(await run(editor, { type: "drawing.position", x: 914400, y: 457200, relH: "page", relV: "page" })).toBe(true)
		after = await saved(editor, pkg, context)
		expect(after.drawings[0]?.anchor).toMatchObject({
			horizontal: { relativeFrom: "page", offset: 914400 },
			vertical: { relativeFrom: "page", offset: 457200 }
		})
		await sameLayout(editor, after.bytes)

		select(editor)
		expect(await run(editor, { type: "drawing.wrap", mode: "behind" })).toBe(true)
		after = await saved(editor, pkg, context)
		expect(after.drawings[0]?.anchor).toMatchObject({ wrap: "none", behindDoc: true })
		await sameLayout(editor, after.bytes)

		select(editor)
		expect(await run(editor, { type: "drawing.wrap", mode: "inline" })).toBe(true)
		after = await saved(editor, pkg, context)
		expect(after.drawings[0]).toMatchObject({ placement: "inline", width: 1905000 })

		const xml = (await partText(after.bytes, "word/document.xml")) ?? ""

		expect(xml).toContain('wp14:anchorId="1A2B3C4D"')
		expect(xml).not.toContain("positionH")
		await sameLayout(editor, after.bytes)
	})

	// A picture taller than the page above and below which nothing wraps leaves pages showing none of the body
	// before its paragraph: made small again, the paragraph comes back to the first of them.
	it("lays a paragraph out again from empty pages before it that a picture too tall for them left", async () => {
		const { editor, pkg, context } = await pagedEditor(
			docx(`<w:p>${inlinePicture(1905000, 952500)}<w:r><w:t xml:space="preserve"> Picture</w:t></w:r></w:p>` + p("After"))
		)

		select(editor)
		expect(await run(editor, { type: "drawing.wrap", mode: "topAndBottom" })).toBe(true)
		select(editor)
		expect(await run(editor, { type: "drawing.resize", cx: 1905000, cy: 24000000, keepRatio: false })).toBe(true)
		await sameLayout(editor, (await saved(editor, pkg, context)).bytes)
		select(editor)
		expect(await run(editor, { type: "drawing.resize", cx: 1905000, cy: 952500, keepRatio: false })).toBe(true)
		await sameLayout(editor, (await saved(editor, pkg, context)).bytes)
		expect(editor.pageCount).toBe(1)
	})

	it("keeps a tight wrap's polygon and brings the VML fallback in line", async () => {
		const { editor, pkg, context } = await pagedEditor(ANCHORED)

		select(editor)
		expect(editor.snapshot().context.drawing).toMatchObject({ kind: "shape", wrap: "tight", x: 12700, y: 25400 })
		expect(await run(editor, { type: "drawing.resize", cx: 3810000, cy: 1905000 })).toBe(true)
		select(editor)
		expect(await run(editor, { type: "drawing.wrap", mode: "through" })).toBe(true)
		select(editor)
		expect(await run(editor, { type: "drawing.position", x: 63500, y: 127000 })).toBe(true)

		const after = await saved(editor, pkg, context)
		const xml = (await partText(after.bytes, "word/document.xml")) ?? ""

		expect(xml).toContain(
			'<wp:wrapThrough wrapText="bothSides"><wp:wrapPolygon edited="1"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21000"/>'
		)
		expect(xml).toContain("width:300pt;height:150pt")
		expect(xml).toContain("margin-left:5pt;margin-top:10pt")
		expect(xml).toContain('<w10:wrap type="through"/>')
		expect(xml).toContain("<mc:Fallback>")
		expect(after.drawings[0]).toMatchObject({ width: 3810000, anchor: { wrap: "through", horizontal: { offset: 63500 } } })
		await sameLayout(editor, after.bytes)
	})

	it("deletes the selected drawing, and with it the part only it used; undone, all of it is written again", async () => {
		// The picture's part with its own Override: Word writes neither once nothing uses the part.
		const { editor, pkg, context } = await pagedEditor(
			buildDocx({
				body: p("Before") + `<w:p>${inlinePicture(1905000, 952500)}</w:p>` + p("After"),
				relationships: [{ id: "rIdImg", type: "image", target: "media/a.png" }],
				parts: [{ name: "word/media/a.png", contentType: "image/png", data: png(200, 100) }]
			})
		)

		select(editor)
		expect(await run(editor, { type: "drawing.delete" })).toBe(true)

		const after = await saved(editor, pkg, context)

		expect(after.drawings).toHaveLength(0)
		expect(await partText(after.bytes, "word/media/a.png")).toBeUndefined()
		expect(await partText(after.bytes, "word/_rels/document.xml.rels")).not.toContain('Id="rIdImg"')
		expect(await partText(after.bytes, "[Content_Types].xml")).not.toContain('PartName="/word/media/a.png"')
		expect(await partText(after.bytes, "word/document.xml")).toContain("After")

		expect(await run(editor, { type: "history.undo" })).toBe(true)

		const undone = await saved(editor, pkg, context)
		const reopened = await openBytes(undone.bytes)
		const ref = reopened.model.mediaRef(undone.drawings[0]?.part ?? -1, undone.drawings[0]?.embedId ?? "")

		expect(undone.drawings).toHaveLength(1)
		expect(await partText(undone.bytes, "word/_rels/document.xml.rels")).toContain('Id="rIdImg"')
		expect(await partText(undone.bytes, "[Content_Types].xml")).toContain('PartName="/word/media/a.png"')
		expect(ref).toMatchObject({ partName: "word/media/a.png", contentType: "image/png" })
		expect(await reopened.model.media(ref as NonNullable<typeof ref>)).toEqual(png(200, 100))
	})

	it("keeps a picture part another story still uses when one use of it is deleted", async () => {
		const logo = (rel: string): string =>
			`<w:p><w:r><w:t xml:space="preserve">Logo </w:t></w:r>${inlinePicture(914400, 457200, 3, rel)}</w:p>`
		const shared = (): Uint8Array =>
			buildDocx({
				body:
					p("Body") +
					logo("rIdImg") +
					'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/>' +
					'<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>',
				headers: { rIdH: logo("rIdLogo") },
				relationships: [{ id: "rIdImg", type: "image", target: "media/a.png" }],
				parts: [
					{ name: "word/media/a.png", contentType: "image/png", data: png(96, 48) },
					{
						name: "word/_rels/header1.xml.rels",
						data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/></Relationships>'
					}
				]
			})
		const kept = async (bytes: Uint8Array): Promise<void> => {
			expect(await partText(bytes, "word/media/a.png")).toBeDefined()
			expect(await partText(bytes, "[Content_Types].xml")).toContain('PartName="/word/media/a.png"')
		}

		// The body's use deleted: its relationship goes, the header's and the part stay.
		const body = await pagedEditor(shared())

		select(body.editor)
		expect(await run(body.editor, { type: "drawing.delete" })).toBe(true)

		const withoutBody = (await saved(body.editor, body.pkg, body.context)).bytes

		await kept(withoutBody)
		expect(await partText(withoutBody, "word/_rels/document.xml.rels")).not.toContain('Id="rIdImg"')
		expect(await partText(withoutBody, "word/_rels/header1.xml.rels")).toContain('Id="rIdLogo"')
		expect(await partText(withoutBody, "word/header1.xml")).toContain('r:embed="rIdLogo"')
		body.editor.dispose()

		// The header's use deleted: the body's relationship and the part stay.
		const header = await pagedEditor(shared())

		await settleAll(header.editor)
		expect(editHeader(header.editor, "header", 0)).toBe(true)
		select(header.editor)
		expect(await run(header.editor, { type: "drawing.delete" })).toBe(true)

		const withoutHeader = (await saved(header.editor, header.pkg, header.context)).bytes

		await kept(withoutHeader)
		expect(await partText(withoutHeader, "word/_rels/document.xml.rels")).toContain('Id="rIdImg"')
		expect(await partText(withoutHeader, "word/document.xml")).toContain('r:embed="rIdImg"')
		expect(await partText(withoutHeader, "word/header1.xml")).not.toContain("rIdLogo")
		header.editor.dispose()
	})
})

describe("docx drawings of added parts", () => {
	it("reads a drawing of a header copy from the copy, its alt text included", async () => {
		const margins =
			'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
		const bytes = buildDocx({
			body:
				p("First section") +
				`<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdH"/>${margins}</w:sectPr></w:pPr></w:p>` +
				p("Second section") +
				`<w:sectPr>${margins}</w:sectPr>`,
			headers: {
				rIdH: `<w:p><w:r><w:t xml:space="preserve">Head </w:t></w:r>${inlinePicture(914400, 457200, 5, "rIdImg", "The logo")}</w:p>`
			},
			parts: [
				{ name: "word/media/a.png", data: png(96, 48) },
				{
					name: "word/_rels/header1.xml.rels",
					data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/></Relationships>'
				}
			]
		})
		const { editor, pkg, context } = await pagedEditor(bytes)

		await settleAll(editor)
		expect(editHeader(editor, "header", editor.pageCount - 1)).toBe(true)
		expect(await editor.execute({ type: "header.linkToPrevious" })).toBe(true)
		editor.session.dispatch(editor.session.state.tr.insertText("X", 2))
		await settleAll(editor)

		let drawing: Node | undefined

		editor.session.state.doc.descendants(node => {
			if (node.type === nodes.drawing) drawing = node

			return drawing === undefined
		})
		expect(drawing === undefined ? undefined : drawingState(context, drawing)).toMatchObject({ descr: "The logo", resizable: true })

		const after = await saved(editor, pkg, context)

		expect(after.drawings.filter(found => found.docPrId > 0)).not.toHaveLength(0)
	})
})

describe("docx picture insertion", () => {
	it("inserts a picture as Word does: media part, relationship, Default content type, unique docPr id, its own size", async () => {
		const bytes = docx(p("One") + p("Two"), false)
		const { editor, pkg, context } = await pagedEditor(bytes)
		const media = editor.addMedia(png(96, 48))

		expect(media).toBeDefined()
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 4)))
		expect(editor.canExecute("image.insert")).toBe(true)
		expect(await run(editor, { type: "image.insert", media: media as number, altText: "Logo" })).toBe(true)

		const after = await saved(editor, pkg, context)
		const xml = (await partText(after.bytes, "word/document.xml")) ?? ""
		const rels = (await partText(after.bytes, "word/_rels/document.xml.rels")) ?? ""
		const types = (await partText(after.bytes, "[Content_Types].xml")) ?? ""

		expect(after.drawings).toHaveLength(1)
		expect(after.drawings[0]).toMatchObject({ placement: "inline", graphic: "picture", width: 914400, height: 457200, docPrId: 1 })
		expect(rels).toMatch(/Target="media\/image1\.png"/)
		expect(types).toContain('Extension="png"')
		expect(xml).toContain('descr="Logo"')
		expect(parseXml(new TextEncoder().encode(xml)).count).toBeGreaterThan(0)

		const reopened = await openBytes(after.bytes)
		const ref = reopened.model.mediaRef(after.drawings[0]?.part ?? -1, after.drawings[0]?.embedId ?? "")

		expect(ref).toMatchObject({ partName: "word/media/image1.png", contentType: "image/png" })
		expect(await reopened.model.media(ref as NonNullable<typeof ref>)).toEqual(png(96, 48))
		await sameLayout(editor, after.bytes)

		// Laid out while edited, it is drawn from the editor's media store.
		const shown = editor.edits.model.drawings.find(drawing => drawing?.embedId?.startsWith("filenMedia") === true)
		const pending = shown === undefined ? undefined : editor.edits.model.mediaRef(shown.part, shown.embedId ?? "")

		expect(pending).toMatchObject({ contentType: "image/png", external: false })
		expect(await editor.edits.model.media(pending as NonNullable<typeof pending>)).toEqual(png(96, 48))

		// Undone, nothing of it is written.
		expect(await run(editor, { type: "history.undo" })).toBe(true)

		const undone = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(await partText(undone.bytes as Uint8Array, "word/media/image1.png")).toBeUndefined()
		// The undo history can bring it back: its bytes stay.
		expect(mediaInUse(editor.sessions.map(session => session.state)).has(media as number)).toBe(true)
	})

	it("writes a picture inserted twice as one media part that both relationships target", async () => {
		const { editor, pkg, context } = await pagedEditor(docx(p("One") + p("Two"), false))

		// The same bytes twice, then other bytes of the same length.
		for (const picture of [png(96, 48), png(96, 48), png(48, 96)]) {
			editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 1)))
			expect(await run(editor, { type: "image.insert", media: editor.addMedia(picture) as number })).toBe(true)
		}

		const after = await saved(editor, pkg, context)
		const rels = (await partText(after.bytes, "word/_rels/document.xml.rels")) ?? ""
		const reopened = await openBytes(after.bytes)
		const parts = after.drawings.map(drawing => reopened.model.mediaRef(drawing.part, drawing.embedId ?? "")?.partName)

		expect(after.drawings).toHaveLength(3)
		expect([...rels.matchAll(/Target="media\/(image\d+\.png)"/g)].map(match => match[1]).sort()).toEqual([
			"image1.png",
			"image2.png",
			"image2.png"
		])
		// Inserted at the start each time, the other picture comes first and the repeated one shares a part.
		expect(parts).toEqual(["word/media/image1.png", "word/media/image2.png", "word/media/image2.png"])
		expect(await partText(after.bytes, "word/media/image3.png")).toBeUndefined()
	})

	it("keeps a registered picture through saves until a picture insertion names it or it is given up", async () => {
		const { editor } = await pagedEditor(docx(p("One"), false))
		const context = editor.session.context
		const states = (): EditorState[] => editor.sessions.map(session => session.state)
		const used = editor.addMedia(png(96, 48)) as number
		const waiting = editor.addMedia(png(96, 48)) as number
		const refused = editor.addMedia(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")) as number

		// A save while the host still asks for the second picture's alt text: neither goes.
		releaseUnusedMedia(context, states())
		expect(await run(editor, { type: "image.insert", media: used })).toBe(true)
		expect(await run(editor, { type: "image.insert", media: refused })).toBe(false)
		releaseUnusedMedia(context, states())
		expect(context.media.bytes(used)).toBeDefined()
		expect(context.media.bytes(waiting)).toBeDefined()
		expect(context.media.bytes(refused)).toBeUndefined()

		settleMedia(context, [waiting])
		releaseUnusedMedia(context, states())
		expect(context.media.bytes(waiting)).toBeUndefined()
		expect(context.media.bytes(used)).toBeDefined()
	})

	it("gives a copied new picture an id of its own, the same at every save", async () => {
		const { editor, pkg, context } = await pagedEditor(docx(p("One") + p("Two"), false))

		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 1)))
		expect(await run(editor, { type: "image.insert", media: editor.addMedia(png(96, 48)) as number })).toBe(true)

		// Copied without the paste sanitiser (a drag copy): the same node, the same id, twice.
		const at = drawingPos(editor.session.state.doc)
		const copy = editor.session.state.doc.slice(at, at + 1)
		const end = editor.session.state.doc.content.size - 1

		editor.dispatch(editor.session.state.tr.replace(end, end, copy))
		await settleAll(editor)

		const first = await saved(editor, pkg, context)
		const ids = first.drawings.map(drawing => drawing.docPrId)

		expect(ids).toHaveLength(2)
		expect(new Set(ids).size).toBe(2)
		expect(await partText((await saved(editor, pkg, context)).bytes, "word/document.xml")).toBe(
			await partText(first.bytes, "word/document.xml")
		)
	})

	it("fits a large picture to the text width and gives each new drawing its own id", async () => {
		const bytes = docx(`<w:p>${inlinePicture(1905000, 952500, 5)}</w:p>${p("Two")}`)
		const { editor, pkg, context } = await pagedEditor(bytes)
		const media = editor.addMedia(png(1600, 800)) as number

		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.atEnd(editor.session.state.doc)))
		expect(await run(editor, { type: "image.insert", media })).toBe(true)

		const after = await saved(editor, pkg, context)
		const added = after.drawings.find(drawing => drawing.docPrId !== 5)

		// 6.5 in of text width.
		expect(added).toMatchObject({ width: 5943600, height: 2971800, docPrId: 6 })
		expect(await partText(after.bytes, "word/media/image1.png")).toBeDefined()
		expect(await partText(after.bytes, "word/media/a.png")).toBeDefined()

		// A tall one fits the page's text height (9 in) too.
		expect(await run(editor, { type: "image.insert", media: editor.addMedia(png(500, 2000)) as number })).toBe(true)
		expect(editor.snapshot().context.drawing).toBeNull()

		const tall = (await saved(editor, pkg, context)).drawings.find(drawing => drawing.docPrId === 7)

		expect(tall).toMatchObject({ width: 2057400, height: 8229600 })
	})

	it("writes an SVG picture with its PNG fallback (asvg:svgBlip), and refuses one without", async () => {
		const { editor, pkg, context } = await pagedEditor(docx(p("One"), false))
		const svg = editor.addMedia(SVG) as number
		const fallback = editor.addMedia(png(192, 96)) as number

		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 2)))
		expect(await run(editor, { type: "image.insert", media: svg })).toBe(false)
		expect(await run(editor, { type: "image.insert", media: svg, fallback })).toBe(true)

		const after = await saved(editor, pkg, context)
		const xml = (await partText(after.bytes, "word/document.xml")) ?? ""
		const types = (await partText(after.bytes, "[Content_Types].xml")) ?? ""

		expect(xml).toMatch(/<a:blip r:embed="rId\d+"><a:extLst><a:ext uri="\{96DAC541-7B7A-43D3-8B79-37D633B846F1\}"><asvg:svgBlip/)
		expect(types).toContain('Extension="svg" ContentType="image/svg+xml"')
		expect(await partText(after.bytes, "word/media/image1.svg")).toBeDefined()
		expect(await partText(after.bytes, "word/media/image1.png")).toBeDefined()
		expect(after.drawings[0]).toMatchObject({ width: 1828800, height: 914400 })
	})

	it("changes a selected picture in place as Word's Change Picture: placement, turn, format and alt text kept, crop reset", async () => {
		// A floating, turned, outlined, cropped and described picture with its VML copy.
		const source = docx(
			`<w:p>${alternatePicture(1905000, 952500)
				.replace(
					/<wp:inline [^>]*>/,
					'<wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251660000" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>'
				)
				.replace("</wp:inline>", "</wp:anchor>")
				.replace(
					'<wp:effectExtent l="0" t="0" r="0" b="0"/>',
					'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/>'
				)
				.replace('name="Picture 1"/>', 'name="Logo" descr="The logo"/>')
				.replace(
					'<a:blip r:embed="rIdImg"/>',
					'<a:blip r:embed="rIdImg" cstate="print"><a:lum bright="10000"/></a:blip><a:srcRect l="10000" r="10000"/>'
				)
				.replace("<a:xfrm>", '<a:xfrm rot="5400000">')
				.replace("</a:prstGeom>", '</a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>')
				.replace(
					'<v:imagedata r:id="rIdImg" o:title=""/>',
					'<v:imagedata r:id="rIdImg" o:title="" cropleft="6554f" cropright="6554f"/>'
				)}</w:p>` + p("After")
		)
		const { editor, pkg, context } = await pagedEditor(source)

		select(editor)

		const marks = editor.session.state.doc.nodeAt(drawingPos(editor.session.state.doc))?.marks

		expect(await run(editor, { type: "image.insert", media: editor.addMedia(png(400, 400)) as number })).toBe(true)

		const node = editor.session.state.doc.nodeAt(drawingPos(editor.session.state.doc))

		expect(node?.attrs["src"]).not.toBe(-1)
		expect(node?.marks).toEqual(marks)
		expect(editor.snapshot().context.drawing).toMatchObject({
			kind: "picture",
			cx: 952500,
			cy: 952500,
			rotation: 90,
			altText: "The logo"
		})

		const after = await saved(editor, pkg, context)
		const xml = (await partText(after.bytes, "word/document.xml")) ?? ""

		expect(after.drawings).toHaveLength(1)
		expect(after.drawings[0]).toMatchObject({ width: 952500, height: 952500, placement: "anchor" })
		expect(xml).toContain('<wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH>')
		expect(xml).toContain('relativeHeight="251660000"')
		expect(xml).toContain('name="Logo" descr="The logo"')
		expect(xml).toContain('<a:xfrm rot="5400000">')
		expect(xml).toContain('<a:ln w="12700">')
		expect(xml).toMatch(/<a:blip r:embed="(rId\d+)" cstate="print"><a:lum bright="10000"\/><\/a:blip><a:stretch>/)
		expect(xml).not.toContain("srcRect")
		expect(xml).not.toContain("cropleft")

		const embed = /<a:blip r:embed="(rId\d+)"/.exec(xml)?.[1]

		expect(embed).not.toBe("rIdImg")
		expect(xml).toContain(`<v:imagedata r:id="${embed ?? ""}" o:title=""/>`)
		await sameLayout(editor, after.bytes)

		// What is no picture is replaced by the new picture, as a new one.
		const shape = await pagedEditor(ANCHORED)

		select(shape.editor)
		expect(await run(shape.editor, { type: "image.insert", media: shape.editor.addMedia(png(400, 400)) as number })).toBe(true)
		expect(shape.editor.session.state.doc.nodeAt(drawingPos(shape.editor.session.state.doc))?.attrs["src"]).toBe(-1)
	})

	it("refuses WebP and pictures over the limits without changing the document", async () => {
		const { editor } = await pagedEditor(docx(p("One"), false))
		const doc = editor.session.state.doc
		const webp = editor.addMedia(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")) as number
		const huge = editor.addMedia(png(6000, 4000)) as number

		expect(await editor.execute({ type: "image.insert", media: webp })).toBe(false)
		expect(await editor.execute({ type: "image.insert", media: huge })).toBe(false)
		expect(await editor.execute({ type: "image.insert", media: 999 })).toBe(false)
		expect(editor.session.state.doc).toBe(doc)
		expect(editor.addMedia(new Uint8Array(26 * 1024 * 1024))).toBeUndefined()
	})

	it("records a picture inserted while tracking as an insertion", async () => {
		const { editor, pkg, context } = await pagedEditor(docx(p("One"), false))

		context.review.tracking = true
		context.identity.author = "Ada"
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 2)))
		expect(await run(editor, { type: "image.insert", media: editor.addMedia(png(96, 96)) as number })).toBe(true)

		const xml = (await partText((await saved(editor, pkg, context)).bytes, "word/document.xml")) ?? ""

		expect(xml).toMatch(/<w:ins [^>]*w:author="Ada"[^>]*><w:r>(<w:rPr>.*?<\/w:rPr>)?<w:drawing>/)
	})
})

describe("docx drawings on the pages", () => {
	it("finds a picture under a point, and its handles once selected", async () => {
		const { editor } = await pagedEditor(INLINE)
		const pos = drawingPos(editor.session.state.doc)
		const caret = editor.geometry.locate(pos)

		if (caret === undefined) throw new Error("not laid out")

		// 1905000 x 952500 EMU: 200 x 100 px.
		const hit = editor.hitObject(caret.page, caret.x + 100, caret.top + caret.height - 20)

		expect(hit).toMatchObject({ kind: "drawing", pos, box: { x: caret.x, width: 200, height: 100 } })
		expect(hit?.part).toBeUndefined()

		const box = hit?.box ?? { x: 0, y: 0, width: 0, height: 0 }

		expect(editor.hitObject(caret.page, box.x - 50, box.y - 50)).toBeUndefined()
		select(editor)
		expect(editor.hitObject(caret.page, box.x + box.width + 2, box.y + box.height + 2)).toMatchObject({
			kind: "drawing",
			pos,
			part: "handle:se"
		})
		expect(editor.hitObject(caret.page, box.x + box.width / 2, box.y - 3, 2)?.part).toBe("handle:n")
	})

	it("works out a drag's box and the one command it ends with", () => {
		const box = { x: 10, y: 20, width: 100, height: 50 }

		expect(handlePoints(box).find(point => point.handle === "se")).toMatchObject({ x: 110, y: 70 })
		expect(resizedBox(box, "se", 50, 0, true)).toEqual({ x: 10, y: 20, width: 150, height: 75 })
		expect(resizedBox(box, "nw", 10, 10, false)).toEqual({ x: 20, y: 30, width: 90, height: 40 })
		expect(resizedBox(box, "e", -500, 0, false).width).toBe(4)

		const drawing = {
			kind: "picture",
			anchored: true,
			wrap: "square",
			cx: 952500,
			cy: 476250,
			x: 0,
			y: 0,
			relH: "column",
			relV: "paragraph",
			rotation: 0,
			flipH: false,
			flipV: false,
			crop: { left: 0, top: 0, right: 0, bottom: 0 },
			altText: "",
			resizable: true,
			rotatable: true,
			placeable: true,
			croppable: true,
			lockAspect: true,
			pos: 3
		} as const
		const resize = new DrawingDrag(drawing, box, "se")

		resize.move(100, 10)
		expect(resize.transform).toBe("translate(0px, 0px) scale(2, 2)")
		expect(resize.end()).toEqual({ type: "drawing.resize", cx: 1905000, cy: 952500 })

		const free = new DrawingDrag(drawing, box, "se")

		free.move(100, 10, true)
		expect(free.end()).toEqual({ type: "drawing.resize", cx: 1905000, cy: 571500 })

		const move = new DrawingDrag(drawing, box, undefined)

		move.move(96, -48)
		expect(move.end()).toEqual({ type: "drawing.position", x: 914400, y: -457200 })
		expect(moveCommand({ ...drawing, anchored: false }, 5, 5)).toBeUndefined()

		// A quarter-turned drawing's box is its extent across: a drag across resizes it up and down.
		const turned = { x: 10, y: 20, width: 50, height: 100 }

		for (const rotation of [90, 270]) {
			const across = new DrawingDrag({ ...drawing, rotation }, turned, "e")

			across.move(50, 0, true)
			expect(across.end()).toEqual({ type: "drawing.resize", cx: 952500, cy: 952500 })
		}

		// Turned by another angle, the extent whose bounds the box became; a corner keeps proportions.
		const tilted = { ...drawing, rotation: 30 }
		const bounds = { x: 0, y: 0, width: 100 * Math.cos(Math.PI / 6) + 50 * 0.5, height: 100 * 0.5 + 50 * Math.cos(Math.PI / 6) }
		const corner = new DrawingDrag(tilted, bounds, "se")

		corner.move(bounds.width, 0)
		expect(corner.end()).toEqual({ type: "drawing.resize", cx: 1905000, cy: 952500 })
	})
})

describe("docx drawing state", () => {
	it("reads what a source drawing is without overrides", async () => {
		const opened = await openBytes(ANCHORED)
		const session = new (await import("@filen/office/core/docx/edit")).DocxEditorSession(opened.context)
		const node = session.state.doc.nodeAt(drawingPos(session.state.doc)) as Node

		expect(drawingState(opened.context, node)).toMatchObject({
			kind: "shape",
			wrap: "tight",
			posX: 12700,
			posY: 25400,
			rotatable: true
		})
		expect(opened.model.parts[0]?.kinds.includes(Item.AlternateContent)).toBe(true)
	})
})

describe("docx picture crop", () => {
	it("crops as Word does: a:srcRect after the blip, the extent the part shown at the same scale, back to the source exactly", async () => {
		const { editor, pkg, context } = await pagedEditor(INLINE)

		select(editor)
		expect(editor.snapshot().context.drawing).toMatchObject({ croppable: true, crop: { left: 0, top: 0, right: 0, bottom: 0 } })
		expect(editor.canExecute("drawing.crop")).toBe(true)
		expect(await run(editor, { type: "drawing.crop", left: 25000, top: 0, right: 0, bottom: 10000 })).toBe(true)
		expect(editor.snapshot().context.drawing).toMatchObject({
			cx: 1428750,
			cy: 857250,
			crop: { left: 25000, top: 0, right: 0, bottom: 10000 }
		})
		// The same crop again changes nothing.
		expect(await run(editor, { type: "drawing.crop", left: 25000, top: 0, right: 0, bottom: 10000 })).toBe(false)

		const after = await saved(editor, pkg, context)
		const xml = (await partText(after.bytes, "word/document.xml")) ?? ""

		expect(xml).toContain('<a:blip r:embed="rIdImg"/><a:srcRect l="25000" b="10000"/><a:stretch>')
		expect(xml).toContain('<wp:extent cx="1428750" cy="857250"/>')
		expect(xml).toContain('<a:ext cx="1428750" cy="857250"/>')
		expect(after.drawings[0]).toMatchObject({ width: 1428750, height: 857250 })

		const reopened = await openBytes(after.bytes)
		const session = new (await import("@filen/office/core/docx/edit")).DocxEditorSession(reopened.context)

		expect(drawingState(reopened.context, session.state.doc.nodeAt(drawingPos(session.state.doc)) as Node).crop).toEqual({
			left: 25000,
			top: 0,
			right: 0,
			bottom: 10000
		})
		await sameLayout(editor, after.bytes)

		// The editor lays the cropped picture out from the markup the save writes.
		const shown = editor.edits.model.drawings.find(drawing => drawing !== undefined && drawing.part !== 0)
		const part = shown === undefined ? undefined : editor.edits.model.parts[shown.part]

		expect(part === undefined ? "" : decoder.decode(part.document.bytes)).toContain('<a:srcRect l="25000" b="10000"/>')

		// Uncropped, it is the source again (its size too); so is it undone.
		select(editor)
		expect(await run(editor, { type: "drawing.crop", left: 0, top: 0, right: 0, bottom: 0 })).toBe(true)
		expect(editor.snapshot().context.drawing).toMatchObject({ cx: 1905000, cy: 952500 })
		expect(await partText((await saved(editor, pkg, context)).bytes, "word/document.xml")).toBe(
			await partText(INLINE, "word/document.xml")
		)
		expect(await run(editor, { type: "history.undo" })).toBe(true)
		expect(await run(editor, { type: "history.undo" })).toBe(true)
		expect(await partText((await saved(editor, pkg, context)).bytes, "word/document.xml")).toBe(
			await partText(INLINE, "word/document.xml")
		)
	})

	it("reads a source crop, keeps it as it is through other changes and uncrops to the whole picture", async () => {
		const rect = '<a:srcRect l="16417" t="24879" r="16294" b="22041"/>'
		const bytes = docx(`<w:p>${croppedPicture(1717720, 900000, rect)}</w:p>`)
		const { editor, pkg, context } = await pagedEditor(bytes)

		select(editor)
		expect(editor.snapshot().context.drawing?.crop).toEqual({ left: 16417, top: 24879, right: 16294, bottom: 22041 })
		expect(await run(editor, { type: "drawing.altText", text: "Logo" })).toBe(true)
		expect((await partText((await saved(editor, pkg, context)).bytes, "word/document.xml")) ?? "").toContain(rect)

		select(editor)
		expect(await run(editor, { type: "drawing.crop", left: 0, top: 0, right: 0, bottom: 0 })).toBe(true)

		const after = await saved(editor, pkg, context)
		const xml = (await partText(after.bytes, "word/document.xml")) ?? ""

		// The whole picture at the scale it was shown at: 1717720 / (1 - 0.32711), 900000 / (1 - 0.4692).
		expect(xml).toContain('<a:blip r:embed="rIdImg"/><a:srcRect/><a:stretch>')
		expect(after.drawings[0]).toMatchObject({ width: 2552750, height: 1695554 })
		await sameLayout(editor, after.bytes)
	})

	it("pads with a negative crop, crops new pictures and keeps the VML copy in line", async () => {
		const { editor, pkg, context } = await pagedEditor(docx(`<w:p>${alternatePicture(1905000, 952500)}</w:p>`))

		select(editor)
		expect(await run(editor, { type: "drawing.crop", left: 25000, top: -10000, right: 0, bottom: 0 })).toBe(true)
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.atEnd(editor.session.state.doc)))
		expect(await run(editor, { type: "image.insert", media: editor.addMedia(png(96, 48)) as number })).toBe(true)
		select(editor, 1)
		expect(await run(editor, { type: "drawing.crop", left: 0, top: 0, right: 50000, bottom: 0 })).toBe(true)

		const after = await saved(editor, pkg, context)
		const xml = (await partText(after.bytes, "word/document.xml")) ?? ""

		expect(xml).toContain('<a:srcRect l="25000" t="-10000"/>')
		expect(xml).toContain('<v:imagedata r:id="rIdImg" o:title="" cropleft="16384f" croptop="-6554f"/>')
		expect(xml).toContain("width:112.5pt;height:82.5pt")
		expect(xml).toMatch(/<a:blip r:embed="rId\d+"\/><a:srcRect r="50000"\/><a:stretch>/)
		expect(after.drawings.map(drawing => [drawing.width, drawing.height])).toEqual([
			[1428750, 1047750],
			[457200, 457200]
		])
		await sameLayout(editor, after.bytes)
	})

	it("crops pictures only", async () => {
		const { editor } = await pagedEditor(ANCHORED)

		select(editor)
		expect(editor.snapshot().context.drawing?.croppable).toBe(false)
		expect(editor.canExecute("drawing.crop")).toBe(false)
		expect(await run(editor, { type: "drawing.crop", left: 1000, top: 0, right: 0, bottom: 0 })).toBe(false)
	})

	it("refuses a written crop that leaves nothing, but not one copied from the source", async () => {
		const { editor, pkg, context } = await pagedEditor(INLINE)
		const session = editor.session
		const pos = drawingPos(session.state.doc)
		const tr = changeDrawing(session.state, session.context, pos, session.state.doc.nodeAt(pos) as Node, {
			cropLeft: 60000,
			cropRight: 50000
		})

		expect(tr !== null && session.dispatch(tr)).toBe(true)
		await expect(saveDocx({ pkg, context, sessions: editor.sessions })).rejects.toMatchObject({
			reason: "content",
			message: expect.stringContaining("crop leaves nothing") as string
		})

		const copied = await pagedEditor(docx(`<w:p>${croppedPicture(1905000, 952500, '<a:srcRect l="60000" r="50000"/>')}</w:p>`))

		select(copied.editor)
		expect(copied.editor.snapshot().context.drawing?.croppable).toBe(false)
		expect(await run(copied.editor, { type: "drawing.resize", cx: 952500, cy: 476250 })).toBe(true)

		const xml = (await partText((await saved(copied.editor, copied.pkg, copied.context)).bytes, "word/document.xml")) ?? ""

		expect(xml).toContain('<a:srcRect l="60000" r="50000"/>')
	})

	// Word records no revision for a picture's size, place, wrapping or crop: there is no markup for one.
	it("does not track changes to a drawing's size, place, wrapping or crop", async () => {
		const { editor, pkg, context } = await pagedEditor(INLINE)

		context.review.tracking = true
		context.identity.author = "Ada"
		select(editor)
		expect(await run(editor, { type: "drawing.resize", cx: 3810000, cy: 1905000 })).toBe(true)
		select(editor)
		expect(await run(editor, { type: "drawing.crop", left: 10000, top: 0, right: 0, bottom: 0 })).toBe(true)
		select(editor)
		expect(await run(editor, { type: "drawing.wrap", mode: "square" })).toBe(true)
		select(editor)
		expect(await run(editor, { type: "drawing.position", x: 914400, y: 0 })).toBe(true)

		const xml = (await partText((await saved(editor, pkg, context)).bytes, "word/document.xml")) ?? ""

		expect(xml).toContain('<a:srcRect l="10000"/>')
		expect(xml).not.toMatch(/<w:(ins|del|rPrChange|pPrChange)\b/)
		expect(editor.snapshot().review.revisionCount).toBe(0)
	})

	it("works out a crop drag: edges, corners, moving the picture under it, turned and mirrored pictures", () => {
		const base = {
			kind: "picture",
			anchored: false,
			wrap: "inline",
			cx: 952500,
			cy: 476250,
			x: null,
			y: null,
			relH: "column",
			relV: "paragraph",
			rotation: 0,
			flipH: false,
			flipV: false,
			crop: { left: 0, top: 0, right: 0, bottom: 0 },
			altText: "",
			resizable: true,
			rotatable: true,
			placeable: true,
			croppable: true,
			lockAspect: true,
			pos: 3
		} as const
		const box = { x: 10, y: 20, width: 100, height: 50 }
		const edge = new CropDrag(base, box, "e")

		expect(edge.move(-25, 7)).toEqual({ x: 10, y: 20, width: 75, height: 50 })
		expect(edge.picture).toEqual(box)
		expect(edge.end()).toEqual({ type: "drawing.crop", left: 0, top: 0, right: 25000, bottom: 0 })

		const corner = new CropDrag(base, box, "nw")

		expect(corner.move(10, 5)).toEqual({ x: 20, y: 25, width: 90, height: 45 })
		expect(corner.end()).toEqual({ type: "drawing.crop", left: 10000, top: 10000, right: 0, bottom: 0 })

		// Out past the picture: padded. Past the other edge: what shows keeps its smallest size.
		const out = new CropDrag(base, box, "w")

		out.move(-10, 0)
		expect(out.end()).toEqual({ type: "drawing.crop", left: -10000, top: 0, right: 0, bottom: 0 })
		expect(out.move(500, 0).width).toBeCloseTo(4, 6)
		expect(out.end()).toEqual({ type: "drawing.crop", left: 96000, top: 0, right: 0, bottom: 0 })

		// A quarter of the picture cut off its left: 75 px show of 100. Moved right by 10 px under the frame.
		const cropped = { ...base, crop: { left: 25000, top: 0, right: 0, bottom: 0 } }
		const pan = new CropDrag(cropped, { x: 10, y: 20, width: 75, height: 50 }, undefined)

		expect(pan.picture).toEqual({ x: -15, y: 20, width: 100, height: 50 })
		expect(pan.move(10, 0)).toEqual({ x: 10, y: 20, width: 75, height: 50 })
		expect(pan.picture).toEqual({ x: -5, y: 20, width: 100, height: 50 })
		expect(pan.end()).toEqual({ type: "drawing.crop", left: 15000, top: 0, right: 10000, bottom: 0 })

		// Turned a quarter clockwise, the picture's top shows on the right; mirrored, its right on the left.
		expect(cropSides({ ...base, rotation: 90 })).toEqual({ top: "left", right: "top", bottom: "right", left: "bottom" })
		expect(cropSides({ ...base, flipH: true })).toEqual({ top: "top", right: "left", bottom: "bottom", left: "right" })

		const turned = new CropDrag({ ...base, rotation: 90 }, { x: 0, y: 0, width: 50, height: 100 }, "e")

		turned.move(-25, 0)
		expect(turned.end()).toEqual({ type: "drawing.crop", left: 0, top: 50000, right: 0, bottom: 0 })
		expect(new CropDrag({ ...base, rotation: 45 }, box, "e").active).toBe(false)
		expect(new CropDrag({ ...base, croppable: false }, box, "e").end()).toBeUndefined()
	})
})
