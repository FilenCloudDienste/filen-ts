import { describe, expect, it } from "vitest"
import { effectPreset } from "../core/anim/presets/effects/index"
import { cloneModel } from "../core/presentation/edit/changes"
import { addEffectsOp, effectNodes, slideEffects } from "../core/presentation/edit/commands/timing"
import type { SlideNode } from "../core/presentation/model"
import { stepEnds } from "./animAuthoringFixtures"
import { odpBytes } from "./odpFixtures"
import { entriesOf, odpApplier, openOdpDeck, saveDeck, slideAt, text } from "./odpWriteFixtures"

// Authoring effects in an ODP deck: the shapes and paragraphs LibreOffice wrote without an id get one unique in the
// document, so every page's effects read back on their own shapes and paragraphs.

const PAGE = (name: string): string =>
	`<draw:page draw:name="${name}" draw:master-page-name="M">` +
	'<draw:frame draw:name="Body" presentation:class="outline" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="9cm"><draw:text-box><text:list><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p></text:list-item></text:list></draw:text-box></draw:frame>' +
	'<draw:custom-shape draw:name="Box" svg:x="18cm" svg:y="15cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/></draw:custom-shape>' +
	"</draw:page>"

function preset(presetClass: string, id: number) {
	const found = effectPreset(presetClass, id)

	if (found === undefined) throw new Error("no preset")

	return found
}

function body(slide: SlideNode): number {
	const shape = slide.shapes.find(candidate => candidate.name === "Body")

	if (shape === undefined) throw new Error("no body")

	return shape.id
}

function box(slide: SlideNode): number {
	const shape = slide.shapes.find(candidate => candidate.name === "Box")

	if (shape === undefined) throw new Error("no box")

	return shape.id
}

describe("authored effects in a saved ODP", () => {
	it("gives an animated LibreOffice shape an id unique in the document", async () => {
		const opened = await openOdpDeck(odpBytes({ body: PAGE("a") + PAGE("b") }))
		const apply = odpApplier(opened)

		for (const index of [0, 1]) {
			const slide = slideAt(opened, index)
			const op = addEffectsOp(slide.ref, [], [{ id: box(slide) }], { preset: preset("entr", 10), aspect: 4 / 3 })

			if (op === undefined) throw new Error("no op")

			expect(apply(op)).toBeUndefined()
		}

		const saved = await saveDeck(opened)
		const content = text((await entriesOf(saved.bytes)).get("content.xml"))
		const ids = [...content.matchAll(/<draw:custom-shape[^>]*\sxml:id="([^"]*)"/gu)].map(match => match[1])

		expect(ids).toHaveLength(2)
		expect(new Set(ids).size).toBe(2)

		const reopened = await openOdpDeck(saved.bytes)

		for (const index of [0, 1]) {
			const slide = slideAt(reopened, index)
			const targets = effectNodes(slide.timing).flatMap(effect =>
				effect.ctn.children.map(child =>
					child.kind === "behavior" && "common" in child.behavior ? child.behavior.common.target : undefined
				)
			)

			expect(targets.every(target => target?.kind === "shape" && target.shape === box(slide))).toBe(true)
			expect(stepEnds(slide)).toEqual(stepEnds(slideAt(opened, index)))
		}
	})

	it("writes a by-paragraph effect on each text:p's own xml:id, as LibreOffice does, and reads it back", async () => {
		const opened = await openOdpDeck(odpBytes({ body: PAGE("a") + PAGE("b") }))
		const apply = odpApplier(opened)

		for (const index of [0, 1]) {
			const slide = slideAt(opened, index)
			const op = addEffectsOp(slide.ref, [], [{ id: body(slide), paragraphs: 2 }], {
				preset: preset("entr", 2),
				subtype: 4,
				byParagraph: true,
				aspect: 4 / 3
			})

			if (op === undefined) throw new Error("no op")

			expect(apply(op)).toBeUndefined()
		}

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const content = text((await entriesOf(saved.bytes)).get("content.xml"))
		const ids = [...content.matchAll(/<text:p\s[^>]*xml:id="([^"]*)"/gu)].map(match => match[1] ?? "")

		// Two paragraphs on each page, every id unique in the document and named by an effect.
		expect(ids).toHaveLength(4)
		expect(new Set(ids).size).toBe(4)

		for (const id of ids) expect(content).toContain(`smil:targetElement="${id}"`)

		const reopened = await openOdpDeck(saved.bytes)

		for (const index of [0, 1]) {
			const slide = slideAt(reopened, index)
			const effects = slideEffects(slide.timing)

			expect(effects.kind === "effects" ? effects.rows.map(row => [row.shape, row.paragraph, row.step]) : effects).toEqual([
				[body(slide), 0, 1],
				[body(slide), 1, 2]
			])
			expect(stepEnds(slide)).toEqual(stepEnds(slideAt(opened, index)))
		}

		// Saved again untouched: the ids stay as they are.
		const again = await saveDeck(reopened)
		const second = again.outcome.kind === "written" ? text((await entriesOf(again.bytes)).get("content.xml")) : content

		expect([...second.matchAll(/<text:p\s[^>]*xml:id="([^"]*)"/gu)].map(match => match[1] ?? "")).toEqual(ids)
	})

	it("keeps a by-paragraph effect on its paragraphs when the text is edited after a save", async () => {
		const opened = await openOdpDeck(odpBytes({ body: PAGE("a") }))
		const slide = slideAt(opened, 0)
		const op = addEffectsOp(slide.ref, [], [{ id: body(slide), paragraphs: 2 }], {
			preset: preset("entr", 10),
			byParagraph: true,
			aspect: 4 / 3
		})

		if (op === undefined) throw new Error("no op")

		expect(odpApplier(opened)(op)).toBeUndefined()

		const reopened = await openOdpDeck((await saveDeck(opened)).bytes)
		const again = slideAt(reopened, 0)
		const shape = again.shapes.find(candidate => candidate.name === "Body")

		if (shape?.text === undefined) throw new Error("no body text")

		const edited = cloneModel(shape.text)
		const first = edited.paragraphs[0]
		const run = first?.runs[0]

		if (first === undefined || run?.kind !== "r") throw new Error("no run")

		first.runs[0] = { ...run, text: "Uno" }
		expect(
			odpApplier(reopened)({ family: "text", kind: "setText", target: { slide: again.ref, id: shape.id }, body: edited })
		).toBeUndefined()

		const saved = await saveDeck(reopened)
		const effects = slideEffects(slideAt(await openOdpDeck(saved.bytes), 0).timing)

		expect(text((await entriesOf(saved.bytes)).get("content.xml"))).toContain(">Uno</text:p>")
		expect(effects.kind === "effects" ? effects.rows.map(row => [row.shape, row.paragraph]) : effects).toEqual([
			[shape.id, 0],
			[shape.id, 1]
		])
	})

	it("names a by-paragraph effect on a shape no save has written yet by the ids the save gives its text:p", async () => {
		const opened = await openOdpDeck(odpBytes({ body: PAGE("a") }))
		const slide = slideAt(opened, 0)
		const source = slide.shapes.find(candidate => candidate.name === "Body")

		if (source?.text === undefined) throw new Error("no body")

		// As an insert leaves it: no source, its paragraphs none either.
		const fresh = {
			...cloneModel(source),
			id: 99,
			name: "New",
			text: { ...cloneModel(source.text), paragraphs: source.text.paragraphs.map(p => ({ pPr: p.pPr, runs: p.runs })) }
		}

		delete (fresh as { src?: unknown }).src

		const apply = odpApplier(opened)

		expect(apply({ family: "shape", kind: "insert", slide: slide.ref, shape: fresh })).toBeUndefined()

		const op = addEffectsOp(slide.ref, [], [{ id: 99, paragraphs: 2 }], {
			preset: preset("entr", 10),
			byParagraph: true,
			aspect: 4 / 3
		})

		if (op === undefined) throw new Error("no op")

		expect(apply(op)).toBeUndefined()

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const content = text((await entriesOf(saved.bytes)).get("content.xml"))
		const ids = new Set([...content.matchAll(/xml:id="([^"]*)"/gu)].map(match => match[1]))
		const targets = [...content.matchAll(/smil:targetElement="([^"]*)"/gu)].map(match => match[1])

		expect(targets.length).toBeGreaterThan(0)
		expect(targets.filter(target => !ids.has(target))).toEqual([])

		const back = slideAt(await openOdpDeck(saved.bytes), 0)
		const shape = back.shapes.find(candidate => candidate.name === "New")
		const effects = slideEffects(back.timing)

		expect(effects.kind === "effects" ? effects.rows.map(row => [row.shape, row.paragraph]) : effects).toEqual([
			[shape?.id, 0],
			[shape?.id, 1]
		])
	})
	for (const byParagraph of [true, false])
		it(`saves a text shape given an effect${byParagraph ? " by paragraph" : ""} and then edited before the save`, async () => {
			const opened = await openOdpDeck(odpBytes({ body: PAGE("a") }))
			const slide = slideAt(opened, 0)
			const id = body(slide)
			const op = addEffectsOp(slide.ref, [], [{ id, paragraphs: 2 }], { preset: preset("entr", 10), byParagraph, aspect: 4 / 3 })

			if (op === undefined) throw new Error("no op")

			const apply = odpApplier(opened)

			expect(apply(op)).toBeUndefined()

			const shape = slideAt(opened, 0).shapes.find(candidate => candidate.id === id)

			if (shape?.text === undefined) throw new Error("no body text")

			const edited = cloneModel(shape.text)
			const first = edited.paragraphs[1]
			const run = first?.runs[0]

			if (first === undefined || run?.kind !== "r") throw new Error("no run")

			first.runs[0] = { ...run, text: "Too" }
			expect(apply({ family: "text", kind: "setText", target: { slide: slide.ref, id }, body: edited })).toBeUndefined()

			const saved = await saveDeck(opened)

			expect(saved.outcome.kind).toBe("written")

			const content = text((await entriesOf(saved.bytes)).get("content.xml"))
			const ids = new Set([...content.matchAll(/xml:id="([^"]*)"/gu)].map(match => match[1]))
			const targets = [...content.matchAll(/smil:targetElement="([^"]*)"/gu)].map(match => match[1])

			expect(content).toContain(">Too</text:p>")
			expect(targets.length).toBeGreaterThan(0)
			expect(targets.filter(target => !ids.has(target))).toEqual([])

			const effects = slideEffects(slideAt(await openOdpDeck(saved.bytes), 0).timing)

			expect(effects.kind === "effects" ? effects.rows.map(row => [row.shape, row.paragraph]) : effects).toEqual(
				byParagraph
					? [
							[id, 0],
							[id, 1]
						]
					: [[id, undefined]]
			)
		})
})
