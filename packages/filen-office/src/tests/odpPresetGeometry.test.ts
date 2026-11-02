import { describe, expect, it } from "vitest"
import { bytesSource, memorySink } from "@filen/office/core/opc"
import { openOdp } from "../core/odp/read/document"
import { odfPresetGeometry, presetOfOdfType } from "../core/odf/presetShapes"
import { writeFreshOdp } from "../core/odp/write/fresh"
import { slideRef, type Geometry, type ShapeNode, type SlideRef, type Xfrm } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { FIXTURE_FIRST_SLIDE, fixtureDeck } from "./fixtures/presentation/deck"
import { presetNames, presetProgram } from "../core/drawingml/geometry/evaluate"
import { PRESET_ANGLE_ADJUSTS } from "../core/drawingml/geometry/presets.generated"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { freshFromPptx } from "./odpWriteFreshFixtures"
import { entriesOf, openOdpDeck, text } from "./odpWriteFixtures"
import { buildPptx, sp } from "./pptxFixtures"

// DrawingML presets as ODF custom shapes (ODF 1.3 Part 3 §19.145, §19.167): a type that draws the same outline, else
// LibreOffice's ooxml-<preset> with the outline evaluated for the box, and read back as the preset with its adjustments.

const WIDE: Xfrm = { x: 914_400, y: 914_400, cx: 3_600_000, cy: 1_800_000, rot: 0, flipH: false, flipV: false }

function shape(id: number, name: string, geometry: Geometry, xfrm: Xfrm = WIDE): ShapeNode {
	return { id, name, hidden: false, kind: "sp", xfrm, props: { geometry } }
}

function preset(name: string, ...guides: [string, number][]): Geometry {
	return { kind: "preset", preset: name, guides: guides.map(([guide, value]) => ({ name: guide, formula: `val ${value}` })) }
}

async function convert(shapes: ShapeNode[]) {
	const deck = fixtureDeck(1)
	const slide = deck.nodes.get(slideRef(FIXTURE_FIRST_SLIDE))

	if (slide === undefined) throw new Error("fixture slide missing")

	slide.shapes.push(...shapes)

	const sink = memorySink()
	const written = await writeFreshOdp(deck, { theme: () => undefined, picture: () => Promise.resolve(undefined) }, sink)

	if ("kind" in written) throw new Error(`refused ${written.reason}`)

	const content = text((await entriesOf(sink.bytes())).get("content.xml"))
	const opened = await openOdp(bytesSource(sink.bytes()))

	if (opened.kind !== "opened") throw new Error(opened.reason)

	await opened.parts.parseAll()

	const page = opened.deck.nodes.get(opened.deck.slides[0] ?? slideRef(0))
	const back = (name: string): ShapeNode | undefined => page?.shapes.find(each => each.name === name)
	const geometryOf = (name: string): string =>
		new RegExp(`<draw:custom-shape [^>]*draw:name="${name}"[\\s\\S]*?(<draw:enhanced-geometry [^>]*>)`, "u").exec(content)?.[1] ?? ""

	return { report: written.report, back, geometryOf }
}

describe("a trapezoid on ODP", () => {
	it("is ODF's trapezoid turned upside down, with its inset on the width, and reads back as written", async () => {
		const { back, geometryOf, report } = await convert([
			shape(50, "Plain", preset("trapezoid")),
			shape(51, "Flipped", preset("trapezoid"), { ...WIDE, flipV: true }),
			shape(52, "Adjusted", preset("trapezoid", ["adj", 40000]))
		])

		// 25000 of the shorter side (half the width) is 2700 of 21600 across.
		expect(geometryOf("Plain")).toContain('draw:type="trapezoid" draw:modifiers="2700" draw:mirror-vertical="true"')
		expect(geometryOf("Flipped")).not.toContain("draw:mirror-vertical")
		expect(geometryOf("Adjusted")).toContain('draw:modifiers="4320" draw:mirror-vertical="true"')
		expect(back("Plain")?.props?.geometry).toEqual(preset("trapezoid"))
		expect(back("Plain")?.xfrm?.flipV).toBe(false)
		expect(back("Flipped")?.xfrm?.flipV).toBe(true)
		expect(back("Adjusted")?.props?.geometry).toEqual(preset("trapezoid", ["adj", 40000]))
		expect(report.approximated).not.toHaveProperty("outline trapezoid")
	})

	it("writes an adjustment ODF's trapezoid cannot hold (out of its range) as the evaluated outline, and reads it back", async () => {
		const { back, geometryOf } = await convert([shape(58, "Negative", preset("trapezoid", ["adj", -25001]))])

		expect(geometryOf("Negative")).toContain('draw:type="ooxml-trapezoid" draw:modifiers="-25001"')
		expect(back("Negative")?.props?.geometry).toEqual(preset("trapezoid", ["adj", -25001]))
	})

	it("reads an ODF trapezoid without a mirror as DrawingML's flipped, its default inset measured on the width", () => {
		expect(presetOfOdfType("trapezoid", [], 200, 100)).toEqual({
			preset: "trapezoid",
			guides: [{ name: "adj", formula: "val 50000" }],
			invertsV: true
		})
		expect(presetOfOdfType("trapezoid", [], 100, 100)).toEqual({ preset: "trapezoid", guides: [], invertsV: true })
	})
})

describe("presets without an ODF type, or adjusted, on ODP", () => {
	it("writes flowChartManualOperation as ODF's manual operation", async () => {
		const { back, geometryOf } = await convert([shape(53, "Manual", preset("flowChartManualOperation"))])

		expect(geometryOf("Manual")).toContain('draw:type="flowchart-manual-operation"')
		expect(back("Manual")?.props?.geometry).toEqual(preset("flowChartManualOperation"))
	})

	it("writes the outline evaluated for the box as ooxml-<preset> and reads back the preset with its adjustments", async () => {
		const shapes = [
			shape(54, "Rounded", preset("roundRect", ["adj", 40000])),
			shape(55, "Pie", preset("pie", ["adj1", 16_200_000], ["adj2", 1_800_000])),
			shape(56, "BentUp", preset("bentUpArrow")),
			shape(57, "Can", preset("can", ["adj", 30000]), { ...WIDE, flipH: true })
		]
		const { back, geometryOf, report } = await convert(shapes)

		expect(geometryOf("Rounded")).toMatch(
			/svg:viewBox="0 0 10000 5000" draw:text-areas="[\d ]+" draw:type="ooxml-roundRect" draw:modifiers="40000"/u
		)
		expect(geometryOf("Pie")).toContain('draw:type="ooxml-pie" draw:modifiers="16200000 1800000"')
		// An unstroked body, an unstroked lid lightened (path fill lighten) and an outline without a fill.
		expect(geometryOf("Can")).toMatch(/draw:mirror-horizontal="true" draw:enhanced-path="S M [^"]* N J S M [^"]* N F M [^"]* N"/u)
		// The rounded rectangle's corner: 40000 of the 5000 short side, so its first line starts 2000 in.
		expect(geometryOf("Rounded")).toContain('draw:enhanced-path="M 0 2000 C')

		for (const each of shapes) {
			expect(back(each.name)?.props?.geometry, each.name).toEqual(each.props?.geometry)
			expect(back(each.name)?.xfrm, each.name).toEqual(each.xfrm)
		}

		expect(Object.keys(report.approximated).filter(what => what.startsWith("outline"))).toEqual([])
	})

	it("starts a line drawn after a close from where the closed figure began, as LibreOffice draws nothing after Z", () => {
		const geometry = odfPresetGeometry("accentCallout1", [], WIDE) ?? ""
		const path = /draw:enhanced-path="([^"]*)"/u.exec(geometry)?.[1] ?? ""

		// The accent bar: moveTo, close, lineTo in ECMA-376.
		expect(path).not.toMatch(/Z L/u)
		expect(path).toMatch(/M (-?\d+) (-?\d+) Z M \1 \2 L/u)
	})

	it("writes a text area with its left above its right and its top above its bottom (pie's rect swaps them)", () => {
		const geometry = odfPresetGeometry("pie", [], WIDE) ?? ""
		const [l, t, r, b] = (/draw:text-areas="([^"]*)"/u.exec(geometry)?.[1] ?? "").split(" ").map(Number)

		expect(l).toBeLessThanOrEqual(r ?? 0)
		expect(t).toBeLessThanOrEqual(b ?? 0)
	})

	it("ignores modifiers that equal the preset's defaults", () => {
		expect(presetOfOdfType("ooxml-roundRect", [16667], 100, 50)).toEqual({ preset: "roundRect", guides: [], invertsV: false })
		expect(presetOfOdfType("ooxml-notAPreset", [1], 100, 50)).toBeUndefined()
	})

	it("refuses no preset the renderer draws", () => {
		expect(odfPresetGeometry("notAPreset", [], WIDE)).toBeUndefined()
		expect(odfPresetGeometry("upArrow", [], WIDE)).toContain('draw:type="ooxml-upArrow"')
	})
})

describe("a preset shape in an ODP moved, resized or turned over", () => {
	const SHAPES =
		'<draw:custom-shape draw:name="Trap" svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="5cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="trapezoid" draw:modifiers="2700" draw:mirror-vertical="true"/></draw:custom-shape>' +
		'<draw:custom-shape draw:name="Hex" svg:x="2cm" svg:y="9cm" svg:width="6cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="hexagon" draw:modifiers="3000" draw:mirror-horizontal="true"/></draw:custom-shape>' +
		'<draw:custom-shape draw:name="Arrow" svg:x="12cm" svg:y="2cm" svg:width="6cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="right-arrow" draw:modifiers="16000 3000"/></draw:custom-shape>' +
		// An outline this writer evaluated, as Save as ODP writes it.
		`<draw:custom-shape draw:name="Rounded" svg:x="12cm" svg:y="9cm" svg:width="6cm" svg:height="3cm">${odfPresetGeometry("roundRect", [{ name: "adj", formula: "val 40000" }], { cx: 2_160_000, cy: 1_080_000, flipH: false, flipV: false }) ?? ""}</draw:custom-shape>`
	const geometry = (content: string, name: string): string =>
		new RegExp(`draw:name="${name}"[\\s\\S]*?(<draw:enhanced-geometry [^>]*>)`, "u").exec(content)?.[1] ?? ""

	it("keeps an ODF type's own modifiers and turns only its mirrors; writes an evaluated outline again; undoes to the source", async () => {
		const source = odpBytes({ body: `<draw:page draw:name="One" draw:master-page-name="M">${SHAPES}</draw:page>` })
		const d = await driveSession(source)
		const slide = d.session.deck.slides[0] as SlideRef
		const shapes = (await odpParts(d.session.deck)?.slide(slide))?.shapes ?? []
		const set = async (name: string, change: Partial<Xfrm>): Promise<void> => {
			const shape = shapes.find(each => each.name === name)

			expect(
				(
					await d.command({
						family: "shape",
						kind: "setXfrm",
						target: { slide, id: shape?.id as number },
						xfrm: { ...(shape?.xfrm as Xfrm), ...change }
					})
				).ok
			).toBe(true)
		}
		const content = async (bytes: Uint8Array | undefined): Promise<string> =>
			text((await entriesOf(bytes as Uint8Array)).get("content.xml"))
		const before = await content(source)

		await set("Trap", { cx: 1_800_000 })
		await set("Arrow", { cx: 3_000_000, cy: 2_000_000 })
		await set("Hex", { flipH: false, flipV: true })
		await set("Rounded", { cx: 3_600_000 })

		const savedOnce = await d.save()

		expect(savedOnce.result.kind).toBe("written")

		const after = await content(savedOnce.bytes)

		expect(geometry(after, "Arrow")).toBe(geometry(before, "Arrow"))
		// Square now: the trapezoid keeps its adjustment (25000 of the side), 5400 of 21600 across.
		expect(geometry(after, "Trap")).toBe(geometry(before, "Trap").replace('draw:modifiers="2700"', 'draw:modifiers="5400"'))
		expect(geometry(after, "Hex")).toBe(
			'<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="hexagon" draw:modifiers="3000" draw:mirror-vertical="true"/>'
		)
		// 40000 of the 3 cm short side: the corner starts 1.2 cm (1200 hundredths of a millimetre) down.
		expect(geometry(after, "Rounded")).toMatch(
			/svg:viewBox="0 0 10000 3000" [^>]*draw:type="ooxml-roundRect" draw:modifiers="40000"[^>]*draw:enhanced-path="M 0 1200 C/u
		)

		for (let k = 0; k < 4; k++) expect((await d.undo()).ok).toBe(true)

		const undone = await content((await d.save()).bytes)

		for (const name of ["Trap", "Hex", "Arrow", "Rounded"]) expect(geometry(undone, name), name).toBe(geometry(before, name))
	})
})

describe("every preset converted from pptx to ODP", () => {
	it("reads back as the preset it was, with its adjustments and flips", { timeout: 60_000 }, async () => {
		// Connectors convert as lines; the rest once plain, once adjusted (angles turned, fractions scaled) and flipped.
		const names = presetNames().filter(name => name !== "line" && !name.includes("Connector"))
		const expected = new Map<string, { readonly geometry: Geometry; readonly flipV: boolean }>()
		let markup = ""

		names.forEach((name, k) => {
			const program = presetProgram(name)

			if (program === undefined) return

			const angles = PRESET_ANGLE_ADJUSTS[name] ?? []
			const guides = program.adjustNames.map((adjust, i): [string, number] => {
				const value = program.adjustDefaults[i] ?? 0

				return [adjust, angles.includes(adjust) ? (value + 1_800_000) % 21_600_000 : Math.round(value * 0.7)]
			})

			for (const [variant, adjusted, flipV] of [
				["plain", false, false],
				["adjusted", true, true]
			] as const) {
				const shapeName = `${variant} ${name}`
				const avLst = adjusted ? guides.map(([adjust, value]) => `<a:gd name="${adjust}" fmla="val ${value}"/>`).join("") : ""

				expected.set(shapeName, {
					geometry: adjusted
						? preset(name, ...guides.filter((_, i) => guides[i]?.[1] !== program.adjustDefaults[i]))
						: preset(name),
					flipV
				})
				markup += sp(
					10 + expected.size,
					shapeName,
					undefined,
					`<a:xfrm${flipV ? ' flipV="1"' : ""}><a:off x="${(k % 8) * 1_450_000}" y="${Math.floor(k / 8) * 300_000}"/><a:ext cx="1300000" cy="${k % 2 === 0 ? 1_000_000 : 700_000}"/></a:xfrm>` +
						`<a:prstGeom prst="${name}"><a:avLst>${avLst}</a:avLst></a:prstGeom>`
				)
			}
		})

		const fresh = await freshFromPptx(buildPptx({ slides: [{ shapes: markup }] }))

		if ("kind" in fresh) throw new Error(fresh.reason)

		const opened = await openOdpDeck(fresh.bytes)
		const page = opened.deck.nodes.get(opened.deck.slides[0] ?? slideRef(0))
		const read = new Map((page?.shapes ?? []).map(each => [each.name, { geometry: each.props?.geometry, flipV: each.xfrm?.flipV }]))

		expect(Object.keys(fresh.report.approximated)).toEqual([])
		expect(read.size).toBe(expected.size)

		for (const [name, value] of expected) expect(read.get(name), name).toEqual(value)
	})
})

describe("a custom outline (a:custGeom) converted from pptx to ODP", () => {
	const style =
		'<a:solidFill><a:srgbClr val="3366CC"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'
	const custom = (id: number, name: string, geometry: string): string =>
		`<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${String(id * 100_000)}" y="500000"/><a:ext cx="2400000" cy="1400000"/></a:xfrm><a:custGeom>${geometry}</a:custGeom>${style}</p:spPr></p:sp>`
	// A filled body in its own 200 × 100 space under an unfilled line in the box's EMU.
	const two =
		'<a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="200" h="100"><a:moveTo><a:pt x="0" y="50"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:lnTo><a:pt x="200" y="50"/></a:lnTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo><a:close/></a:path><a:path fill="none"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="1800000" y="1000000"/></a:lnTo></a:path></a:pathLst>'
	// Guides, an arc and a quadratic, the text rectangle a guide's.
	const arcs =
		'<a:avLst/><a:gdLst><a:gd name="hw" fmla="*/ w 1 2"/><a:gd name="hh" fmla="*/ h 1 2"/></a:gdLst><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="hw" b="hh"/><a:pathLst><a:path><a:moveTo><a:pt x="0" y="hh"/></a:moveTo><a:arcTo wR="hw" hR="hh" stAng="10800000" swAng="10800000"/><a:quadBezTo><a:pt x="hw" y="h"/><a:pt x="0" y="hh"/></a:quadBezTo><a:close/></a:path></a:pathLst>'
	// An unstroked darkened path.
	const shade =
		'<a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="10" h="10" stroke="0" fill="darken"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="0"/></a:lnTo><a:lnTo><a:pt x="10" y="10"/></a:lnTo><a:close/></a:path></a:pathLst>'

	it("writes each path for the box (fill and stroke flags, arcs as curves, guides evaluated) and reads back custom outlines", async () => {
		const fresh = await freshFromPptx(
			buildPptx({ slides: [{ shapes: custom(10, "Two", two) + custom(30, "Arcs", arcs) + custom(50, "Shade", shade) }] })
		)

		if ("kind" in fresh) throw new Error(fresh.reason)

		expect(fresh.report.approximated).toEqual({})

		const content = text((await entriesOf(fresh.bytes)).get("content.xml"))
		const outline = (name: string): string =>
			new RegExp(`draw:name="${name}"[\\s\\S]*?draw:enhanced-path="([^"]*)"`, "u").exec(content)?.[1] ?? ""

		// The body scaled from its 200 × 100 space onto the 6.67 × 3.89 cm box, then the unfilled line (F) in EMU.
		expect(outline("Two")).toBe("M 0 1944 L 3333 0 L 6667 1944 L 3333 3889 Z N F M 0 0 L 5000 2778 N")
		// The arc as cubic curves, the quadratic as itself; the text area the guides' (half the box).
		expect(outline("Arcs")).toMatch(/^M 0 1944 C [\d -]+ C [\d -]+ Q 3333 3889 0 1944 Z N$/u)
		expect(content).toMatch(/draw:name="Arcs"[\s\S]*?draw:text-areas="0 0 3333 1944"/u)
		expect(outline("Shade")).toBe("H S M 0 0 L 6667 0 L 6667 3889 Z N")

		const opened = await openOdpDeck(fresh.bytes)
		const page = opened.deck.nodes.get(opened.deck.slides[0] ?? slideRef(0))
		const geometry = (name: string): Geometry | undefined => page?.shapes.find(shape => shape.name === name)?.props?.geometry

		const twoPaths = geometry("Two")
		const shadePaths = geometry("Shade")

		expect(twoPaths?.kind).toBe("custom")
		expect(twoPaths?.kind === "custom" ? twoPaths.paths.map(path => path.fill) : undefined).toEqual(["norm", "none"])
		expect(shadePaths?.kind === "custom" ? shadePaths.paths[0]?.stroke : undefined).toBe(false)
	})
})
