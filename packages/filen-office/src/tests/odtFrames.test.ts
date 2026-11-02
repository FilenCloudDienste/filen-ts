import { describe, expect, it } from "vitest"
import { customGeometry, enhancedPath, Evaluator, GeometryError, parseFormula, svgPath } from "../core/odt/geometry"
import { documentXml, translated } from "./odtFixtures"
import { png } from "./security/generate"

const WRAP = (mode: string): string =>
	`<style:style style:name="fr" style:family="graphic"><style:graphic-properties style:wrap="${mode}" style:horizontal-pos="right" style:horizontal-rel="paragraph" style:vertical-pos="top" style:vertical-rel="paragraph" fo:margin-left="0cm" fo:margin-right="0cm"/></style:style>`
const FRAME = (gap: number): string =>
	`<text:p>i i i<draw:frame draw:style-name="fr" text:anchor-type="paragraph" svg:width="${17 - gap}cm" svg:height="2cm"><draw:text-box><text:p>box</text:p></draw:text-box></draw:frame></text:p>`

describe("ODT frames", () => {
	it("makes a text box a shape whose text is its blocks", async () => {
		const xml = await documentXml({ automatic: WRAP("parallel"), body: FRAME(5) })

		expect(xml).toMatch(/<wps:wsp>.*<wps:cNvSpPr txBox="1"\/>.*<w:txbxContent><w:p>.*box.*<\/w:p><\/w:txbxContent>/)
		expect(xml).toContain('<wp:positionH relativeFrom="column"><wp:align>right</wp:align></wp:positionH>')
	})

	// Measured over UNO on LibreOffice 7.5 (a 17 cm column, the frame aligned right): optimal wrapping leaves a
	// 1.99 cm gap empty and fills a 2.01 cm one; parallel wrapping fills a 0.2 cm gap.
	it("flows text beside an optimally wrapped frame only into a gap of 2 cm or more", async () => {
		expect(await documentXml({ automatic: WRAP("dynamic"), body: FRAME(1.99) })).toContain("<wp:wrapTopAndBottom/>")
		expect(await documentXml({ automatic: WRAP("dynamic"), body: FRAME(2.01) })).toContain('<wp:wrapSquare wrapText="left"/>')
		expect(await documentXml({ automatic: WRAP("parallel"), body: FRAME(0.2) })).toContain('<wp:wrapSquare wrapText="bothSides"/>')
	})

	it("shows an embedded object's replacement image, or a placeholder box, and counts the objects", async () => {
		const manifest =
			'<manifest:file-entry manifest:full-path="Object 1/" manifest:media-type="application/vnd.oasis.opendocument.chart"/><manifest:file-entry manifest:full-path="Object 2/" manifest:media-type="application/vnd.oasis.opendocument.chart"/>'
		const svm = new Uint8Array([0x56, 0x43, 0x4c, 0x4d, 0x54, 0x46, 0, 0])
		const translation = await translated({
			body:
				'<text:p><draw:frame text:anchor-type="as-char" svg:width="4cm" svg:height="3cm"><draw:object xlink:href="./Object 1"/><draw:image xlink:href="./ObjectReplacements/Object 1"/></draw:frame>' +
				'<draw:frame text:anchor-type="as-char" svg:width="4cm" svg:height="3cm"><draw:object xlink:href="./Object 2"/><draw:image xlink:href="./ObjectReplacements/Object 2"/></draw:frame></text:p>',
			extra: [
				{ name: "ObjectReplacements/Object 1", data: png(4, 3) },
				{ name: "ObjectReplacements/Object 2", data: svm }
			],
			manifestExtra: manifest
		})
		const xml = new TextDecoder().decode(translation.parts.get("word/document.xml") as Uint8Array)

		expect(xml).toContain("<pic:pic>")
		expect(xml).toContain('<a:srgbClr val="F2F2F2"/>')
		expect(translation.objects.get("chart")).toBe(2)
		expect(translation.parts.has("word/media/image1.png")).toBe(true)
		expect(translation.origins[0]?.lossy).toContain("embeddedObject")
	})

	it("draws a custom shape from its enhanced geometry", async () => {
		const xml = await documentXml({
			body: '<text:p><draw:custom-shape text:anchor-type="paragraph" svg:width="2cm" svg:height="1cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:modifiers="5400" draw:enhanced-path="M ?f0 0 L right ?f1 0 bottom Z N"><draw:equation draw:name="f0" draw:formula="$0 "/><draw:equation draw:name="f1" draw:formula="bottom / 2"/></draw:enhanced-geometry></draw:custom-shape></text:p>'
		})

		expect(xml).toContain(
			'<a:path w="100000" h="100000"><a:moveTo><a:pt x="25000" y="0"/></a:moveTo><a:lnTo><a:pt x="100000" y="50000"/></a:lnTo><a:lnTo><a:pt x="0" y="100000"/></a:lnTo><a:close/></a:path>'
		)
	})
})

describe("a custom shape its type draws", () => {
	it("is the DrawingML preset it names, a trapezoid turned the way ODF draws it and its inset measured on the width", async () => {
		const shape = (type: string, extra = ""): string =>
			`<draw:custom-shape text:anchor-type="paragraph" svg:width="4cm" svg:height="2cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="${type}"${extra}/></draw:custom-shape>`
		const xml = await documentXml({
			body: `<text:p>${shape("trapezoid")}${shape("trapezoid", ' draw:mirror-vertical="true"')}${shape("right-arrow", ' draw:mirror-horizontal="true"')}</text:p>`
		})
		const shapes = xml.match(/<wps:spPr>.*?<\/a:prstGeom>/gu) ?? []

		// ODF's default 5400 of 21600 across a 2:1 box is 50000 of the shorter side.
		expect(shapes[0]).toMatch(
			/<a:xfrm flipV="1">.*<a:prstGeom prst="trapezoid"><a:avLst><a:gd name="adj" fmla="val 50000"\/><\/a:avLst>/u
		)
		expect(shapes[1]).toMatch(/<a:xfrm><.*<a:prstGeom prst="trapezoid">/u)
		expect(shapes[2]).toMatch(/<a:xfrm flipH="1">.*<a:prstGeom prst="rightArrow">/u)
	})
})

describe("Fontwork", () => {
	it("shows a text-path shape's text without drawing its path", async () => {
		const xml = await documentXml({
			body: '<text:p><draw:custom-shape text:anchor-type="paragraph" svg:width="4cm" svg:height="2cm"><text:p>curved</text:p><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:text-path="true" draw:enhanced-path="U 10800 10800 10800 10800 0 360 Z N"/></draw:custom-shape></text:p>'
		})

		expect(xml).toContain("curved")
		expect(xml).not.toContain("<a:custGeom>")
		expect(xml).toMatch(/<a:noFill\/><a:ln><a:noFill\/><\/a:ln>/)
	})
})

describe("enhanced geometry", () => {
	const evaluator = (equations: Record<string, string>, modifiers: number[] = []): Evaluator =>
		new Evaluator({
			left: 0,
			top: 0,
			width: 100,
			height: 50,
			logWidth: 1000,
			logHeight: 500,
			modifiers,
			equations: new Map(Object.entries(equations))
		})

	it("evaluates formulas with functions, constants, modifiers and other equations", () => {
		const value = evaluator({ a: "max(width, height) / 2 + $0", b: "if(?a - 60, sqrt(16), abs(-3)) * cos(pi)" }, [20])

		expect(value.value("?a")).toBe(70)
		expect(value.value("?b")).toBeCloseTo(-4)
		expect(value.value("logwidth")).toBe(1000)
	})

	it("refuses formulas that refer to themselves", () => {
		expect(() => evaluator({ a: "?b + 1", b: "?a" }).value("?a")).toThrow(GeometryError)
		expect(() => parseFormula("1 + (2")).toThrow(GeometryError)
	})

	it("turns arcs and quadrants into cubic curves that end where the arc ends", () => {
		const [path] = enhancedPath("U 50 25 50 25 0 360 Z N", evaluator({}))
		const segments = path?.segments ?? []
		const last = segments[segments.length - 2]

		expect(segments[0]).toEqual({ kind: "M", x: 100, y: 25 })
		expect(segments.filter(segment => segment.kind === "C")).toHaveLength(4)
		expect(last?.kind === "C" ? [Math.round(last.x), Math.round(last.y)] : []).toEqual([100, 25])

		const [quadrant] = enhancedPath("M 0 0 X 10 10 Y 20 0", evaluator({}))

		expect(quadrant?.segments.map(segment => segment.kind)).toEqual(["M", "C", "C"])
	})

	it("reads SVG path data, relative commands and arcs included", () => {
		const [path] = svgPath("m 10 10 h 10 v 10 a 5 5 0 0 1 -10 0 z")

		expect(path?.segments[1]).toEqual({ kind: "L", x: 20, y: 10 })
		expect(path?.segments[2]).toEqual({ kind: "L", x: 20, y: 20 })
		expect(
			customGeometry(
				{ left: 0, top: 0, width: 40, height: 40, paths: [path ?? { segments: [], fill: true, stroke: true }] },
				false,
				false
			)
		).toContain("<a:cubicBezTo>")
	})
})
