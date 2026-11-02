import { describe, expect, it } from "vitest"
import { DrawingList, PathCommand } from "../core/drawingml/displayList"
import { compileCustomGeometry } from "../core/drawingml/geometry/custom"
import { emitPaths, evaluateGuides, evaluateOp, presetNames, presetProgram, textRect } from "../core/drawingml/geometry/evaluate"
import { BUILTIN_COUNT, GuideOp, encodeSlot, parseProgram } from "../core/drawingml/geometry/program"
import { PRESET_GEOMETRY } from "../core/drawingml/geometry/presets.generated"
import { drawingReader } from "../core/drawingml/reader"
import { parseXml } from "../core/xml/index"

const EMU = 9525
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

function draw(name: string, w: number, h: number): { list: DrawingList; paths: ReturnType<typeof emitPaths> } {
	const program = presetProgram(name)

	if (program === undefined) throw new Error(`no preset ${name}`)

	const list = new DrawingList()
	const paths = emitPaths(list, program, evaluateGuides(program, w, h), w, h)

	return { list, paths }
}

function bounds(list: DrawingList): number[] {
	list.addItem(0, [1, 0, 0, 1, 0, 0], 0, 0, 0, 0, 0, 0, 0, -1, -1, -1, 0, 0)

	return [...list.bounds()]
}

describe("preset geometry table", () => {
	it("holds every ECMA-376 preset", () => {
		// Every ST_ShapeType value (§20.1.10.56), upArrow included.
		expect(presetNames()).toHaveLength(187)
		expect(presetNames()).toContain("upArrow")
		expect(Object.hasOwn(PRESET_GEOMETRY, "rect")).toBe(true)
		expect(presetProgram("constructor")).toBeUndefined()
		expect(presetProgram("noSuchShape")).toBeUndefined()
	})

	it("evaluates every preset to finite paths at any aspect ratio", () => {
		for (const name of presetNames()) {
			for (const [w, h] of [
				[100 * EMU, 100 * EMU],
				[300 * EMU, 40 * EMU],
				[40 * EMU, 300 * EMU],
				[0, 0]
			] as const) {
				const { list, paths } = draw(name, w, h)

				expect(paths.length, name).toBeGreaterThan(0)

				for (let k = 0; k < list.coordCount; k++) expect(Number.isFinite(list.coords[k]), name).toBe(true)
			}
		}
	})

	it("round-trips slot references", () => {
		const program = parseProgram(`adj 5|v ${encodeSlot(BUILTIN_COUNT)} m ${encodeSlot(6)} ${encodeSlot(BUILTIN_COUNT + 1)} 2||`)
		const slots = evaluateGuides(program, 10, 20)

		expect(slots[BUILTIN_COUNT + 1]).toBe(5)
		expect(slots[BUILTIN_COUNT + 2]).toBe(25)

		for (const index of [0, 51, 52, 53, 300, 3275, 3276, 5000]) {
			const encoded = encodeSlot(index)
			const parsed = parseProgram(`|v ${encoded}||`)

			expect(parsed.guides[1], `${index} ${encoded}`).toBe(index)
		}
	})
})

describe("geometry evaluation", () => {
	it("draws a rectangle as four sides", () => {
		const { list, paths } = draw("rect", 200 * EMU, 100 * EMU)

		expect(paths).toHaveLength(1)
		expect([...list.commands.subarray(0, list.commandCount)]).toEqual([
			PathCommand.MOVE,
			PathCommand.LINE,
			PathCommand.LINE,
			PathCommand.LINE,
			PathCommand.CLOSE
		])
		expect([...list.coords.subarray(0, list.coordCount)]).toEqual([0, 0, 200, 0, 200, 100, 0, 100])
		expect(paths[0]?.open).toBe(false)
	})

	it("bounds an ellipse exactly", () => {
		const { list } = draw("ellipse", 200 * EMU, 100 * EMU)
		const box = bounds(list)

		expect(box[0]).toBeCloseTo(0, 3)
		expect(box[1]).toBeCloseTo(0, 3)
		expect(box[2]).toBeCloseTo(200, 3)
		expect(box[3]).toBeCloseTo(100, 3)
	})

	it("measures arc angles as visual angles", () => {
		// A pie from 0 to 90 degrees on a 2:1 ellipse ends straight below the centre.
		const program = presetProgram("pie")

		if (program === undefined) throw new Error("pie")

		const w = 200 * EMU
		const h = 100 * EMU
		const slots = evaluateGuides(program, w, h, name => (name === "adj1" ? 0 : name === "adj2" ? 5400000 : undefined))
		const list = new DrawingList()

		emitPaths(list, program, slots, w, h)

		// moveTo the right end, arc, lnTo the centre.
		expect(list.coords[0]).toBeCloseTo(200, 3)
		expect(list.coords[1]).toBeCloseTo(50, 3)

		const arcEnd = list.coordCount - 4

		expect(list.coords[arcEnd]).toBeCloseTo(100, 3)
		expect(list.coords[arcEnd + 1]).toBeCloseTo(100, 3)
	})

	it("applies adjust overrides", () => {
		const program = presetProgram("roundRect")

		if (program === undefined) throw new Error("roundRect")

		const w = 100 * EMU
		const sharp = evaluateGuides(program, w, w, () => 0)
		const list = new DrawingList()

		emitPaths(list, program, sharp, w, w)
		expect([...list.commands.subarray(0, list.commandCount)].filter(command => command === PathCommand.CUBIC)).toHaveLength(0)
	})

	it("implements the guide operators", () => {
		expect(evaluateOp(GuideOp.MUL_DIV, 6, 4, 3)).toBe(8)
		expect(evaluateOp(GuideOp.MUL_DIV, 6, 4, 0)).toBe(0)
		expect(evaluateOp(GuideOp.ADD_SUB, 6, 4, 3)).toBe(7)
		expect(evaluateOp(GuideOp.ADD_DIV, 6, 4, 2)).toBe(5)
		expect(evaluateOp(GuideOp.IF_ELSE, 0, 1, 2)).toBe(2)
		expect(evaluateOp(GuideOp.IF_ELSE, 1, 1, 2)).toBe(1)
		expect(evaluateOp(GuideOp.AT2, 1, 1, 0)).toBeCloseTo(2700000, 3)
		expect(evaluateOp(GuideOp.COS, 10, 5400000, 0)).toBeCloseTo(0, 6)
		expect(evaluateOp(GuideOp.SIN, 10, 5400000, 0)).toBeCloseTo(10, 6)
		expect(evaluateOp(GuideOp.CAT2, 10, 1, 0)).toBeCloseTo(10, 6)
		expect(evaluateOp(GuideOp.SAT2, 10, 0, 1)).toBeCloseTo(10, 6)
		expect(evaluateOp(GuideOp.MOD, 3, 4, 0)).toBe(5)
		expect(evaluateOp(GuideOp.PIN, 0, 5, 3)).toBe(3)
		expect(evaluateOp(GuideOp.PIN, 0, -1, 3)).toBe(0)
		expect(evaluateOp(GuideOp.SQRT, -4, 0, 0)).toBe(0)
		expect(evaluateOp(GuideOp.TAN, 2, 2700000, 0)).toBeCloseTo(2, 6)
	})

	it("returns the text rectangle in px", () => {
		const program = presetProgram("ellipse")

		if (program === undefined) throw new Error("ellipse")

		const w = 200 * EMU
		const rect = textRect(program, evaluateGuides(program, w, w), w, w)

		expect(rect[0]).toBeGreaterThan(0)
		expect(rect[2]).toBeLessThan(200)
	})
})

describe("custom geometry", () => {
	it("compiles a:custGeom with guides, path spaces and every command", () => {
		const document = parseXml(
			new TextEncoder().encode(`<a:custGeom ${A}>
				<a:avLst/>
				<a:gdLst><a:gd name="half" fmla="*/ w 1 2"/></a:gdLst>
				<a:rect l="0" t="0" r="half" b="b"/>
				<a:pathLst>
					<a:path w="10" h="10"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="0"/></a:lnTo><a:quadBezTo><a:pt x="10" y="10"/><a:pt x="0" y="10"/></a:quadBezTo><a:close/></a:path>
					<a:path fill="none" stroke="0"><a:moveTo><a:pt x="half" y="0"/></a:moveTo><a:cubicBezTo><a:pt x="0" y="0"/><a:pt x="0" y="0"/><a:pt x="0" y="0"/></a:cubicBezTo><a:arcTo wR="10" hR="10" stAng="0" swAng="5400000"/></a:path>
				</a:pathLst>
			</a:custGeom>`)
		)
		const program = compileCustomGeometry(drawingReader(document), document.documentElement())
		const list = new DrawingList()
		const w = 100 * EMU
		const paths = emitPaths(list, program, evaluateGuides(program, w, w), w, w)

		expect(paths).toHaveLength(2)
		expect(paths[0]?.fill).toBe(0)
		expect(paths[1]?.fill).toBe(1)
		expect(paths[1]?.stroke).toBe(false)
		// Path space 10x10 scales to the 100 px shape.
		expect(list.coords[2]).toBe(100)
		// The second path starts at the "half" guide in shape space.
		expect(list.coords[paths[1]?.firstCoord ?? 0]).toBe(50)
		expect(textRect(program, evaluateGuides(program, w, w), w, w)).toEqual([0, 0, 50, 100])
	})

	it("reads unknown guide names and broken formulas as zero", () => {
		const document = parseXml(
			new TextEncoder()
				.encode(`<a:custGeom ${A}><a:gdLst><a:gd name="x" fmla="bogus 1 2"/><a:gd name="y" fmla="+- nope 5 0"/></a:gdLst>
				<a:pathLst><a:path><a:moveTo><a:pt x="y" y="x"/></a:moveTo><a:lnTo><a:pt x="1" y="1"/></a:lnTo></a:path></a:pathLst></a:custGeom>`)
		)
		const program = compileCustomGeometry(drawingReader(document), document.documentElement())
		const list = new DrawingList()

		emitPaths(list, program, evaluateGuides(program, EMU, EMU), EMU, EMU)
		expect(list.coords[0]).toBeCloseTo(5 / EMU, 9)
	})
})

describe("an arc in a path with its own coordinate space", () => {
	it("measures its angles on the arc the path draws, then scales the arc to the shape", () => {
		// A quarter-sized circle of radius 50 in a 100 x 100 path, swept 45 degrees from its rightmost point, drawn
		// on a 200 x 100 px shape: the path's circle becomes an ellipse whose point is the scaled circle's.
		const program = parseProgram("|||P 0 100 100 M 100 50 A 50 50 0 2700000")
		const list = new DrawingList()

		emitPaths(list, program, evaluateGuides(program, 200 * EMU, 100 * EMU), 200 * EMU, 100 * EMU)

		const end = Math.SQRT1_2 * 50

		expect(list.coords[list.coordCount - 2]).toBeCloseTo((50 + end) * 2, 3)
		expect(list.coords[list.coordCount - 1]).toBeCloseTo(50 + end, 3)
	})
})

describe("upArrow, which ECMA-376's definitions leave out", () => {
	it("draws as downArrow upside down, its text rectangle turned with it", () => {
		const w = 120 * EMU
		const h = 200 * EMU
		const up = draw("upArrow", w, h)
		const down = draw("downArrow", w, h)
		const upPoints = Array.from(up.list.coords.subarray(0, up.list.coordCount))
		const downPoints = Array.from(down.list.coords.subarray(0, down.list.coordCount))

		expect(upPoints.length).toBe(downPoints.length)
		upPoints.forEach((value, k) => expect(value).toBeCloseTo(k % 2 === 0 ? (downPoints[k] ?? 0) : 200 - (downPoints[k] ?? 0), 4))

		const upProgram = presetProgram("upArrow")
		const downProgram = presetProgram("downArrow")

		if (upProgram === undefined || downProgram === undefined) throw new Error("missing preset")

		const [l, t, r, b] = textRect(upProgram, evaluateGuides(upProgram, w, h), w, h)
		const [dl, dt, dr, db] = textRect(downProgram, evaluateGuides(downProgram, w, h), w, h)

		expect([l, t, r, b].map(v => Math.round(v * 1000))).toEqual([dl, 200 - db, dr, 200 - dt].map(v => Math.round(v * 1000)))
	})
})
