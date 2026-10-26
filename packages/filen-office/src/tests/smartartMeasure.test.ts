import { describe, expect, it } from "vitest"
import { adapterMeasurer, data, layout, MM, run } from "./smartartFixtures"

// The tx algorithm's measurer over the slide text adapter (core/presentation/text layoutBody) on the bundled faces.

const PT = 12700

describe("SmartArt text measurement through the slide text adapter", () => {
	it("wraps at the width and grows the height by whole lines", async () => {
		const text = "alpha beta gamma delta epsilon"
		const measurer = await adapterMeasurer([text])
		const wide = measurer.measure(text, 20, 400 * MM)
		const narrow = measurer.measure(text, 20, 30 * MM)

		expect(wide.height).toBeGreaterThan(20 * PT)
		expect(wide.height).toBeLessThan(30 * PT)
		expect(narrow.height).toBeGreaterThanOrEqual(2.5 * wide.height)
		expect(narrow.width).toBeLessThanOrEqual(30 * MM)
	})

	it("reports a word wider than the box as wider, so the tx algorithm shrinks the font", async () => {
		const measurer = await adapterMeasurer(["Supercalifragilistic"])
		const result = measurer.measure("Supercalifragilistic", 40, 20 * MM)

		expect(result.width).toBeGreaterThan(20 * MM)
	})

	it("scales advances with the font size", async () => {
		const measurer = await adapterMeasurer(["Linear"])
		const small = measurer.measure("Linear", 10, 1000 * MM).width
		const large = measurer.measure("Linear", 40, 1000 * MM).width

		expect(large / small).toBeCloseTo(4, 1)
	})

	it("fits a node's font size to its box with real advances", async () => {
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="t" val="40"/>
			<dgm:constr type="h" for="ch" forName="t" val="20"/><dgm:constr type="primFontSz" for="ch" forName="t" val="65"/></dgm:constrLst>
			<dgm:layoutNode name="t"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="ch" ptType="node" cnt="1"/>
			<dgm:ruleLst><dgm:rule type="primFontSz" val="5"/></dgm:ruleLst></dgm:layoutNode>`)
		const text = "Quarterly results"
		const measurer = await adapterMeasurer([text])
		const font = run(data([{ id: "n", text }]), xml, 100 * MM, 100 * MM, {}, measurer).shapes[0]?.fontPt ?? 0
		const fits = (pt: number) => {
			const size = measurer.measure(text, pt, 40 * MM)

			return size.width <= 40 * MM && size.height <= 20 * MM
		}

		expect(fits(font)).toBe(true)
		expect(fits(font + 0.5)).toBe(false)
		expect(font * 2).toBe(Math.round(font * 2))
	})
})
