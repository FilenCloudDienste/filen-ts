import { describe, expect, it } from "vitest"
import { parseDataModel, SmartArtError } from "../core/smartart/data"
import { emitDiagram } from "../core/smartart/emit"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { budget, cpuMs } from "./timing"
import { data, layout, MM, run } from "./smartartFixtures"

// Hostile data models and layout definitions: cycles through transition ids, expansion work that creates no layout
// nodes, and non-finite numbers either lay out in bounded work or refuse with a typed SmartArtError.

const DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"

function dataModel(points: string, cxns: string): ReturnType<typeof parseDataModel> {
	return parseDataModel(
		parseXml(
			encodeUtf8(`<dgm:dataModel xmlns:dgm="${DGM}"><dgm:ptLst>${points}</dgm:ptLst><dgm:cxnLst>${cxns}</dgm:cxnLst></dgm:dataModel>`)
		)
	)
}

function depthOf(model: ReturnType<typeof parseDataModel>): number {
	let max = 0

	for (const point of model.points.values()) max = Math.max(max, point.depth)

	return max
}

describe("SmartArt data model cycles", () => {
	it.each([
		["the doc point as a parent transition", 'parTransId="doc"'],
		["the doc point as a sibling transition", 'sibTransId="doc"'],
		["the parent itself as a transition", 'parTransId="a"']
	])("never attaches %s: the tree stays a tree", (_name, attribute) => {
		const model = dataModel(
			'<dgm:pt modelId="doc" type="doc"/><dgm:pt modelId="a"/><dgm:pt modelId="b"/>',
			`<dgm:cxn modelId="c1" srcId="doc" destId="a" srcOrd="0" destOrd="0"/><dgm:cxn modelId="c2" srcId="a" destId="b" srcOrd="0" destOrd="0" ${attribute}/>`
		)

		expect(model.root.parent).toBeUndefined()
		expect(depthOf(model)).toBe(2)
		expect(model.points.get("b")?.parent?.id).toBe("a")
	})

	it("never attaches an ancestor of the parent as its transition", () => {
		const model = dataModel(
			'<dgm:pt modelId="doc" type="doc"/><dgm:pt modelId="a"/><dgm:pt modelId="b"/><dgm:pt modelId="c"/>',
			'<dgm:cxn modelId="c1" srcId="doc" destId="a" srcOrd="0" destOrd="0"/><dgm:cxn modelId="c2" srcId="a" destId="b" srcOrd="0" destOrd="0"/>' +
				'<dgm:cxn modelId="c3" srcId="b" destId="c" srcOrd="0" destOrd="0" parTransId="a" sibTransId="b"/>'
		)

		expect(model.points.get("a")?.parent?.id).toBe("doc")
		expect(depthOf(model)).toBe(3)
	})

	it("lays out a diagram over such a model in bounded work", () => {
		const xml = `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst><dgm:pt modelId="doc" type="doc"/><dgm:pt modelId="a"><dgm:t><a:bodyPr/><a:p><a:r><a:t>A</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst><dgm:cxnLst><dgm:cxn modelId="c" srcId="doc" destId="a" srcOrd="0" destOrd="0" parTransId="doc" sibTransId="doc"/></dgm:cxnLst></dgm:dataModel>`
		const result = run(
			xml,
			layout(
				'<dgm:alg type="lin"/><dgm:forEach axis="des" ptType="all"><dgm:layoutNode name="x"><dgm:alg type="sp"/></dgm:layoutNode></dgm:forEach>'
			),
			MM,
			MM
		)

		expect(result.root.children).toHaveLength(1)
	})
})

describe("SmartArt expansion work", () => {
	const points = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `n${String(i)}`, text: `N${String(i)}` }))

	it("bounds nested forEach over every point that create no layout nodes, or refuses them typed", () => {
		const body =
			'<dgm:forEach name="f" axis="root des" ptType="all all"><dgm:forEach name="g" axis="root des" ptType="all all"><dgm:constrLst><dgm:constr type="w" val="1"/></dgm:constrLst></dgm:forEach></dgm:forEach>'

		for (const count of [60, 400]) {
			const start = cpuMs()

			try {
				run(data(points(count)), layout(body), MM, MM)
			} catch (error) {
				expect(error).toBeInstanceOf(SmartArtError)
				expect((error as SmartArtError).reason).toBe("tooLarge")
			}

			expect(cpuMs() - start).toBeLessThan(budget(200))
		}
	})

	it("bounds three nested empty forEach and cnt tests over the whole tree", () => {
		const nested =
			'<dgm:forEach axis="root des" ptType="all all"><dgm:forEach axis="root des" ptType="all all"><dgm:forEach axis="root des" ptType="all all"/></dgm:forEach></dgm:forEach>'
		const counted =
			'<dgm:forEach axis="des" ptType="all"><dgm:choose><dgm:if axis="root des desOrSelf" ptType="all all all" func="cnt" op="gte" val="1"><dgm:constrLst><dgm:constr type="w" val="1"/></dgm:constrLst></dgm:if></dgm:choose></dgm:forEach>'

		for (const body of [nested, counted]) {
			const start = cpuMs()

			try {
				run(data(points(300)), layout(body), MM, MM)
			} catch (error) {
				expect((error as SmartArtError).reason).toBe("tooLarge")
			}

			expect(cpuMs() - start).toBeLessThan(budget(300))
		}
	})
})

describe("SmartArt non-finite numbers", () => {
	it.each(["INF", "NaN"])("writes no rotation for a layout shape whose rot is %s", rot => {
		const result = run(
			data([{ id: "a", text: "A" }]),
			layout(
				`<dgm:alg type="lin"/><dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="x"><dgm:alg type="tx"/><dgm:shape type="rect" rot="${rot}"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach>`
			),
			50 * MM,
			50 * MM
		)
		const xml = emitDiagram(result).drawingXml

		expect(xml).not.toMatch(/rot="[^"]*[^0-9-"][^"]*"/u)
		expect(result.shapes.every(shape => Number.isFinite(shape.rot))).toBe(true)
	})
})
