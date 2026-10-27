import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { pointText } from "../core/smartart/data"
import { encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { relayoutDiagram } from "../dom/presentation/engine/smartart"
import { CORPUS_DIR } from "./corpusDir"
import { adapterMeasurers, data, layout, model, MM, type PointSpec } from "./smartartFixtures"
import { budget, cpuMs } from "./timing"

// A whole SmartArt relayout (plan §1.12 smartartPerf: 30 nodes within 60 ms of worker CPU): the data part parsed,
// the layout expanded and laid out with text fitted through the slide text adapter, the drawing emitted and read
// back as model shapes. On our own cycle and hierarchy definitions, and on a connector-routed snake as PowerPoint
// embeds it.

function flat(count: number): PointSpec[] {
	return Array.from({ length: count }, (_, i) => ({ id: `n${i}`, text: `Step ${i + 1} of the process` }))
}

function tree(count: number): PointSpec[] {
	const out: PointSpec[] = [{ id: "r", text: "Board" }]

	for (let i = 1; i < count; i++) out.push({ id: `n${i}`, text: `Team ${i}`, parent: i <= 5 ? "r" : `n${1 + ((i - 6) % 5)}` })

	return out
}

const CYCLE = layout(`<dgm:alg type="cycle"/><dgm:constrLst>
	<dgm:constr type="w" for="ch" forName="node" val="20"/><dgm:constr type="h" for="ch" forName="node" val="12"/>
	<dgm:constr type="primFontSz" for="ch" forName="node" val="65"/><dgm:constr type="sibSp" refType="w" refFor="ch" refForName="node" fact="0.1"/></dgm:constrLst>
	<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="node"><dgm:alg type="tx"/><dgm:shape type="roundRect"/><dgm:presOf axis="self"/>
	<dgm:constrLst><dgm:constr type="lMarg" refType="primFontSz" fact="0.1"/></dgm:constrLst><dgm:ruleLst><dgm:rule type="primFontSz" val="5"/></dgm:ruleLst></dgm:layoutNode>
	<dgm:forEach axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="arrow"><dgm:alg type="conn"/><dgm:shape type="conn"/>
	<dgm:constrLst><dgm:constr type="h" val="4"/></dgm:constrLst></dgm:layoutNode></dgm:forEach></dgm:forEach>`)

const HIERARCHY = layout(`<dgm:alg type="hierRoot"/><dgm:constrLst>
	<dgm:constr type="w" for="des" forName="box" val="25"/><dgm:constr type="h" for="des" forName="box" val="10"/><dgm:constr type="primFontSz" for="des" forName="box" val="65"/>
	<dgm:constr type="sp" for="des" forName="tree" val="8"/><dgm:constr type="sibSp" for="des" forName="kids" val="4"/></dgm:constrLst>
	<dgm:forEach axis="ch" ptType="node" cnt="1"><dgm:layoutNode name="tree"><dgm:alg type="hierRoot"/>
	<dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/><dgm:ruleLst><dgm:rule type="primFontSz" val="5"/></dgm:ruleLst></dgm:layoutNode>
	<dgm:layoutNode name="kids"><dgm:alg type="hierChild"/><dgm:forEach name="sub" axis="ch" ptType="node"><dgm:layoutNode name="tree"><dgm:alg type="hierRoot"/>
	<dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/><dgm:ruleLst><dgm:rule type="primFontSz" val="5"/></dgm:ruleLst></dgm:layoutNode>
	<dgm:layoutNode name="kids"><dgm:alg type="hierChild"/><dgm:forEach axis="ch" ptType="node" ref="sub"/></dgm:layoutNode></dgm:layoutNode></dgm:forEach></dgm:layoutNode>
	</dgm:layoutNode></dgm:forEach>`)

const SNAKE = { file: "pptx/govuk__Workshop_in_a_box_slides_standard.pptx", part: "ppt/diagrams/layout1.xml" }
// A vertical box list (list1): every child text's height follows the parent text's font size, so a font rule relaxes
// the whole column.
const LIST = { file: "pptx/lo__smartart-vertical-box-list.pptx", part: "ppt/diagrams/layout1.xml" }

function xml(markup: string): XmlDocument {
	return parseXml(encodeUtf8(markup))
}

async function corpusDef(source: { readonly file: string; readonly part: string }): Promise<string | undefined> {
	const path = join(CORPUS_DIR, source.file)

	if (!existsSync(path)) return undefined

	const pkg = await OpcPackage.open(bytesSource(readFileSync(path)))

	return new TextDecoder().decode(await pkg.read(source.part))
}

const snakeDef = (): Promise<string | undefined> => corpusDef(SNAKE)

const CASES: readonly {
	readonly name: string
	readonly layout: () => Promise<string | undefined>
	readonly nodes: readonly PointSpec[]
	readonly shapes: number
}[] = [
	{ name: "cycle", layout: () => Promise.resolve(CYCLE), nodes: flat(30), shapes: 59 },
	{ name: "hierarchy", layout: () => Promise.resolve(HIERARCHY), nodes: tree(30), shapes: 30 },
	{ name: "bProcess3", layout: snakeDef, nodes: flat(30), shapes: 59 },
	{ name: "list1", layout: () => corpusDef(LIST), nodes: flat(30), shapes: 60 }
]

describe("SmartArt relayout performance", () => {
	it.for(CASES)(
		"relays $name with 30 nodes out within 60 ms of CPU",
		{ timeout: 60_000 },
		async ({ name, layout: definition, nodes, shapes }, { task }) => {
			const layoutXml = await definition()

			if (layoutXml === undefined) return

			const dataXml = data(nodes)
			const texts = [...model(dataXml).points.values()].map(pointText).filter(text => text !== "")
			const measurers = await adapterMeasurers(texts)
			const box = { w: 230 * MM, h: 130 * MM }
			const run = (): number =>
				relayoutDiagram({ data: xml(dataXml), layout: xml(layoutXml), style: undefined, colors: undefined }, box, () => measurers())
					.shapes.length
			let best = Number.POSITIVE_INFINITY

			// The faces' advances are warm; every run parses, lays out with a fresh measurer and emits. The best of 5.
			run()

			for (let attempt = 0; attempt < 5; attempt++) {
				const start = cpuMs()
				const count = run()

				best = Math.min(best, cpuMs() - start)
				expect(count, name).toBe(shapes)
			}

			Object.assign(task.meta, { perf: { [`${name}RelayoutCpuMs`]: { value: best, budget: 60 } } })
			expect(best, name).toBeLessThanOrEqual(budget(60))
		}
	)
})

describe("SmartArt relayout of a long list", () => {
	it("draws a 300-node vertical box list rather than refusing it", { timeout: 120_000 }, async () => {
		const layoutXml = await corpusDef(LIST)

		if (layoutXml === undefined) return

		const dataXml = data(flat(300))
		const texts = [...model(dataXml).points.values()].map(pointText).filter(text => text !== "")
		const measurers = await adapterMeasurers(texts)
		const start = cpuMs()
		const shapes = relayoutDiagram(
			{ data: xml(dataXml), layout: xml(layoutXml), style: undefined, colors: undefined },
			{ w: 230 * MM, h: 130 * MM },
			() => measurers()
		).shapes.length

		expect(shapes).toBe(600)
		expect(cpuMs() - start).toBeLessThanOrEqual(budget(1000))
	})
})
