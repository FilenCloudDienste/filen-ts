import { describe, expect, it } from "vitest"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { Changes, openDeck, partsOf, save, text } from "./pptxWriteFixtures"

// A layout whose root is rewritten (its master graphics hidden) writes its type once: the model's, the source's left out.

describe("layout root attributes", () => {
	it("writes a rewritten layout root's type exactly once", async () => {
		const opened = await openDeck(buildPptx({ slides: [{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("T"))) }] }))
		const layout = [...opened.deck.nodes.values()].find(node => node.kind === "layout")

		if (layout === undefined) throw new Error("no layout")

		layout.showMasterShapes = false
		layout.revision++

		const { outcome, bytes } = await save(opened, new Changes().slide(layout.part, { kind: "node" }).build())

		expect(outcome.kind).toBe("written")

		const markup = text((await partsOf(bytes)).get(layout.part.slice(1)))
		const root = /<p:sldLayout\b[^>]*>/u.exec(markup)?.[0] ?? ""

		expect(root).toContain('showMasterSp="0"')
		expect(root.match(/ type="/gu)).toEqual([' type="'])
	})
})
