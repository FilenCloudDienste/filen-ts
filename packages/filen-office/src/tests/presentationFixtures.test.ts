import { describe, expect, it } from "vitest"
import { ITEM_INTS, ItemInt, ItemKind } from "../core/drawingml/index"
import { LINE_INTS, LineInt, FRAGMENT_INTS, FragmentInt } from "../core/text/displayList"
import { TEXT_STYLE_INTS, type SlideRender, type TextPage } from "../core/presentation/output"
import type { DrawingData } from "../dom/docx/protocol"
import { fixtureDeck, FIXTURE_LAYOUT, FIXTURE_MASTER } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"
import { fixtureTextLayout, fixtureTextPage } from "./fixtures/presentation/textPage"
import { cpuMs } from "./timing"

// The presentation fixtures later slices build on before the engine exists: a deck, its slide renders and text
// pages, each consistent with itself (every index points into its table), so a painter fed them draws what a real
// render would carry.

function drawingProblems(data: DrawingData, where: string): string[] {
	const problems: string[] = []

	for (let item = 0; item < data.itemCount; item++) {
		const ints = item * ITEM_INTS
		const kind = data.itemInts[ints + ItemInt.KIND]
		const fill = data.itemInts[ints + ItemInt.FILL] ?? -1
		const stroke = data.itemInts[ints + ItemInt.STROKE] ?? -1
		const first = data.itemInts[ints + ItemInt.FIRST_COMMAND] ?? 0
		const count = data.itemInts[ints + ItemInt.COMMAND_COUNT] ?? 0

		if (kind !== ItemKind.PATH && kind !== ItemKind.IMAGE && kind !== ItemKind.TEXT) problems.push(`${where} item ${String(item)} kind`)
		if (fill >= data.paints.length) problems.push(`${where} item ${String(item)} fill`)
		if (stroke >= data.strokes.length) problems.push(`${where} item ${String(item)} stroke`)
		if (first + count > data.commands.length) problems.push(`${where} item ${String(item)} commands`)
	}

	for (const stroke of data.strokes) if (stroke.paint >= data.paints.length) problems.push(`${where} stroke paint`)

	return problems
}

function textProblems(text: TextPage, where: string): string[] {
	const { page } = text
	const problems: string[] = []

	for (let line = 0; line < page.lineCount; line++) {
		const ints = line * LINE_INTS
		const first = page.lineInts[ints + LineInt.FIRST_FRAGMENT] ?? 0
		const count = page.lineInts[ints + LineInt.FRAGMENT_COUNT] ?? 0
		const source = page.lineInts[ints + LineInt.SOURCE] ?? -1

		if (first + count > page.fragmentCount) problems.push(`${where} line ${String(line)} fragments`)
		if (source < 0 || source >= page.sourceCount || source >= page.sourceTexts.length)
			problems.push(`${where} line ${String(line)} source`)

		for (let fragment = first; fragment < first + count; fragment++) {
			const f = fragment * FRAGMENT_INTS
			const end = page.fragmentInts[f + FragmentInt.TEXT_END] ?? 0
			const style = text.styles[page.fragmentInts[f + FragmentInt.STYLE] ?? -1]

			if (style === undefined) problems.push(`${where} fragment ${String(fragment)} style`)
			if (end > (page.sourceTexts[source] ?? "").length) problems.push(`${where} fragment ${String(fragment)} text`)
			if (style?.paint !== undefined && style.paint >= text.paints.length) problems.push(`${where} paint`)
			if (style?.outline !== undefined && style.outline >= text.strokes.length) problems.push(`${where} outline`)
			if (style?.effects !== undefined && style.effects >= text.textEffects.length) problems.push(`${where} effects`)
		}
	}

	for (let link = 0; link < page.linkCount; link++)
		if ((page.linkInts[link * 4 + 3] ?? -1) >= text.links.length) problems.push(`${where} link`)

	return problems
}

function renderProblems(render: SlideRender): string[] {
	return [
		...drawingProblems(render.background, "background"),
		...render.layers.flatMap(layer => [
			...drawingProblems(layer.drawing, `shape ${String(layer.shape.id)}`),
			...(layer.text === undefined ? [] : textProblems(layer.text, `text ${String(layer.shape.id)}`)),
			...(layer.matrix.length === 6 ? [] : [`matrix ${String(layer.shape.id)}`])
		])
	]
}

describe("presentation fixtures", () => {
	it("builds a deck whose slides reach their layout and master", () => {
		const deck = fixtureDeck(3)

		expect(deck.slides).toHaveLength(3)

		for (const ref of deck.slides) {
			const node = deck.nodes.get(ref)

			expect(node?.parent).toBe(FIXTURE_LAYOUT)
			expect(deck.nodes.get(FIXTURE_LAYOUT)?.parent).toBe(FIXTURE_MASTER)
		}

		expect(deck.nodes.get(deck.slides[1] ?? FIXTURE_LAYOUT)?.hidden).toBe(true)
	})

	it("renders every slide consistently with its own tables", () => {
		const deck = fixtureDeck(3)

		deck.slides.forEach((_ref, index) => {
			const render = fixtureSlideRender(deck, index)

			expect(renderProblems(render), String(index)).toEqual([])
			expect(render.layers.map(layer => layer.role)).toEqual(["placeholder", "placeholder", "picture", "table"])
		})
	})

	it("gives the title the decorated text style with every optional paint field", () => {
		const render = fixtureSlideRender(fixtureDeck(), 0)
		const title = render.layers[0]?.text
		const style = title?.styles[title.page.fragmentInts[FragmentInt.STYLE] ?? -1]

		expect(style).toMatchObject({ paint: 1, alpha: 0.8, outline: 0, effects: 0 })
		expect(title?.paints[1]?.kind).toBe("linear")
	})

	it("keeps a text page and its layout in step, and links in range", () => {
		const page = fixtureTextPage(["One", "Two"], { link: "https://filen.io" })
		const layout = fixtureTextLayout(["One", "Two"])

		expect(textProblems(page, "page")).toEqual([])
		expect(layout.lineInts).toEqual(page.page.lineInts)
		expect(layout.styleInts).toHaveLength(layout.styleCount * TEXT_STYLE_INTS)
		expect(layout.fonts).toEqual(page.styles.map(style => style.font))
	})

	it("builds a 2,000-slide deck for the rail cheaply", () => {
		let best = Infinity

		for (let run = 0; run < 3; run++) {
			const start = cpuMs()

			expect(fixtureDeck(2000).slides).toHaveLength(2000)
			best = Math.min(best, cpuMs() - start)
		}

		expect(best).toBeLessThan(250)
	})
})
