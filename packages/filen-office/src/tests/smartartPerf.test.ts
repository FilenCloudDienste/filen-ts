import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { pointText } from "../core/smartart/data"
import { layoutDiagram } from "../core/smartart/interp"
import { parseLayoutDef, type LayoutDefinition } from "../core/smartart/layoutDef"
import { CORPUS_DIR } from "./corpusDir"
import { adapterMeasurers, data, model, MM, type PointSpec } from "./smartartFixtures"
import { budget, cpuMs } from "./timing"

// The interpretation share of a SmartArt relayout (plan §1.12 smartartPerf: 30 nodes, ≤ 30 ms of the 60 ms relayout
// budget): expansion, constraints, algorithms, rules and text fitting through the slide text adapter, on layout
// definitions as PowerPoint embeds them in corpus decks.

// shapes: what the layout draws for those nodes (hList1 draws one header and one text body per heading).
const LAYOUTS: readonly {
	readonly name: string
	readonly file: string
	readonly part: string
	readonly nodes: readonly PointSpec[]
	readonly shapes: number
}[] = [
	{ name: "default", file: "pptx/tika__testPPT_various2.pptx", part: "ppt/diagrams/layout1.xml", nodes: flat(30), shapes: 30 },
	{
		name: "bProcess3",
		file: "pptx/govuk__Workshop_in_a_box_slides_standard.pptx",
		part: "ppt/diagrams/layout1.xml",
		nodes: flat(30),
		shapes: 30
	},
	{ name: "hList1", file: "pptx/poi__customGeo.pptx", part: "ppt/diagrams/layout10.xml", nodes: twoLevels(10, 2), shapes: 20 }
]

function flat(count: number): PointSpec[] {
	return Array.from({ length: count }, (_, i) => ({ id: `n${i}`, text: `Step ${i + 1} of the process` }))
}

function twoLevels(parents: number, children: number): PointSpec[] {
	const out: PointSpec[] = []

	for (let p = 0; p < parents; p++) {
		out.push({ id: `p${p}`, text: `Heading ${p + 1}` })

		for (let c = 0; c < children; c++) out.push({ id: `p${p}c${c}`, text: `Detail ${c + 1} under heading ${p + 1}`, parent: `p${p}` })
	}

	return out
}

async function layoutDef(file: string, part: string): Promise<LayoutDefinition> {
	const pkg = await OpcPackage.open(bytesSource(readFileSync(join(CORPUS_DIR, file))))

	return parseLayoutDef(await pkg.xml(part))
}

const fetched = LAYOUTS.every(l => existsSync(join(CORPUS_DIR, l.file)))

describe.skipIf(!fetched)("SmartArt interpretation performance", () => {
	it.each(LAYOUTS)(
		"lays out $name with 30 nodes within 30 ms of CPU",
		{ timeout: 60_000 },
		async ({ name, file, part, nodes, shapes }) => {
			const def = await layoutDef(file, part)
			const diagram = model(data(nodes))
			const texts = [...diagram.points.values()].map(pointText).filter(text => text !== "")
			const measurers = await adapterMeasurers(texts)
			const box = { x: 0, y: 0, w: 230 * MM, h: 130 * MM }
			let best = Number.POSITIVE_INFINITY

			// The session's glyph advances are warm (an earlier layout measured these faces); each run starts with a
			// fresh measurer, so no fitting answer is reused. The best of 5.
			layoutDiagram(diagram, def, undefined, undefined, box, measurers())

			for (let run = 0; run < 5; run++) {
				const text = measurers()
				const start = cpuMs()
				const result = layoutDiagram(diagram, def, undefined, undefined, box, text)

				best = Math.min(best, cpuMs() - start)
				expect(result.shapes.length, name).toBe(shapes)
			}

			process.stdout.write(`smartart ${name}: ${best.toFixed(2)} ms\n`)
			expect(best, name).toBeLessThanOrEqual(budget(30))
		}
	)
})
