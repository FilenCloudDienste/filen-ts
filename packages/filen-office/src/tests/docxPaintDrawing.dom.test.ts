// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import {
	DrawingList,
	IDENTITY,
	ItemFlag,
	ItemKind,
	rgba,
	type DrawingImage,
	type Paint,
	type Stroke,
	type TextParagraph,
	type TextRun
} from "../core/drawingml/displayList"
import type { DrawingData } from "../dom/docx/protocol"
import { drawingImages, imageMime, paintDrawing, type DrawingPaintContext } from "../react/docx/paint/drawing"

const PREFIX = "d7"

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
		shadows: compact.shadows
	}
}

function context(urls: Readonly<Record<string, string>> = {}): DrawingPaintContext {
	return {
		document,
		idPrefix: PREFIX,
		imageUrl: image => (image.partName === undefined ? undefined : urls[image.partName])
	}
}

function list(width: number = 100, height: number = 50): DrawingList {
	const out = new DrawingList()

	out.width = width
	out.height = height

	return out
}

function rect(target: DrawingList, x: number, y: number, w: number, h: number): void {
	target.moveTo(x, y)
	target.lineTo(x + w, y)
	target.lineTo(x + w, y + h)
	target.lineTo(x, y + h)
	target.close()
}

function addPath(
	target: DrawingList,
	draw: () => void,
	fill: number,
	stroke: number = -1,
	flags: number = 0,
	shadow: number = -1,
	matrix: readonly number[] = IDENTITY
): void {
	const command = target.commandCount
	const coord = target.coordCount

	draw()
	target.addItem(ItemKind.PATH, matrix, 0, 0, 100, 50, command, coord, fill, stroke, -1, shadow, flags, 0)
}

function stroke(overrides: Partial<Stroke> = {}): Stroke {
	return {
		width: 2,
		paint: 0,
		dash: "solid",
		customDash: null,
		cap: "flat",
		join: "miter",
		miterLimit: 8,
		compound: "sng",
		inset: false,
		...overrides
	}
}

function image(overrides: Partial<DrawingImage> = {}): DrawingImage {
	return {
		partName: "/word/media/image1.png",
		format: "png",
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
		...overrides
	}
}

function run(text: string, overrides: Partial<TextRun> = {}): TextRun {
	return {
		text,
		size: 12,
		bold: false,
		italic: false,
		underline: "none",
		strike: "noStrike",
		color: rgba("333333"),
		font: "Calibri",
		baseline: 0,
		caps: "none",
		spacing: 0,
		lineBreak: false,
		...overrides
	}
}

function paragraph(runs: readonly TextRun[], overrides: Partial<TextParagraph> = {}): TextParagraph {
	return {
		align: "l",
		level: 0,
		marginLeft: 0,
		indent: 0,
		lineSpacing: 0,
		spaceBefore: 0,
		spaceAfter: 0,
		rtl: false,
		bullet: "",
		bulletFont: "",
		runs,
		endSize: 12,
		...overrides
	}
}

function addText(target: DrawingList, paragraphs: readonly TextParagraph[], anchor: "t" | "ctr" | "b" = "t", rotation: number = 0): void {
	const text = target.text({
		kind: "body",
		body: {
			insets: { left: 0, top: 0, right: 0, bottom: 0 },
			anchor,
			anchorCenter: false,
			vertical: "horz",
			wrap: false,
			rotation,
			upright: false,
			columns: 1,
			columnSpacing: 0,
			autofit: "none",
			fontScale: 1,
			lineSpacingReduction: 0
		},
		paragraphs
	})

	target.addItem(ItemKind.TEXT, IDENTITY, 0, 0, 100, 50, target.commandCount, target.coordCount, -1, -1, text, -1, 0, 0)
}

const ALLOWED_TAGS = new Set([
	"svg",
	"defs",
	"g",
	"path",
	"rect",
	"image",
	"text",
	"tspan",
	"linearGradient",
	"radialGradient",
	"stop",
	"pattern",
	"clipPath",
	"filter",
	"feDropShadow",
	"feColorMatrix",
	"feComponentTransfer",
	"feFuncR",
	"feFuncG",
	"feFuncB"
])

function elements(root: Element): Element[] {
	return [root, ...Array.from(root.querySelectorAll("*"))]
}

function attributeValues(root: Element): string[] {
	return elements(root).flatMap(element => Array.from(element.attributes).map(attribute => attribute.value))
}

describe("paintDrawing", () => {
	it("builds the root svg sized onto the caller's box", () => {
		const svg = paintDrawing(data(list(120, 80)), context())

		expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg")
		expect(svg.getAttribute("viewBox")).toBe("0 0 120 80")
		expect(svg.getAttribute("preserveAspectRatio")).toBe("none")
		expect(svg.getAttribute("overflow")).toBe("visible")
		expect(svg.getAttribute("width")).toBe("100%")
		expect(svg.getAttribute("aria-hidden")).toBe("true")
		expect(svg.childNodes.length).toBe(0)
	})

	it("writes every path command", () => {
		const target = list()
		const fill = target.paint({ kind: "solid", color: rgba("FF0000") })

		addPath(
			target,
			() => {
				target.moveTo(1, 2)
				target.lineTo(3.14159, 4)
				target.cubicTo(5, 6, 7, 8, 9, 10)
				target.quadTo(11, 12, 13, 14)
				target.close()
			},
			fill
		)

		const path = paintDrawing(data(target), context()).querySelector("path")

		expect(path?.getAttribute("d")).toBe("M1 2L3.142 4C5 6 7 8 9 10Q11 12 13 14Z")
		expect(path?.getAttribute("fill")).toBe("#ff0000")
		expect(path?.hasAttribute("fill-opacity")).toBe(false)
		expect(path?.hasAttribute("transform")).toBe(false)
	})

	it("places items by their matrix and applies solid opacity", () => {
		const target = list()
		const fill = target.paint({ kind: "solid", color: rgba("00FF00", 0.5) })

		addPath(target, () => rect(target, 0, 0, 10, 10), fill, -1, 0, -1, [2, 0, 0, 2, 5, 6])

		const path = paintDrawing(data(target), context()).querySelector("path")

		expect(path?.getAttribute("transform")).toBe("matrix(2 0 0 2 5 6)")
		expect(path?.getAttribute("fill")).toBe("#00ff00")
		expect(path?.getAttribute("fill-opacity")).toBe("0.502")
	})

	it("draws no fill without a paint and honours even-odd and fill modifiers", () => {
		const target = list()
		const fill = target.paint({ kind: "solid", color: rgba("808080") })

		addPath(target, () => rect(target, 0, 0, 10, 10), -1)
		addPath(target, () => rect(target, 0, 0, 10, 10), fill, -1, ItemFlag.EVEN_ODD | ItemFlag.DARKEN)
		addPath(target, () => rect(target, 0, 0, 10, 10), fill, -1, ItemFlag.LIGHTEN)

		const paths = paintDrawing(data(target), context()).querySelectorAll("path")

		expect(paths[0]?.getAttribute("fill")).toBe("none")
		expect(paths[1]?.getAttribute("fill-rule")).toBe("evenodd")
		expect(paths[1]?.getAttribute("fill")).toBe("#4d4d4d")
		expect(paths[2]?.getAttribute("fill")).toBe("#b3b3b3")
	})

	it("skips hidden items", () => {
		const target = list()
		const fill = target.paint({ kind: "solid", color: rgba("000000") })

		addPath(target, () => rect(target, 0, 0, 10, 10), fill, -1, ItemFlag.HIDDEN)
		addPath(target, () => rect(target, 0, 0, 5, 5), fill)

		const paths = paintDrawing(data(target), context()).querySelectorAll("path")

		expect(paths.length).toBe(1)
		expect(paths[0]?.getAttribute("d")).toBe("M0 0L5 0L5 5L0 5Z")
	})

	it("puts gradients and patterns in defs under prefixed ids, shared between items", () => {
		const target = list()
		const stops = { offsets: new Float32Array([0, 1]), colors: new Uint32Array([rgba("FF0000"), rgba("0000FF", 0.5)]) }
		const linear = target.paint({ kind: "linear", stops, angle: 90, scaled: false })
		const radial = target.paint({ kind: "path", shape: "circle", stops, focus: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 } })
		const pattern = target.paint({ kind: "pattern", pattern: "dnDiag", foreground: rgba("000000"), background: rgba("FFFFFF") })
		const unknown = target.paint({ kind: "pattern", pattern: "plaid", foreground: rgba("000000"), background: rgba("FFFFFF") })

		addPath(target, () => rect(target, 0, 0, 10, 10), linear)
		addPath(target, () => rect(target, 0, 0, 10, 10), linear)
		addPath(target, () => rect(target, 0, 0, 10, 10), radial)
		addPath(target, () => rect(target, 0, 0, 10, 10), pattern)
		addPath(target, () => rect(target, 0, 0, 10, 10), unknown)

		const svg = paintDrawing(data(target), context())
		const defs = svg.querySelector("defs")
		const paths = svg.querySelectorAll(":scope > path")
		const gradient = defs?.querySelector("linearGradient")

		expect(svg.firstChild).toBe(defs)
		expect(defs?.querySelectorAll("linearGradient").length).toBe(1)
		expect(gradient?.getAttribute("x1")).toBe("0.5")
		expect(gradient?.getAttribute("y1")).toBe("0")
		expect(gradient?.getAttribute("y2")).toBe("1")
		expect(paths[0]?.getAttribute("fill")).toBe(`url(#${gradient?.id})`)
		expect(paths[1]?.getAttribute("fill")).toBe(`url(#${gradient?.id})`)

		const gradientStops = gradient?.querySelectorAll("stop")

		expect(gradientStops?.[1]?.getAttribute("stop-color")).toBe("#0000ff")
		expect(gradientStops?.[1]?.getAttribute("stop-opacity")).toBe("0.502")

		const radialGradient = defs?.querySelector("radialGradient")

		// The unit circle placed at the centre, its radius half the diagonal of the item's 2:1 box in that box's fractions.
		expect(radialGradient?.getAttribute("gradientTransform")).toBe("matrix(0.559 0 0 1.118 0.5 0.5)")
		expect(paths[2]?.getAttribute("fill")).toBe(`url(#${radialGradient?.id})`)

		const tile = defs?.querySelector("pattern")

		expect(tile?.getAttribute("width")).toBe("8")
		expect(tile?.querySelector("path")?.getAttribute("d")).toMatch(/^M\d/)
		expect(paths[3]?.getAttribute("fill")).toBe(`url(#${tile?.id})`)
		// An unknown preset blends foreground and background.
		expect(paths[4]?.getAttribute("fill")).toBe("#808080")

		for (const element of elements(svg)) {
			if (element.id !== "") expect(element.id.startsWith(`${PREFIX}-`)).toBe(true)
		}
	})

	it("keeps an unscaled gradient angle true on a non-square box", () => {
		const target = list()
		const stops = { offsets: new Float32Array([0, 1]), colors: new Uint32Array([rgba("000000"), rgba("FFFFFF")]) }
		const paint = target.paint({ kind: "linear", stops, angle: 45, scaled: false })

		addPath(target, () => rect(target, 0, 0, 100, 50), paint)

		const gradient = paintDrawing(data(target), context()).querySelector("linearGradient")
		const dx = Number(gradient?.getAttribute("x2")) - Number(gradient?.getAttribute("x1"))
		const dy = Number(gradient?.getAttribute("y2")) - Number(gradient?.getAttribute("y1"))

		// In the unit box the direction is (w cos, h sin): twice as far along x.
		expect(dx / dy).toBeCloseTo(2, 2)
	})

	it("strokes with width, caps, joins and dash arrays scaled by the width", () => {
		const target = list()
		const black = target.paint({ kind: "solid", color: rgba("000000") })
		const dashed = target.stroke(stroke({ paint: black, dash: "sysDashDot", cap: "round", join: "bevel" }))
		const custom = target.stroke(stroke({ paint: black, width: 3, customDash: new Float32Array([2, 1]), join: "miter", miterLimit: 8 }))

		addPath(target, () => rect(target, 0, 0, 10, 10), -1, dashed)
		addPath(target, () => rect(target, 0, 0, 10, 10), -1, custom)

		const paths = paintDrawing(data(target), context()).querySelectorAll("path")

		expect(paths[0]?.getAttribute("stroke")).toBe("#000000")
		expect(paths[0]?.getAttribute("stroke-width")).toBe("2")
		expect(paths[0]?.getAttribute("stroke-linecap")).toBe("round")
		expect(paths[0]?.getAttribute("stroke-linejoin")).toBe("bevel")
		expect(paths[0]?.getAttribute("stroke-dasharray")).toBe("6 2 2 2")
		expect(paths[1]?.getAttribute("stroke-dasharray")).toBe("6 3")
		expect(paths[1]?.getAttribute("stroke-miterlimit")).toBe("8")
		expect(paths[1]?.hasAttribute("stroke-linecap")).toBe(false)
	})

	it("draws images with a URL, crops them, and clips by the item path", () => {
		const target = list()
		const plain = target.image(image())
		const cropped = target.image(image({ crop: { left: 0.25, top: 0, right: 0.25, bottom: -0.5 }, alpha: 0.5, grayscale: true }))

		target.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 40, 20, target.commandCount, target.coordCount, -1, -1, plain, -1, 0, 0)

		const command = target.commandCount
		const coord = target.coordCount

		rect(target, 0, 0, 40, 20)
		target.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 40, 20, command, coord, -1, -1, cropped, -1, 0, 0)

		const svg = paintDrawing(data(target), context({ "/word/media/image1.png": "blob:https://app/1" }))
		const images = svg.querySelectorAll("image")

		expect(images.length).toBe(2)
		expect(images[0]?.getAttribute("href")).toBe("blob:https://app/1")
		expect(images[0]?.getAttribute("width")).toBe("40")
		expect(images[0]?.getAttribute("preserveAspectRatio")).toBe("none")

		const viewport = images[1]?.parentElement

		expect(viewport?.tagName.toLowerCase()).toBe("svg")
		expect(viewport?.getAttribute("viewBox")).toBe("0.25 0 0.5 1.5")
		expect(images[1]?.getAttribute("opacity")).toBe("0.5")
		expect(images[1]?.getAttribute("filter")).toMatch(new RegExp(`^url\\(#${PREFIX}-f\\d+\\)$`))
		expect(svg.querySelector("feColorMatrix")?.getAttribute("type")).toBe("saturate")

		const group = viewport?.parentElement
		const clipId = group?.getAttribute("clip-path")?.slice(5, -1)

		expect(clipId).toMatch(new RegExp(`^${PREFIX}-c\\d+$`))
		expect(svg.querySelector(`clipPath[id="${clipId}"] path`)?.getAttribute("d")).toBe("M0 0L40 0L40 20L0 20Z")
	})

	it("draws a placeholder for images without a URL and refuses non-blob URLs", () => {
		const target = list()
		const missing = target.image(image({ partName: undefined, format: "unknown", handling: "placeholder" }))
		const external = target.image(image({ partName: "/word/media/x.png" }))

		target.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 40, 20, target.commandCount, target.coordCount, -1, -1, missing, -1, 0, 0)
		target.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 40, 20, target.commandCount, target.coordCount, -1, -1, external, -1, 0, 0)

		const svg = paintDrawing(data(target), context({ "/word/media/x.png": "javascript:alert(1)" }))

		expect(svg.querySelectorAll("image").length).toBe(0)

		const rects = svg.querySelectorAll("rect")

		expect(rects.length).toBe(2)
		expect(rects[0]?.getAttribute("width")).toBe("40")
		expect(rects[0]?.getAttribute("vector-effect")).toBe("non-scaling-stroke")
		expect(attributeValues(svg).some(value => value.includes("javascript"))).toBe(false)
	})

	it("fills shapes with picture fills through a pattern", () => {
		const target = list()
		const picture = target.image(image())
		const paint = target.paint({
			kind: "image",
			image: picture,
			stretch: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 },
			tile: undefined
		})

		addPath(target, () => rect(target, 0, 0, 10, 10), paint)

		const svg = paintDrawing(data(target), context({ "/word/media/image1.png": "blob:x" }))
		const pattern = svg.querySelector("pattern")

		expect(pattern?.getAttribute("patternContentUnits")).toBe("objectBoundingBox")
		expect(pattern?.querySelector("image")?.getAttribute("x")).toBe("0.1")
		expect(pattern?.querySelector("image")?.getAttribute("width")).toBe("0.8")
		expect(svg.querySelector(":scope > path")?.getAttribute("fill")).toBe(`url(#${pattern?.id})`)
	})

	it("adds one drop-shadow filter per distinct shadow", () => {
		const target = list()
		const fill = target.paint({ kind: "solid", color: rgba("000000") })
		const shadow = target.shadow({ color: rgba("000000", 0.4), blur: 4, dx: 3, dy: 3, sx: 1, sy: 1 })
		const same = target.shadow({ color: rgba("000000", 0.4), blur: 4, dx: 3, dy: 3, sx: 1, sy: 1 })
		const absurd = target.shadow({ color: rgba("000000"), blur: 1e9, dx: 0, dy: 0, sx: 1, sy: 1 })

		addPath(target, () => rect(target, 0, 0, 10, 10), fill, -1, 0, shadow)
		addPath(target, () => rect(target, 0, 0, 10, 10), fill, -1, 0, same)
		addPath(target, () => rect(target, 0, 0, 10, 10), fill, -1, 0, absurd)

		const svg = paintDrawing(data(target), context())
		const drops = svg.querySelectorAll("feDropShadow")

		expect(drops.length).toBe(1)
		expect(drops[0]?.getAttribute("stdDeviation")).toBe("2")
		expect(drops[0]?.getAttribute("flood-opacity")).toBe("0.4")
		expect(svg.querySelectorAll(":scope > g[filter]").length).toBe(2)
		expect(svg.querySelectorAll(":scope > path").length).toBe(1)
	})

	it("lays out body text by line, anchored and styled", () => {
		const target = list()

		addText(
			target,
			[
				paragraph([run("Title", { bold: true, size: 18, font: "Times New Roman" })], { align: "ctr" }),
				paragraph([
					run("a", { underline: "sng", strike: "sngStrike" }),
					run("", { lineBreak: true }),
					run("b", { italic: true, font: "Consolas", caps: "all" })
				])
			],
			"ctr",
			-90
		)

		const svg = paintDrawing(data(target), context())
		const group = svg.querySelector("g")
		const texts = svg.querySelectorAll("text")

		expect(group?.getAttribute("transform")).toBe("rotate(270 50 25)")
		expect(texts.length).toBe(3)
		expect(texts[0]?.textContent).toBe("Title")
		expect(texts[0]?.getAttribute("text-anchor")).toBe("middle")
		expect(texts[0]?.getAttribute("x")).toBe("50")
		expect(texts[0]?.getAttribute("font-size")).toBe("24")
		expect(texts[0]?.getAttribute("font-weight")).toBe("bold")
		expect(texts[0]?.getAttribute("font-family")).toBe("serif")
		expect(texts[1]?.getAttribute("text-decoration")).toBe("underline line-through")
		expect(texts[1]?.getAttribute("fill")).toBe("#333333")
		expect(texts[2]?.textContent).toBe("B")
		expect(texts[2]?.getAttribute("font-family")).toBe("monospace")
		expect(texts[2]?.getAttribute("font-style")).toBe("italic")
		expect(Number(texts[1]?.getAttribute("y"))).toBeGreaterThan(Number(texts[0]?.getAttribute("y")))
	})

	it("splits runs of one line into tspans", () => {
		const target = list()

		addText(target, [paragraph([run("x"), run("2", { baseline: 0.3 }), run("y")], { align: "r" })], "b")

		const text = paintDrawing(data(target), context()).querySelector("text")
		const spans = text?.querySelectorAll("tspan")

		expect(text?.getAttribute("text-anchor")).toBe("end")
		expect(text?.getAttribute("x")).toBe("100")
		expect(spans?.length).toBe(3)
		expect(Number(spans?.[1]?.getAttribute("dy"))).toBeLessThan(0)
		expect(Number(spans?.[2]?.getAttribute("dy"))).toBeGreaterThan(0)
	})

	it("paints nothing for a story text box", () => {
		const target = list()
		const text = target.text({
			kind: "story",
			story: 3,
			body: {
				insets: { left: 0, top: 0, right: 0, bottom: 0 },
				anchor: "t",
				anchorCenter: false,
				vertical: "horz",
				wrap: true,
				rotation: 0,
				upright: false,
				columns: 1,
				columnSpacing: 0,
				autofit: "none",
				fontScale: 1,
				lineSpacingReduction: 0
			}
		})

		target.addItem(ItemKind.TEXT, IDENTITY, 0, 0, 100, 50, 0, 0, -1, -1, text, -1, 0, 0)

		expect(paintDrawing(data(target), context()).childNodes.length).toBe(0)
	})

	it("never turns document strings into markup or attributes", () => {
		const target = list()

		addText(target, [
			paragraph([run("<script>alert(1)</script>", { font: 'x" onload="alert(1)' })], { bullet: '"><img src=x onerror=alert(1)>' })
		])

		const svg = paintDrawing(data(target), context())

		for (const element of elements(svg)) {
			expect(ALLOWED_TAGS.has(element.tagName)).toBe(true)
			expect(Array.from(element.attributes).some(attribute => attribute.name.startsWith("on"))).toBe(false)
		}

		expect(svg.querySelector("script")).toBeNull()
		expect(svg.querySelector("img")).toBeNull()
		expect(attributeValues(svg).some(value => value.includes("alert") || value.includes("<"))).toBe(false)
		expect(svg.textContent).toContain("<script>alert(1)</script>")
	})

	it("clamps absurd numbers and refuses broken data", () => {
		const target = list()
		const fill = target.paint({ kind: "solid", color: rgba("000000") })

		addPath(target, () => rect(target, 0, 0, 10, 10), fill)

		const base = data(target)
		const floats = base.itemFloats.slice()
		const coords = base.coords.slice()

		floats[0] = Number.NaN
		floats[4] = Number.POSITIVE_INFINITY
		coords[2] = Number.NaN
		coords[3] = 1e30

		const broken: DrawingData = {
			...base,
			width: Number.NaN,
			itemCount: 1e9,
			itemFloats: floats,
			coords,
			paints: [...base.paints, { kind: "bogus" } as unknown as Paint],
			shadows: [{ color: rgba("000000"), blur: Number.NaN, dx: 1, dy: 1, sx: 1, sy: 1 }]
		}
		const badStart = broken.itemInts.slice()
		const badShadow = broken.itemInts.slice()

		badStart[1] = -5
		badShadow[7] = 0

		const svg = paintDrawing({ ...broken, itemInts: badStart }, context())

		expect(svg.hasAttribute("viewBox")).toBe(false)
		expect(svg.querySelectorAll("path").length).toBe(0)

		const valid = paintDrawing({ ...broken, itemInts: badShadow }, context())
		const values = attributeValues(valid)

		expect(values.some(value => /NaN|Infinity|e\+/.test(value))).toBe(false)
		expect(valid.querySelector("path")?.getAttribute("d")).toBe("M0 0L0 2147483648L10 10L0 10Z")
		expect(valid.querySelector("feDropShadow")).toBeNull()
	})
})

describe("drawingImages", () => {
	it("lists every shown image once, preferring the SVG part as the key", () => {
		const target = list()
		const first = target.image(image())
		const again = target.image(image())
		const svg = target.image(image({ partName: "/word/media/image2.png", svgPartName: "/word/media/image3.svg" }))
		const hidden = target.image(image({ partName: "/word/media/hidden.png" }))
		const missing = target.image(image({ partName: undefined }))
		const paint = target.paint({ kind: "image", image: svg, stretch: undefined, tile: undefined })

		target.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 1, 1, 0, 0, -1, -1, first, -1, 0, 0)
		target.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 1, 1, 0, 0, -1, -1, again, -1, 0, 0)
		target.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 1, 1, 0, 0, -1, -1, hidden, -1, ItemFlag.HIDDEN, 0)
		target.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 1, 1, 0, 0, -1, -1, missing, -1, 0, 0)
		addPath(target, () => rect(target, 0, 0, 1, 1), paint)

		const images = drawingImages(data(target))

		expect(images.map(item => item.svgPartName ?? item.partName)).toEqual(["/word/media/image1.png", "/word/media/image3.svg"])
	})
})

describe("imageMime", () => {
	it("maps natively shown formats and refuses the rest", () => {
		expect(imageMime(image())).toBe("image/png")
		expect(imageMime(image({ format: "jpeg" }))).toBe("image/jpeg")
		expect(imageMime(image({ format: "svg" }))).toBe("image/svg+xml")
		expect(imageMime(image({ svgPartName: "/word/media/a.svg" }))).toBe("image/svg+xml")
		expect(imageMime(image({ format: "tiff" }))).toBe("")
		expect(imageMime(image({ format: "emf" }))).toBe("")
		expect(imageMime(image({ format: "unknown" }))).toBe("")
	})
})
