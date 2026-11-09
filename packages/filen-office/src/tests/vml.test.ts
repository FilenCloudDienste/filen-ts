import { describe, expect, it } from "vitest"
import {
	DrawingList as DrawingListClass,
	ItemFlag,
	ItemFloat,
	ItemInt,
	ItemKind,
	PathCommand,
	rgba,
	type DrawingList
} from "../core/drawingml/displayList"
import type { ImageResolver } from "../core/drawingml/picture"
import { convertVml, emitVmlPath, evaluateFormulas, parseVmlColor, tokenizePath, type VmlConversion } from "../core/vml/index"
import { MAX_PATH_COMMANDS } from "../core/vml/path"
import { encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"

const NAMESPACES = [
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
	'xmlns:v="urn:schemas-microsoft-com:vml"',
	'xmlns:o="urn:schemas-microsoft-com:office:office"',
	'xmlns:w10="urn:schemas-microsoft-com:office:word"',
	'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
].join(" ")

const PT = 96 / 72

const IMAGES: ImageResolver = id => (id === "rId7" ? { partName: "/word/media/image1.png", contentType: "image/png" } : undefined)

function parse(body: string): XmlDocument {
	return parseXml(encodeUtf8(`<w:document ${NAMESPACES}><w:body><w:p><w:r><w:pict>${body}</w:pict></w:r></w:p></w:body></w:document>`))
}

function find(document: XmlDocument, local: string): number {
	for (let node = 0; node < document.count; node++) {
		if (document.localName(node) === local) return node
	}

	return -1
}

function convert(body: string, effects: boolean = false): VmlConversion {
	const document = parse(body)
	const result = convertVml({ images: IMAGES, effects }, document, find(document, "pict"))

	if (result === undefined) throw new Error("Nothing converted")

	return result
}

function kinds(list: DrawingList): number[] {
	return Array.from({ length: list.itemCount }, (_, item) => list.kind(item))
}

// The item's path as [command, ...coords] tuples, in local px.
function path(list: DrawingList, item: number): number[][] {
	const out: number[][] = []
	let at = list.itemInt(item, ItemInt.FIRST_COORD)
	const first = list.itemInt(item, ItemInt.FIRST_COMMAND)

	for (let k = first; k < first + list.itemInt(item, ItemInt.COMMAND_COUNT); k++) {
		const command = list.commands[k] ?? 0
		const count = [2, 2, 6, 4, 0][command] ?? 0

		out.push([command, ...Array.from(list.coords.slice(at, at + count), value => Math.round(value * 100) / 100)])
		at += count
	}

	return out
}

function fillOf(list: DrawingList, item: number): unknown {
	const index = list.itemInt(item, ItemInt.FILL)

	return index < 0 ? undefined : list.paints[index]
}

describe("VML shapes", () => {
	it("draws a rectangle with fill and stroke attributes", () => {
		const { list, placement } = convert(
			'<v:rect style="position:absolute;margin-left:10pt;margin-top:5pt;width:100pt;height:50pt;z-index:3" fillcolor="red" strokecolor="#00f" strokeweight="2pt"/>'
		)

		expect(kinds(list)).toEqual([ItemKind.PATH])
		expect(path(list, 0)).toEqual([
			[PathCommand.MOVE, 0, 0],
			[PathCommand.LINE, 133.33, 0],
			[PathCommand.LINE, 133.33, 66.67],
			[PathCommand.LINE, 0, 66.67],
			[PathCommand.CLOSE]
		])
		expect(fillOf(list, 0)).toEqual({ kind: "solid", color: rgba("FF0000") })
		expect(list.strokes[list.itemInt(0, ItemInt.STROKE)]).toMatchObject({ width: 2 * PT, cap: "flat", join: "round" })
		expect(list.paints[list.strokes[0]?.paint ?? -1]).toEqual({ kind: "solid", color: rgba("0000FF") })
		expect(placement).toMatchObject({
			position: "absolute",
			marginLeft: 10 * PT,
			marginTop: 5 * PT,
			width: 100 * PT,
			height: 50 * PT,
			zIndex: 3
		})
		expect(list.itemInt(0, ItemInt.FLAGS) & ItemFlag.EVEN_ODD).toBe(ItemFlag.EVEN_ODD)
	})

	it("defaults to a white fill and a black 0.75pt stroke", () => {
		const { list } = convert('<v:oval style="width:40px;height:20px"/>')

		expect(fillOf(list, 0)).toEqual({ kind: "solid", color: rgba("FFFFFF") })
		expect(list.strokes[0]).toMatchObject({ width: 1 })

		const commands = path(list, 0)

		expect(commands[0]).toEqual([PathCommand.MOVE, 40, 10])
		expect(commands.filter(command => command[0] === PathCommand.CUBIC)).toHaveLength(4)
		expect(Array.from(list.bounds())).toEqual([-0.5, -0.5, 40.5, 20.5])
	})

	it("honours filled and stroked off", () => {
		const { list } = convert('<v:rect style="width:10px;height:10px" filled="f" stroked="f"/>')

		expect(list.itemCount).toBe(0)
	})

	it("rounds a roundrect by arcsize of half the shorter side", () => {
		const { list } = convert('<v:roundrect style="width:100px;height:40px" arcsize="50%"/>')

		expect(path(list, 0)[0]).toEqual([PathCommand.MOVE, 10, 0])
	})

	it("places a line by its end points and adds arrowheads", () => {
		const { list, placement } = convert(
			'<v:line style="position:absolute" from="10pt,20pt" to="40pt,20pt"><v:stroke endarrow="block" startarrow="oval"/></v:line>'
		)

		expect(placement.marginLeft).toBeCloseTo(10 * PT)
		expect(placement.marginTop).toBeCloseTo(20 * PT)
		expect(placement.width).toBeCloseTo(30 * PT)
		expect(kinds(list)).toEqual([ItemKind.PATH, ItemKind.PATH, ItemKind.PATH])
		expect(list.itemInt(0, ItemInt.FILL)).toBe(-1)
		// The stroke ends at the block arrow's base (three widths of the 1 px line before its tip); the oval needs no trim.
		expect(path(list, 0)).toEqual([
			[PathCommand.MOVE, 0, 0],
			[PathCommand.LINE, 37, 0]
		])
		expect(list.itemInt(1, ItemInt.FLAGS) & ItemFlag.DECORATION).toBe(ItemFlag.DECORATION)
		// The block arrow's tip sits on the line's end.
		expect(path(list, 2)[0]).toEqual([PathCommand.MOVE, 40, 0])
	})

	it("draws polylines from their points", () => {
		const { list } = convert('<v:polyline style="position:absolute" points="0,0,10,0,10,10" filled="f"/>')

		expect(path(list, 0)).toEqual([
			[PathCommand.MOVE, 0, 0],
			[PathCommand.LINE, 10, 0],
			[PathCommand.LINE, 10, 10]
		])
	})

	it("scales a v:shape path from its coordinate space, empty members reading as 0", () => {
		const { list } = convert('<v:shape style="width:200px;height:100px" coordsize="21600,21600" path="m,l,21600r21600,l21600,xe"/>')

		expect(path(list, 0)).toEqual([
			[PathCommand.MOVE, 0, 0],
			[PathCommand.LINE, 0, 100],
			[PathCommand.LINE, 200, 100],
			[PathCommand.LINE, 200, 0],
			[PathCommand.CLOSE]
		])
	})

	it("evaluates shapetype formulas with adjust values", () => {
		const { list } = convert(
			'<v:shapetype id="_x0000_t5" coordsize="100,100" adj="25" path="m@0,l@1,0,100,100xe"><v:formulas><v:f eqn="val #0"/><v:f eqn="sum 100 0 @0"/></v:formulas></v:shapetype>' +
				'<v:shape type="#_x0000_t5" adj="10" style="width:100px;height:100px"/>'
		)

		expect(path(list, 0).slice(0, 3)).toEqual([
			[PathCommand.MOVE, 10, 0],
			[PathCommand.LINE, 90, 0],
			[PathCommand.LINE, 100, 100]
		])
	})

	it("splits nf/ns segments into separate items", () => {
		const { list } = convert('<v:shape style="width:10px;height:10px" coordsize="10,10" path="m,l10,10nfem10,l,10nse"/>')

		expect(list.itemCount).toBe(2)
		expect(list.itemInt(0, ItemInt.FILL)).toBe(-1)
		expect(list.itemInt(1, ItemInt.STROKE)).toBe(-1)
	})

	it("draws pictures from v:imagedata with crops, leaving a picture frame unfilled", () => {
		const { list } = convert(
			'<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f"/>' +
				'<v:shape type="#_x0000_t75" style="width:50pt;height:20pt"><v:imagedata r:id="rId7" cropleft="16384f" croptop=".25" grayscale="t"/></v:shape>'
		)

		expect(kinds(list)).toEqual([ItemKind.IMAGE])
		expect(list.images[0]).toMatchObject({
			partName: "/word/media/image1.png",
			format: "png",
			handling: "native",
			crop: { left: 0.25, top: 0.25, right: 0, bottom: 0 },
			grayscale: true
		})
		expect(list.itemFloat(0, ItemFloat.WIDTH)).toBeCloseTo(50 * PT)
	})

	it("keeps unresolvable pictures as placeholders", () => {
		const { list } = convert('<v:shape style="width:10px;height:10px" stroked="f"><v:imagedata o:relid="rId99"/></v:shape>')

		expect(list.images[0]).toMatchObject({ partName: undefined, handling: "placeholder" })
	})

	it("reads gradients with focus and opacity", () => {
		const { list } = convert(
			'<v:rect style="width:10px;height:10px" fillcolor="black"><v:fill type="gradient" color2="white" focus="100%" opacity=".5"/></v:rect>'
		)
		const fill = fillOf(list, 0) as { kind: string; angle: number; stops: { offsets: Float32Array; colors: Uint32Array } }

		expect(fill.kind).toBe("linear")
		expect(fill.angle).toBe(270)
		expect(Array.from(fill.stops.offsets)).toEqual([0, 1])
		// focus 100%: color2 first, the fill colour at the end.
		expect(Array.from(fill.stops.colors)).toEqual([rgba("FFFFFF", 0.5), rgba("000000", 0.5)])
	})

	it("turns gradient angles counter-clockwise, as VML does", () => {
		const angle = (value: string): number => {
			const { list } = convert(
				`<v:rect style="width:10px;height:10px" fillcolor="blue"><v:fill type="gradient" color2="red" angle="${value}"/></v:rect>`
			)

			return (fillOf(list, 0) as { angle: number }).angle
		}

		// The reference's 45 degree example: red (color2) top left, blue bottom right.
		expect(angle("45")).toBe(225)
		expect(angle("90")).toBe(180)
		expect(angle("-90")).toBe(0)
		expect(angle("-135")).toBe(45)
	})

	it("draws stroke ends flat unless endcap says otherwise", () => {
		const cap = (stroke: string): unknown => {
			const { list } = convert(`<v:line from="0,0" to="10pt,0">${stroke}</v:line>`)

			return list.strokes[0]?.cap
		}

		expect(cap("")).toBe("flat")
		expect(cap('<v:stroke endcap="round"/>')).toBe("round")
		expect(cap('<v:stroke endcap="square"/>')).toBe("square")
		expect(cap('<v:stroke endcap="bogus"/>')).toBe("flat")
	})

	it("reads an axial gradient from a 50% focus and colour stops", () => {
		const { list } = convert(
			'<v:rect style="width:10px;height:10px" fillcolor="red"><v:fill type="gradient" color2="blue" focus="50%"/></v:rect>'
		)
		const fill = fillOf(list, 0) as { stops: { offsets: Float32Array; colors: Uint32Array } }

		expect(Array.from(fill.stops.offsets)).toEqual([0, 0.5, 0.5, 1])
		expect(fill.stops.colors[0]).toBe(rgba("0000FF"))
		expect(fill.stops.colors[1]).toBe(rgba("FF0000"))
	})

	it("draws WordArt text paths as text, not as their guide path", () => {
		const { list, textPaths } = convert(
			'<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e"><v:path textpathok="t" o:connecttype="custom"/><v:textpath on="t" fitshape="t"/></v:shapetype>' +
				'<v:shape type="#_x0000_t136" style="width:300pt;height:100pt;rotation:315" fillcolor="silver" stroked="f"><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt;font-weight:bold" string="DRAFT"/></v:shape>'
		)

		expect(kinds(list)).toEqual([ItemKind.TEXT])
		expect(textPaths).toEqual([0])

		const text = list.texts[0]

		// fitshape (from the shapetype): stretched to the 300 x 100pt box, one line an em tall; the style's 1pt is ignored.
		expect(text).toMatchObject({
			kind: "block",
			width: 300 * PT,
			height: 100 * PT,
			lineHeight: 100 * PT,
			align: "middle",
			lineAlign: "middle",
			wrap: false,
			stretch: true
		})

		if (text?.kind !== "block") return

		expect(text.run).toMatchObject({ text: "DRAFT", font: "Calibri", bold: true, color: rgba("C0C0C0") })
		expect(text.run.size).toBeCloseTo(100)
		expect(text.fill).toBeUndefined()
		// Rotated about the box centre.
		expect(list.itemFloat(0, ItemFloat.A)).toBeCloseTo(Math.cos((315 * Math.PI) / 180))
	})

	it("keeps a text path's own size without fitshape and paints it with a gradient fill", () => {
		const { list } = convert(
			'<v:shape style="width:300pt;height:100pt" fillcolor="blue" stroked="f"><v:fill type="gradient" color2="red"/><v:textpath on="t" style="font-family:Arial;font-size:20pt" string="Hi"/></v:shape>'
		)
		const text = list.texts[0]

		expect(text).toMatchObject({ kind: "block", width: 300 * PT, height: 100 * PT, lineHeight: 20 * PT * 1.2 })

		if (text?.kind !== "block") return

		expect(text.stretch).toBeUndefined()
		expect(text.run).toMatchObject({ text: "Hi", size: 20 })
		expect(list.paints[text.fill ?? -1]).toMatchObject({ kind: "linear", angle: 270 })
	})

	it("exposes text box stories with their insets and anchor", () => {
		const document = parse(
			'<v:rect style="width:100px;height:50px;v-text-anchor:middle"><v:textbox inset="1pt,,3pt"><w:txbxContent><w:p/></w:txbxContent></v:textbox></v:rect>'
		)
		const content = find(document, "txbxContent")
		const result = convertVml({ images: IMAGES, story: node => (node === content ? 42 : -1) }, document, find(document, "pict"))

		expect(result?.textboxes).toEqual([content])
		expect(kinds(result?.list as DrawingList)).toEqual([ItemKind.PATH, ItemKind.TEXT])
		expect(result?.list.texts[0]).toMatchObject({
			kind: "story",
			story: 42,
			body: { anchor: "ctr", insets: { left: PT, top: 4.8, right: 3 * PT, bottom: 4.8 } }
		})
	})

	it("maps group children through coordsize and coordorigin", () => {
		const { list } = convert(
			'<v:group style="position:absolute;width:200px;height:100px" coordorigin="100,100" coordsize="1000,1000">' +
				'<v:rect style="position:absolute;left:600;top:100;width:500;height:500"/>' +
				"</v:group>"
		)

		expect(list.width).toBe(200)
		expect(list.itemFloat(0, ItemFloat.E)).toBeCloseTo(100)
		expect(list.itemFloat(0, ItemFloat.F)).toBeCloseTo(0)
		expect(list.itemFloat(0, ItemFloat.WIDTH)).toBeCloseTo(100)
		expect(list.itemFloat(0, ItemFloat.HEIGHT)).toBeCloseTo(50)
	})

	it("flags hidden shapes", () => {
		const { list } = convert('<v:rect style="width:10px;height:10px;visibility:hidden"/>')

		expect(list.itemInt(0, ItemInt.FLAGS) & ItemFlag.HIDDEN).toBe(ItemFlag.HIDDEN)
	})

	it("adds shadows only when effects are on", () => {
		const body = '<v:rect style="width:10px;height:10px"><v:shadow on="t" color="gray" offset="3pt,3pt"/></v:rect>'

		expect(convert(body).list.itemInt(0, ItemInt.SHADOW)).toBe(-1)

		const shadowed = convert(body, true).list

		expect(shadowed.shadows[shadowed.itemInt(0, ItemInt.SHADOW)]).toMatchObject({ color: rgba("808080"), dx: 3 * PT, dy: 3 * PT })
	})

	it("reads placement enums and wrapping", () => {
		const { placement } = convert(
			'<v:rect style="position:absolute;margin-left:0;margin-top:0;width:10pt;height:10pt;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:bogus;mso-wrap-distance-left:9pt;flip:x" o:allowincell="f"><w10:wrap type="square" side="left"/></v:rect>'
		)

		expect(placement).toMatchObject({
			horizontal: "center",
			horizontalRelative: "margin",
			vertical: undefined,
			flipH: true,
			flipV: false,
			allowInCell: false,
			wrap: { type: "square", side: "left" }
		})
		expect(placement.wrapDistance.left).toBeCloseTo(12)
	})

	it("returns undefined without a drawable element", () => {
		const document = parse('<v:shapetype id="x" path="m,l1,1e"/>')

		expect(convertVml({ images: IMAGES }, document, find(document, "pict"))).toBeUndefined()
	})
})

describe("hostile VML", () => {
	it("cuts group nesting past the depth limit instead of overflowing the stack", () => {
		const depth = 20000
		const document = parse(
			`${'<v:group style="width:100;height:100" coordsize="100,100">'.repeat(depth)}<v:rect style="width:10;height:10"/>${"</v:group>".repeat(depth)}`
		)
		const result = convertVml({ images: IMAGES }, document, find(document, "pict"))

		expect(result?.unsupported).toBe(1)
		expect(result?.list.itemCount).toBe(0)
	})

	it("bounds the commands of a huge path", () => {
		const list = new DrawingListClass()

		emitVmlPath(
			list,
			`m0,0${"l1,2,3,4".repeat(600000)}e`,
			{ originX: 0, originY: 0, scaleX: 1, scaleY: 1 },
			new Float64Array(),
			[],
			() => undefined
		)

		expect(list.commandCount).toBeLessThanOrEqual(MAX_PATH_COMMANDS + 1)
	})
})

describe("VML values", () => {
	it("parses colours", () => {
		expect(parseVmlColor("#abc")).toBe("AABBCC")
		expect(parseVmlColor("black [3213]")).toBe("000000")
		expect(parseVmlColor("windowText")).toBe("000000")
		expect(parseVmlColor("rgb(255, 0, 16)")).toBe("FF0010")
		expect(parseVmlColor("fill darken(128)", undefined, "FF8000")).toBe("804000")
		expect(parseVmlColor("fill lighten(0)", undefined, "123456")).toBe("FFFFFF")
		expect(parseVmlColor("url(javascript:x)")).toBeUndefined()
		expect(
			parseVmlColor("accent1", {
				scheme: name => (name === "accent1" ? "4472C4" : undefined),
				majorFont: FONTS,
				minorFont: FONTS,
				formats: undefined
			})
		).toBe("4472C4")
	})

	it("tokenises paths with empty members and @ references", () => {
		expect(tokenizePath("m@4@5l@4@11,21600,xe")).toEqual([
			{ command: "m", args: ["@4", "@5"] },
			{ command: "l", args: ["@4", "@11", "21600", ""] },
			{ command: "x", args: [] },
			{ command: "e", args: [] }
		])
		expect(tokenizePath("m,l-5-6nfqx1,2")).toEqual([
			{ command: "m", args: ["", ""] },
			{ command: "l", args: ["-5", "-6"] },
			{ command: "nf", args: [] },
			{ command: "qx", args: ["1", "2"] }
		])
	})

	it("evaluates the formula language", () => {
		const env = {
			width: 21600,
			height: 21600,
			originX: 0,
			originY: 0,
			pixelWidth: 100,
			pixelHeight: 50,
			pixelLineWidth: 2,
			lineDrawn: true,
			hasFill: true,
			adjust: [5400]
		}
		const results = evaluateFormulas(
			[
				"val #0",
				"sum @0 100 0",
				"prod @1 1 2",
				"mid width 0",
				"if lineDrawn pixelLineWidth 0",
				"abs -3",
				"min 4 2",
				"max 4 2",
				"mod 3 4 0",
				"sqrt 16",
				"ellipse 0 10 7"
			],
			env
		)

		expect(Array.from(results)).toEqual([5400, 5500, 2750, 10800, 2, 3, 2, 4, 5, 4, 7])
	})
})

const FONTS = { latin: "", eastAsia: "", complex: "" }
