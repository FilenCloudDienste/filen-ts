import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { pointText } from "../core/smartart/data"
import { editDiagramData, type DiagramEdit } from "../core/smartart/edit"
import { encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { relayoutDiagram } from "../dom/presentation/engine/smartart"
import { adapterMeasurers, data, model, MM, type PointSpec } from "./smartartFixtures"
import { budget, cpuMs } from "./timing"

// An edit of a 30-node diagram and its relayout (smartartPerf: within 60 ms of worker CPU): the data part edited
// (byte splices over the part), parsed, laid out with text fitted through the slide text adapter, styled and emitted.

const ASSETS = join(import.meta.dirname, "fixtures", "smartart")
const asset = (file: string): XmlDocument => parseXml(encodeUtf8(readFileSync(join(ASSETS, file), "utf8")))

function outline(count: number): PointSpec[] {
	const out: PointSpec[] = []

	for (let i = 0; i < count; i++)
		out.push({ id: `n${i}`, text: `Item ${i + 1} of the plan`, parent: i % 3 === 0 ? undefined : `n${i - (i % 3)}` })

	return out
}

const EDITS: readonly { readonly name: string; readonly edit: DiagramEdit }[] = [
	{ name: "setNodeText", edit: { kind: "setNodeText", node: "n4", text: "Retyped item text" } },
	{ name: "addNode", edit: { kind: "addNode", relativeTo: "n6", position: "after", text: "A new item" } },
	{ name: "demote", edit: { kind: "demote", node: "n9" } },
	{ name: "removeNode", edit: { kind: "removeNode", node: "n12" } }
]

describe("SmartArt edit performance", () => {
	it.for(EDITS)(
		"edits a 30-node diagram ($name) and relays it out within 60 ms of CPU",
		{ timeout: 60_000 },
		async ({ name, edit }, { task }) => {
			const dataXml = data(outline(30))
			const texts = [...model(dataXml).points.values()].map(pointText).filter(text => text !== "")
			const measurers = await adapterMeasurers([...texts, "Retyped item text", "A new item"])
			const layout = asset("test-row.xml")
			const style = asset("test-style-flat.xml")
			const colors = asset("test-colors-accent.xml")
			const source = parseXml(encodeUtf8(dataXml))
			const run = (): number => {
				const result = editDiagramData(source, edit)

				if (result.kind !== "edited") throw new Error(`${name}: ${JSON.stringify(result)}`)

				return relayoutDiagram({ data: parseXml(result.bytes), layout, style, colors }, { w: 230 * MM, h: 130 * MM }, () =>
					measurers()
				).shapes.length
			}
			let best = Number.POSITIVE_INFINITY

			// Warm faces; then the best of 5, each editing and laying out from scratch.
			run()

			for (let attempt = 0; attempt < 5; attempt++) {
				const start = cpuMs()

				expect(run(), name).toBeGreaterThan(0)
				best = Math.min(best, cpuMs() - start)
			}

			Object.assign(task.meta, { perf: { [`smartartEdit${name}CpuMs`]: { value: best, budget: 60 } } })
			expect(best, name).toBeLessThanOrEqual(budget(60))
		}
	)
})
