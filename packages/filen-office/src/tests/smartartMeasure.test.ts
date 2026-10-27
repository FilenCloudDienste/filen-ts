import { describe, expect, it } from "vitest"
import { measureText } from "../core/smartart/measure"
import { adapterMeasurer, data, layout, MM, model, NO_MARGINS, run } from "./smartartFixtures"

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
			<dgm:layoutNode name="t"><dgm:alg type="tx"/>${NO_MARGINS}<dgm:shape type="rect"/><dgm:presOf axis="ch" ptType="node" cnt="1"/>
			<dgm:ruleLst><dgm:rule type="primFontSz" val="5"/></dgm:ruleLst></dgm:layoutNode>`)
		const text = "Quarterly results"
		const measurer = await adapterMeasurer([text])
		const shape = run(data([{ id: "n", text }]), xml, 100 * MM, 100 * MM, {}, measurer).shapes[0]
		const font = shape?.fontPt ?? 0
		const fits = (pt: number) => {
			const size = measurer.measureText?.(measureText(shape?.text ?? [], false), pt, pt, 40 * MM) ?? {
				width: Infinity,
				height: Infinity
			}

			return size.width <= 40 * MM && size.height <= 20 * MM
		}

		expect(fits(font)).toBe(true)
		expect(fits(font + 0.5)).toBe(false)
		expect(font * 2).toBe(Math.round(font * 2))
	})

	it("measures a node's text as the drawing sets it: bold runs wider, lines at 90% with 35% after a node's paragraph", async () => {
		const plain = model(data([{ id: "n", text: "Quarterly results" }])).points.get("n")
		const bold = model(data([{ id: "n", text: "Quarterly results" }]).replace("<a:r><a:t>", '<a:r><a:rPr b="1"/><a:t>')).points.get("n")
		const two = model(data([{ id: "n", text: "One</a:t></a:r></a:p><a:p><a:r><a:t>Two" }])).points.get("n")
		const measurer = await adapterMeasurer(["Quarterly results"], true)

		if (plain === undefined || bold === undefined || two === undefined || measurer.measureText === undefined) throw new Error("fixture")

		expect(bold.rich?.[0]?.runs[0]?.b).toBe(true)
		expect(plain.rich).toBeUndefined()

		const regular = measurer.measureText(measureText([plain], false), 20, 20, 1000 * MM)
		const heavy = measurer.measureText(measureText([bold], false), 20, 20, 1000 * MM)

		expect(heavy.width).toBeGreaterThan(regular.width * 1.01)
		expect(regular.height / PT).toBeCloseTo(20 * 1.2 * 0.9, 1)
		// Two paragraphs: two 90% lines and the 35% space after the first (none after the last).
		expect(measurer.measureText(measureText([two], false), 20, 20, 1000 * MM).height / PT).toBeCloseTo(20 * (2 * 1.2 * 0.9 + 0.35), 1)
	})
})

describe("SmartArt measured text levels", () => {
	it("levels text from the presenting node's own point: its children's text is level 1, bulleted", () => {
		const points = [
			...model(
				data([
					{ id: "p", text: "Parent" },
					{ id: "a", parent: "p", text: "A" },
					{ id: "b", parent: "p", text: "B" }
				])
			).points.values()
		]
		const children = points.filter(point => point.id === "a" || point.id === "b")
		const parent = points.find(point => point.id === "p")
		const text = measureText(children, true, parent?.depth)

		expect(text.paragraphs.map(p => [p.level, p.bullet])).toEqual([
			[1, true],
			[1, true]
		])
		expect(measureText(children, true).paragraphs.map(p => p.level)).toEqual([0, 1])
	})
})

describe("SmartArt font fit and words", () => {
	it("never breaks a word to fit: the size comes down until the longest word fits a line", async () => {
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="t" val="20"/>
			<dgm:constr type="h" for="ch" forName="t" val="80"/><dgm:constr type="primFontSz" for="ch" forName="t" val="65"/></dgm:constrLst>
			<dgm:layoutNode name="t"><dgm:alg type="tx"/>${NO_MARGINS}<dgm:shape type="rect"/><dgm:presOf axis="ch" ptType="node" cnt="1"/>
			<dgm:ruleLst><dgm:rule type="primFontSz" val="5"/></dgm:ruleLst></dgm:layoutNode>`)
		const measurer = await adapterMeasurer(["Children"])
		const font = run(data([{ id: "n", text: "Children" }]), xml, 100 * MM, 100 * MM, {}, measurer).shapes[0]?.fontPt ?? 0

		expect(measurer.measure("Children", font, 1e10).width).toBeLessThanOrEqual(20 * MM)
		expect(measurer.measure("Children", font + 0.5, 1e10).width).toBeGreaterThan(20 * MM)
	})
})
