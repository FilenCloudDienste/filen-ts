// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { DrawingList, IDENTITY, ItemFlag, ItemKind, type DrawingImage, type TextRun } from "../core/drawingml/displayList"
import { convertMetafile } from "../core/metafile/index"
import type { DocxSessionApi, DrawingData } from "../dom/docx/protocol"
import { DocxMediaCache } from "../react/docx/media"
import { paintDrawing } from "../react/docx/paint/drawing"
import { paintObjects } from "../react/docx/paint/objects"
import { ByteWriter, WmfBuilder, wmfFontParams, wmfTextParams } from "./metafileFixtures"

function data(list: DrawingList): DrawingData {
	const compact = list.compact()

	return {
		width: compact.width,
		height: compact.height,
		commands: compact.commands,
		coords: compact.coords,
		itemCount: compact.itemCount,
		itemFloats: compact.itemFloats,
		itemInts: compact.itemInts,
		paints: compact.paints,
		strokes: compact.strokes,
		images: compact.images,
		texts: compact.texts,
		shadows: compact.shadows,
		...(compact.itemClips === null ? {} : { clips: compact.clips, itemClips: compact.itemClips }),
		...(compact.background === undefined ? {} : { background: compact.background })
	}
}

function square(list: DrawingList, x: number, y: number, size: number): [number, number] {
	const command = list.commandCount
	const coord = list.coordCount

	list.moveTo(x, y)
	list.lineTo(x + size, y)
	list.lineTo(x + size, y + size)
	list.lineTo(x, y + size)
	list.close()

	return [command, coord]
}

function path(list: DrawingList, fill: number): number {
	const [command, coord] = square(list, 0, 0, 10)

	return list.addItem(ItemKind.PATH, IDENTITY, 0, 0, 10, 10, command, coord, fill, -1, -1, -1, 0, 0)
}

const RUN: TextRun = {
	text: "αβ",
	size: 12,
	bold: true,
	italic: false,
	underline: "none",
	strike: "noStrike",
	color: 0x112233ff,
	font: "Times New Roman",
	baseline: 0,
	caps: "none",
	spacing: 0,
	lineBreak: false
}

function paint(list: DrawingList, urls: (image: DrawingImage) => string | undefined = () => undefined): SVGSVGElement {
	return paintDrawing(data(list), { document, idPrefix: "m1", imageUrl: urls })
}

describe("metafile output in the drawing painter", () => {
	it("groups consecutive items under shared clip groups, one level per clip", () => {
		const list = new DrawingList()

		list.width = 100
		list.height = 100

		const fill = list.paint({ kind: "solid", color: 0xff0000ff })
		const [c0, k0] = square(list, 0, 0, 50)
		const outer = list.clip(IDENTITY, c0, k0, false, -1)
		const [c1, k1] = square(list, 10, 10, 20)
		const [c2, k2] = square(list, 60, 60, 10)
		const inner = list.clip([2, 0, 0, 2, 0, 0], c1, k1, true, outer, 5, {
			shapes: [{ matrix: IDENTITY, firstCommand: c2, commandCount: 5, firstCoord: k2, evenOdd: false }]
		})

		list.setItemClip(path(list, fill), inner)
		list.setItemClip(path(list, fill), inner)
		list.setItemClip(path(list, fill), outer)
		path(list, fill)

		const svg = paint(list)
		const outerGroups = svg.querySelectorAll(":scope > g[clip-path]")
		const clipPaths = Array.from(svg.querySelectorAll("defs > clipPath"))

		expect(outerGroups).toHaveLength(1)
		expect(svg.querySelectorAll(":scope > path")).toHaveLength(1)

		const outerGroup = outerGroups[0]
		const innerGroup = outerGroup?.querySelector(":scope > g[clip-path]")

		expect(outerGroup?.children).toHaveLength(2)
		expect(innerGroup?.querySelectorAll(":scope > path")).toHaveLength(2)
		expect(outerGroup?.querySelectorAll(":scope > path")).toHaveLength(1)
		expect(clipPaths).toHaveLength(2)

		const innerPath = clipPaths.find(element => `url(#${element.id})` === innerGroup?.getAttribute("clip-path"))
		const shapes = innerPath?.querySelectorAll("path") ?? []

		// Its two shapes unite, each with its own placement and rule.
		expect(shapes).toHaveLength(2)
		expect(shapes[0]?.getAttribute("transform")).toBe("matrix(2 0 0 2 0 0)")
		expect(shapes[0]?.getAttribute("clip-rule")).toBe("evenodd")
		expect(shapes[1]?.hasAttribute("clip-rule")).toBe(false)
	})

	it("draws boolean clips as masks of their members' areas, and group opacity", () => {
		const list = new DrawingList()

		list.width = 100
		list.height = 100

		const [c0, k0] = square(list, 0, 0, 50)
		const a = list.clip(IDENTITY, c0, k0, false, -1)
		const [c1, k1] = square(list, 25, 25, 50)
		const b = list.clip(IDENTITY, c1, k1, false, -1)
		const difference = list.clip(IDENTITY, list.commandCount, list.coordCount, false, -1, 0, { add: [a], subtract: [b], opacity: 0.5 })

		list.setItemClip(path(list, list.paint({ kind: "solid", color: 0xff })), difference)

		const svg = paint(list)
		const group = svg.querySelector(":scope > g[mask]")
		const mask = svg.querySelector("defs > mask")

		expect(group?.getAttribute("opacity")).toBe("0.5")
		expect(group?.getAttribute("mask")).toBe(`url(#${mask?.id})`)
		expect(mask?.getAttribute("maskUnits")).toBe("userSpaceOnUse")

		const areas = Array.from(mask?.children ?? [])

		expect(areas.map(area => area.querySelector("rect")?.getAttribute("fill"))).toEqual(["#fff", "#000"])
		expect(areas.every(area => area.getAttribute("clip-path")?.startsWith("url(#") === true)).toBe(true)
		expect(areas.some(area => area.hasAttribute("opacity"))).toBe(false)
	})

	it("refuses clip members that are not earlier clips", () => {
		const list = new DrawingList()
		const self = list.clip(IDENTITY, 0, 0, false, -1, 0, { add: [0, 5], subtract: [-1] })

		expect(list.clips[self]?.add).toEqual([])
		expect(list.clips[self]?.subtract).toEqual([])
	})

	it("hides what an empty clip clips", () => {
		const list = new DrawingList()
		const empty = list.clip(IDENTITY, list.commandCount, list.coordCount, false, -1)

		list.setItemClip(path(list, list.paint({ kind: "solid", color: 0xff })), empty)

		const clipPath = paint(list).querySelector("clipPath")

		expect(clipPath).not.toBeNull()
		expect(clipPath?.children).toHaveLength(0)
	})

	it("draws positioned text at its offsets, and anchors text without offsets", () => {
		const list = new DrawingList()

		list.addItem(
			ItemKind.TEXT,
			[1, 0, 0, 1, 5, 20],
			0,
			-12,
			20,
			16,
			0,
			0,
			-1,
			-1,
			list.text({ kind: "glyphs", run: RUN, positions: Float32Array.of(0, 8.5), anchor: "start" }),
			-1,
			0,
			0
		)
		list.addItem(
			ItemKind.TEXT,
			IDENTITY,
			-10,
			-12,
			20,
			16,
			0,
			0,
			-1,
			-1,
			list.text({ kind: "glyphs", run: { ...RUN, text: "<b>x</b>" }, positions: null, anchor: "middle" }),
			-1,
			0,
			0
		)

		const texts = paint(list).querySelectorAll("text")

		expect(texts[0]?.getAttribute("x")).toBe("0 8.5")
		expect(texts[0]?.getAttribute("y")).toBe("0")
		expect(texts[0]?.getAttribute("transform")).toBe("matrix(1 0 0 1 5 20)")
		expect(texts[0]?.textContent).toBe("αβ")
		expect(texts[0]?.getAttribute("font-size")).toBe("16")
		expect(texts[0]?.getAttribute("font-family")).toBe("serif")
		expect(texts[0]?.getAttribute("font-weight")).toBe("bold")
		expect(texts[0]?.getAttribute("fill")).toBe("#112233")
		expect(texts[1]?.getAttribute("text-anchor")).toBe("middle")
		expect(texts[1]?.textContent).toBe("<b>x</b>")
		expect(texts[1]?.children).toHaveLength(0)
	})

	it("paints a converted MathType-style WMF with Symbol glyphs as Unicode", () => {
		const bytes = new WmfBuilder()
			.record(0x20b, [0, 0])
			.record(0x20c, [720, 1440])
			.record(0x102, [1])
			.recordBytes(0x2fb, wmfFontParams(-240, "Symbol", 2))
			.record(0x12d, [0])
			.record(0x12e, [24])
			.recordBytes(0xa32, wmfTextParams(150, 600, "pS", [120, 120]))
			.recordBytes(0x2fc, new ByteWriter().u16(0).u32(0).u16(0).done())
			.record(0x12d, [1])
			.record(0x41b, [400, 1000, 380, 100])
			.build([0, 0, 1440, 720])
		const result = convertMetafile(bytes)

		if (!result.ok) throw new Error(result.reason)

		const svg = paint(result.list)

		expect(svg.getAttribute("viewBox")).toBe("0 0 96 48")
		expect(svg.querySelector("text")?.textContent).toBe("πΣ")
		expect(svg.querySelectorAll("path")).toHaveLength(1)
	})
})

function imageEntry(format: DrawingImage["format"], bytes: Uint8Array = Uint8Array.of(1)): DrawingImage {
	return {
		partName: undefined,
		format,
		handling: "native",
		svgPartName: undefined,
		crop: { left: 0, top: 0, right: 0, bottom: 0 },
		alpha: 1,
		grayscale: false,
		biLevel: -1,
		duotone: null,
		brightness: 0,
		contrast: 0,
		colorChange: null,
		bytes
	}
}

describe("metafile paints, blending and text layout in the drawing painter", () => {
	it("draws user-space gradients and explicit image tiles", () => {
		const list = new DrawingList()

		list.width = 100
		list.height = 100

		const gradient = list.paint({
			kind: "gradient",
			type: "radial",
			stops: { offsets: Float32Array.of(0, 1), colors: Uint32Array.of(0xffffffff, 0x000000ff) },
			matrix: [5, 0, 0, 5, 50, 50],
			spread: "reflect",
			focus: [0.4, 0]
		})
		const image = list.image(imageEntry("png"))
		const tile = list.paint({
			kind: "image",
			image,
			stretch: undefined,
			tile: { tx: 0, ty: 0, sx: 1, sy: 1, flip: "x", align: "tl", width: 8, height: 4, matrix: [2, 0, 0, 2, 3, 4] }
		})

		path(list, gradient)
		path(list, tile)

		const svg = paint(list, () => "blob:tile")
		const radial = svg.querySelector("radialGradient")
		const pattern = svg.querySelector("pattern")

		expect(radial?.getAttribute("gradientUnits")).toBe("userSpaceOnUse")
		expect(radial?.getAttribute("gradientTransform")).toBe("matrix(5 0 0 5 50 50)")
		expect(radial?.getAttribute("fx")).toBe("0.4")
		expect(radial?.getAttribute("spreadMethod")).toBe("reflect")
		expect(pattern?.getAttribute("patternUnits")).toBe("userSpaceOnUse")
		expect(pattern?.getAttribute("width")).toBe("16")
		expect(pattern?.getAttribute("height")).toBe("4")
		expect(pattern?.getAttribute("patternTransform")).toBe("matrix(2 0 0 2 3 4)")
		// The tile and its mirrored copy.
		expect(pattern?.querySelectorAll("image")).toHaveLength(2)
	})

	it("blends raster-operation items from their own clip groups at the root of an isolated drawing", () => {
		const list = new DrawingList()

		list.width = 10
		list.height = 10
		list.background = 0xffffffff

		const fill = list.paint({ kind: "solid", color: 0xff })
		const [c0, k0] = square(list, 0, 0, 5)
		const clip = list.clip(IDENTITY, c0, k0, false, -1)

		list.setItemClip(path(list, fill), clip)

		const [command, coord] = square(list, 0, 0, 10)
		const blended = list.addItem(ItemKind.PATH, IDENTITY, 0, 0, 10, 10, command, coord, fill, -1, -1, -1, ItemFlag.BLEND_DIFFERENCE, 0)

		list.setItemClip(blended, clip)

		const svg = paint(list)
		const children = Array.from(svg.children).filter(child => child.tagName.toLowerCase() !== "defs")

		expect(svg.style.getPropertyValue("isolation")).toBe("isolate")
		// The surface, the plain item's clip group, then the blended item's own clip group.
		expect(children.map(child => child.tagName.toLowerCase())).toEqual(["rect", "g", "g"])
		expect(children[0]?.getAttribute("fill")).toBe("#ffffff")
		expect(children[2]?.getAttribute("clip-path")).toBe(children[1]?.getAttribute("clip-path"))
		expect((children[2] as SVGElement | undefined)?.style.getPropertyValue("mix-blend-mode")).toBe("difference")
		expect(children[2]?.querySelector("path")?.style.getPropertyValue("mix-blend-mode")).toBe("")
	})

	it("draws clamped tiles as one image placed by its matrix inside the item's clipped outline", () => {
		const list = new DrawingList()
		const image = list.image(imageEntry("png"))
		const tile = list.paint({
			kind: "image",
			image,
			stretch: undefined,
			tile: {
				tx: 0,
				ty: 0,
				sx: 1,
				sy: 1,
				flip: "none",
				align: "tl",
				width: 64,
				height: 32,
				matrix: [0.5, 0, 0, 0.5, 3, 4],
				clamp: true
			}
		})
		const [command, coord] = square(list, 0, 0, 10)

		list.addItem(ItemKind.PATH, [2, 0, 0, 2, 0, 0], 0, 0, 10, 10, command, coord, tile, -1, -1, -1, 0, 0)

		const svg = paint(list, () => "blob:tile")
		const group = svg.querySelector(":scope > g[clip-path]")

		expect(svg.querySelector("pattern")).toBeNull()
		expect(group?.querySelector("g")?.getAttribute("transform")).toBe("matrix(2 0 0 2 0 0) matrix(0.5 0 0 0.5 3 4)")
		expect(group?.querySelector("image")?.getAttribute("width")).toBe("64")
		expect(svg.querySelector("clipPath path")?.getAttribute("transform")).toBe("matrix(2 0 0 2 0 0)")
	})

	it("draws text in the family the engine resolved, refusing anything else", () => {
		const list = new DrawingList()

		list.addItem(
			ItemKind.TEXT,
			IDENTITY,
			0,
			0,
			10,
			10,
			0,
			0,
			-1,
			-1,
			list.text({ kind: "glyphs", run: RUN, positions: null, anchor: "start" }),
			-1,
			0,
			0
		)
		list.addItem(
			ItemKind.TEXT,
			IDENTITY,
			0,
			0,
			10,
			10,
			0,
			0,
			-1,
			-1,
			list.text({ kind: "glyphs", run: RUN, positions: null, anchor: "start" }),
			-1,
			0,
			0
		)

		const svg = paintDrawing(
			{ ...data(list), textFonts: ['"fo-a1_Arial", serif', '"x"; background:url(evil)'] },
			{ document, idPrefix: "m2", imageUrl: () => undefined }
		)
		const texts = svg.querySelectorAll("text")

		expect(texts[0]?.getAttribute("font-family")).toBe('"fo-a1_Arial", serif')
		expect(texts[1]?.getAttribute("font-family")).toBe("serif")
	})

	it("wraps block text greedily in its rectangle, cuts it to whole lines and trims with an ellipsis", () => {
		const list = new DrawingList()
		const block = {
			kind: "block" as const,
			run: { ...RUN, text: "one two three four five six", bold: false },
			width: 50,
			height: 30,
			align: "middle" as const,
			lineAlign: "start" as const,
			wrap: true,
			clip: true,
			lineLimit: true,
			trimming: "ellipsisWord" as const,
			lineHeight: 15,
			ascent: 0.8,
			rtl: false
		}

		list.addItem(ItemKind.TEXT, [1, 0, 0, 1, 10, 10], 0, 0, 50, 30, 0, 0, -1, -1, list.text(block), -1, 0, 0)

		// Ten px per character.
		const svg = paintDrawing(data(list), { document, idPrefix: "m3", imageUrl: () => undefined, measureText: text => text.length * 10 })
		const group = svg.querySelector("g[clip-path]")
		const lines = Array.from(svg.querySelectorAll("text"), line => line.textContent)

		expect(lines).toEqual(["one", "two…"])
		expect(svg.querySelector("text")?.getAttribute("text-anchor")).toBe("middle")
		expect(svg.querySelector("text")?.getAttribute("x")).toBe("25")
		expect(group?.getAttribute("transform")).toBe("matrix(1 0 0 1 10 10)")
	})

	it("stretches block text with textLength so the widest line spans the rectangle, leaving the paint unscaled", () => {
		const svg = (stretch: boolean): SVGSVGElement => {
			const list = new DrawingList()
			const block = {
				kind: "block" as const,
				run: { ...RUN, text: "AB\nABCD" },
				width: 180,
				height: 40,
				align: "middle" as const,
				lineAlign: "middle" as const,
				wrap: false,
				clip: false,
				lineLimit: false,
				trimming: "none" as const,
				lineHeight: 20,
				ascent: 0.8,
				rtl: false,
				...(stretch && { stretch: true })
			}

			list.addItem(ItemKind.TEXT, IDENTITY, 0, 0, 180, 40, 0, 0, -1, -1, list.text(block), -1, 0, 0)

			return paintDrawing(data(list), { document, idPrefix: "m9", imageUrl: () => undefined, measureText: text => text.length * 10 })
		}
		const lengths = (root: SVGSVGElement): (string | null)[] =>
			Array.from(root.querySelectorAll("text"), line => line.getAttribute("textLength"))

		expect(lengths(svg(false))).toEqual([null, null])
		expect(lengths(svg(true))).toEqual(["90", "180"])
		expect(svg(true).querySelector("text")?.getAttribute("lengthAdjust")).toBe("spacingAndGlyphs")
		expect(svg(true).querySelector("text")?.getAttribute("transform")).toBeNull()
	})

	it("measures each word and character of block text once", () => {
		const list = new DrawingList()
		const words = Array.from({ length: 4000 }, (_, k) => `w${k % 50}`).join(" ")
		const block = {
			kind: "block" as const,
			run: { ...RUN, text: `${words} ${"x".repeat(5000)}` },
			width: 200,
			height: 0,
			align: "start" as const,
			lineAlign: "start" as const,
			wrap: true,
			clip: false,
			lineLimit: false,
			trimming: "none" as const,
			lineHeight: 15,
			ascent: 0.8,
			rtl: false
		}

		list.addItem(ItemKind.TEXT, IDENTITY, 0, 0, 200, 0, 0, 0, -1, -1, list.text(block), -1, 0, 0)

		let calls = 0
		const svg = paintDrawing(data(list), {
			document,
			idPrefix: "m4",
			imageUrl: () => undefined,
			measureText: text => {
				calls++

				return text.length * 10
			}
		})

		expect(svg.querySelectorAll("text").length).toBeGreaterThan(200)
		// The distinct words, the space, the characters of the long word and the lines checked for trimming.
		expect(calls).toBeLessThan(2000)
	})

	it("fills text with its own paint", () => {
		const list = new DrawingList()
		const fill = list.paint({
			kind: "gradient",
			type: "linear",
			stops: { offsets: Float32Array.of(0, 1), colors: Uint32Array.of(0xff0000ff, 0x0000ffff) },
			matrix: [10, 0, 0, 10, 0, 0],
			spread: "pad"
		})

		list.addItem(
			ItemKind.TEXT,
			IDENTITY,
			0,
			-10,
			20,
			12,
			0,
			0,
			-1,
			-1,
			list.text({ kind: "glyphs", run: RUN, positions: null, anchor: "start", fill }),
			-1,
			0,
			0
		)

		const svg = paint(list)

		expect(svg.querySelector("text")?.getAttribute("fill")).toBe(`url(#${svg.querySelector("linearGradient")?.id})`)
	})
})

describe("bitmaps a drawing carries", () => {
	function session(drawing: DrawingData): DocxSessionApi {
		return {
			objects: ids => Promise.resolve(ids.map(id => ({ kind: "drawing" as const, id, drawing }))),
			media: () => Promise.resolve(null),
			locate: () => Promise.resolve(null),
			find: () => Promise.resolve(new Int32Array(0)),
			close: () => undefined
		}
	}

	function image(format: DrawingImage["format"]): DrawingImage {
		return {
			partName: undefined,
			format,
			handling: "native",
			svgPartName: undefined,
			crop: { left: 0, top: 0, right: 0, bottom: 0 },
			alpha: 1,
			grayscale: false,
			biLevel: -1,
			duotone: null,
			brightness: 0,
			contrast: 0,
			colorChange: null,
			bytes: Uint8Array.of(0x42, 0x4d, 0, 0)
		}
	}

	it("shows raster bytes through object URLs revoked with the page, and refuses other formats", async () => {
		const list = new DrawingList()

		list.width = 10
		list.height = 10
		const shown = image("bmp")

		list.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 10, 10, 0, 0, -1, -1, list.image(shown), -1, 0, 0)
		// The same bytes drawn from another source rectangle share one URL.
		list.addItem(
			ItemKind.IMAGE,
			IDENTITY,
			0,
			0,
			10,
			10,
			0,
			0,
			-1,
			-1,
			list.image({ ...shown, crop: { left: 0.5, top: 0, right: 0, bottom: 0 } }),
			-1,
			0,
			0
		)
		list.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 10, 10, 0, 0, -1, -1, list.image(image("svg")), -1, 0, 0)

		const created: string[] = []
		const revoked: string[] = []
		const drawing = data(list)
		const media = new DocxMediaCache(session(drawing), undefined, {
			create: (_bytes, type) => {
				const url = `blob:test/${created.length}-${type}`

				created.push(url)

				return url
			},
			revoke: url => {
				revoked.push(url)
			}
		})
		const element = document.createElement("div")
		const release = paintObjects([{ element, id: 1, kind: 0, width: 10, height: 10 }], {
			document,
			session: session(drawing),
			media,
			signal: { aborted: false }
		})

		await new Promise(resolve => setTimeout(resolve, 0))

		expect(created).toEqual(["blob:test/0-image/bmp"])

		const images = element.querySelectorAll("image")

		expect(images).toHaveLength(2)
		expect(images[0]?.getAttribute("href")).toBe("blob:test/0-image/bmp")
		expect(images[1]?.getAttribute("href")).toBe("blob:test/0-image/bmp")
		// The SVG one draws as a placeholder.
		expect(element.querySelectorAll("rect")).toHaveLength(1)

		release()

		expect(revoked).toEqual(["blob:test/0-image/bmp"])

		media.createBytesUrl(Uint8Array.of(1), "image/png")
		media.dispose()

		expect(revoked).toEqual(["blob:test/0-image/bmp", "blob:test/1-image/png"])
		expect(media.createBytesUrl(Uint8Array.of(1), "image/png")).toBeUndefined()
	})
})

describe("drawings with text the painter wraps", () => {
	it("waits for the document's fonts before painting", async () => {
		const list = new DrawingList()

		list.width = 10
		list.height = 10
		list.addItem(
			ItemKind.TEXT,
			IDENTITY,
			0,
			0,
			10,
			10,
			0,
			0,
			-1,
			-1,
			list.text({
				kind: "block",
				run: RUN,
				width: 10,
				height: 10,
				align: "start",
				lineAlign: "start",
				wrap: true,
				clip: false,
				lineLimit: false,
				trimming: "none",
				lineHeight: 5,
				ascent: 0.8,
				rtl: false
			}),
			-1,
			0,
			0
		)

		const drawing = data(list)
		const session: DocxSessionApi = {
			objects: ids => Promise.resolve(ids.map(id => ({ kind: "drawing" as const, id, drawing }))),
			media: () => Promise.resolve(null),
			locate: () => Promise.resolve(null),
			find: () => Promise.resolve(new Int32Array(0)),
			close: () => undefined
		}
		const media = new DocxMediaCache(session)
		let loaded: () => void = () => undefined

		media.fontsReady = () => new Promise<void>(resolve => (loaded = resolve))

		const element = document.createElement("div")

		paintObjects([{ element, id: 1, kind: 0, width: 10, height: 10 }], { document, session, media, signal: { aborted: false } })
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(element.querySelector("svg")).toBeNull()

		loaded()
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(Array.from(element.querySelectorAll("text"), text => text.textContent).join("")).toBe("αβ")
	})
})

describe("shaded paints", () => {
	const shaded = (list: DrawingList): number =>
		list.paint({
			kind: "shaded",
			points: Float32Array.of(0, 0, 10, 0, 0, 10),
			colors: Uint32Array.of(0xff0000ff, 0x00ff00ff, 0x0000ffff),
			ramp: null
		})

	it("draw as an image over the paint's bounds inside the item's outline, rasterised by the context", () => {
		const list = new DrawingList()
		const fill = shaded(list)
		const [command, coord] = square(list, 0, 0, 10)

		list.addItem(ItemKind.PATH, [3, 0, 0, 3, 0, 0], 0, 0, 10, 10, command, coord, fill, -1, -1, -1, 0, 0)

		const calls: number[] = []
		const svg = paintDrawing(data(list), {
			document,
			idPrefix: "s1",
			imageUrl: () => undefined,
			shade: (image, _paint, localScale) => {
				calls.push(localScale)
				image.setAttribute("href", "blob:shade")
			}
		})
		const image = svg.querySelector("g[clip-path] image")

		expect(calls).toEqual([3])
		expect(image?.getAttribute("href")).toBe("blob:shade")
		expect([image?.getAttribute("width"), image?.getAttribute("height")]).toEqual(["10", "10"])
		// Without a rasteriser: the mean colour.
		expect(paint(list).querySelector("path")?.getAttribute("fill")).toBe("#555555")
	})

	it("fill text with a clamped tile through the text's own outline", () => {
		const list = new DrawingList()
		const image = list.image(imageEntry("png"))
		const fill = list.paint({
			kind: "image",
			image,
			stretch: undefined,
			tile: { tx: 0, ty: 0, sx: 1, sy: 1, flip: "none", align: "tl", width: 8, height: 8, matrix: [1, 0, 0, 1, 0, -8], clamp: true }
		})

		list.addItem(
			ItemKind.TEXT,
			[1, 0, 0, 1, 5, 20],
			0,
			-10,
			20,
			12,
			0,
			0,
			-1,
			-1,
			list.text({ kind: "glyphs", run: RUN, positions: null, anchor: "start", fill }),
			-1,
			0,
			0
		)

		const svg = paint(list, () => "blob:tile")

		expect(svg.querySelector("pattern")).toBeNull()
		expect(svg.querySelector("clipPath text")?.textContent).toBe("αβ")
		expect(svg.querySelector(":scope > g[clip-path] g")?.getAttribute("transform")).toBe("matrix(1 0 0 1 5 20) matrix(1 0 0 1 0 -8)")
		expect(svg.querySelector(":scope > g[clip-path] image")?.getAttribute("href")).toBe("blob:tile")
	})

	it("re-rasterise when the page's zoom crosses a power of two, once per step", async () => {
		const list = new DrawingList()

		list.width = 10
		list.height = 10

		const fill = shaded(list)
		const [command, coord] = square(list, 0, 0, 10)

		list.addItem(ItemKind.PATH, IDENTITY, 0, 0, 10, 10, command, coord, fill, -1, -1, -1, 0, 0)

		const drawing = data(list)
		const created: string[] = []
		const revoked: string[] = []
		const session: DocxSessionApi = {
			objects: ids => Promise.resolve(ids.map(id => ({ kind: "drawing" as const, id, drawing }))),
			media: () => Promise.resolve(null),
			locate: () => Promise.resolve(null),
			find: () => Promise.resolve(new Int32Array(0)),
			close: () => undefined
		}
		const media = new DocxMediaCache(session, undefined, {
			create: () => {
				created.push(`blob:s${created.length}`)

				return created[created.length - 1] ?? ""
			},
			revoke: url => {
				revoked.push(url)
			}
		})
		const scaled = document.createElement("div")
		const element = document.createElement("div")
		let width = 12

		scaled.className = "fo-docx-page-scale"
		scaled.appendChild(element)
		document.body.appendChild(scaled)
		element.getBoundingClientRect = () => ({ width }) as DOMRect

		const release = paintObjects([{ element, id: 1, kind: 0, width: 10, height: 10 }], {
			document,
			session,
			media,
			signal: { aborted: false }
		})
		const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50))

		await settle()

		const image = (): string | null | undefined => element.querySelector("image")?.getAttribute("href")
		const first = image()

		expect(created).toHaveLength(1)

		// Within the same power of two (1.2 and 1.9 both round up to 2): nothing new.
		width = 19
		scaled.setAttribute("style", "transform: scale(1.9)")
		await settle()

		expect(created).toHaveLength(1)

		width = 30
		scaled.setAttribute("style", "transform: scale(3)")
		await settle()

		expect(created).toHaveLength(2)
		expect(image()).not.toBe(first)
		expect(revoked).toEqual([first])

		release()

		expect(revoked).toHaveLength(2)
		scaled.remove()
	})
})
