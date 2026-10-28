import { describe, expect, it } from "vitest"
import { freshOdp } from "../core/odp/write/fresh"
import { slideRef, type ShapeNode } from "../core/presentation/model"
import { FIXTURE_FIRST_SLIDE, fixtureBody, fixtureDeck } from "./fixtures/presentation/deck"

// A converted deck's text laid out as PowerPoint lays it out, in the terms an ODF consumer reads: line heights from
// the font size alone (DrawingML spacing is a share of the size, §21.1.2.2.5), the space before and after paragraphs
// added together, and a shape that fits its text (a:spAutoFit, §21.1.2.1.4) free to grow or shrink to it.

const BOX = { x: 914_400, y: 914_400, cx: 3_000_000, cy: 1_000_000, rot: 0, flipH: false, flipV: false }

function textBox(autofit: "shape" | "none"): ShapeNode {
	return {
		id: 50,
		name: "TextBox 49",
		hidden: false,
		kind: "sp",
		txBox: true,
		xfrm: BOX,
		props: { geometry: { kind: "preset", preset: "rect", guides: [] } },
		text: { ...fixtureBody(["Fits its text"]), bodyPr: { autofit } }
	}
}

async function written(shape: ShapeNode) {
	const deck = fixtureDeck(1)
	const slide = deck.nodes.get(slideRef(FIXTURE_FIRST_SLIDE))

	if (slide === undefined) throw new Error("fixture slide missing")

	slide.shapes.push(shape)

	const fresh = await freshOdp(deck, { theme: () => undefined, picture: () => Promise.resolve(undefined) })

	if ("kind" in fresh) throw new Error(`refused ${fresh.reason}`)

	const part = (name: string) => {
		const change = fresh.parts.find(entry => entry.name === name)

		return change === undefined ? "" : new TextDecoder().decode(change.bytes as Uint8Array)
	}

	return { content: part("content.xml"), settings: part("settings.xml"), manifest: part("META-INF/manifest.xml") }
}

function styleOf(content: string, element: string): string {
	const name = new RegExp(`<${element}\\b[^>]*draw:name="TextBox 49"[^>]*draw:style-name="([^"]+)"`, "u").exec(content)?.[1] ?? ""

	return new RegExp(`<style:style style:name="${name}"[\\s\\S]*?</style:style>`, "u").exec(content)?.[0] ?? ""
}

describe("fresh ODP text layout", () => {
	it("writes every paragraph with line heights from its font size alone", async () => {
		const { content } = await written(textBox("none"))
		const paragraphs = [...content.matchAll(/<style:style style:name="[^"]+" style:family="paragraph">[\s\S]*?<\/style:style>/gu)]

		expect(paragraphs.length).toBeGreaterThan(0)

		for (const [style] of paragraphs) expect(style).toContain('style:font-independent-line-spacing="true"')
		// The shape's own style says so too: LibreOffice lays the text out by it.
		expect(styleOf(content, "draw:frame")).toMatch(/<style:paragraph-properties[^>]*style:font-independent-line-spacing="true"/u)
	})

	it("sizes East Asian and complex-script text as its run (DrawingML has one size for every script)", async () => {
		const box = textBox("none")
		const { content } = await written({
			...box,
			text: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "各observation は自身の行", rPr: { sz: 1200 } }] }] }
		})
		const sized = [...content.matchAll(/<style:text-properties[^>]*fo:font-size="12pt"[^>]*>/gu)].map(([tag]) => tag)

		expect(sized.length).toBeGreaterThan(0)

		for (const tag of sized) {
			expect(tag).toContain('style:font-size-asian="12pt"')
			expect(tag).toContain('style:font-size-complex="12pt"')
		}
	})

	it("keeps a shape whose level-2 paragraph has no bullet but an indent of its own, its margins on it", async () => {
		const box = textBox("none")
		const { content } = await written({
			...box,
			text: {
				bodyPr: {},
				paragraphs: [
					{
						pPr: { lvl: 1, marL: 742_950, indent: -285_750, bullet: { kind: "none" } },
						runs: [{ kind: "r", text: "Outside the list", rPr: {} }]
					}
				]
			}
		})
		const name = /<text:p text:style-name="([^"]+)">Outside the list/u.exec(content)?.[1] ?? ""

		expect(content).toContain("Outside the list")
		expect(
			new RegExp(
				`<style:style style:name="${name}"[^>]*>[^]*?fo:margin-left="2\\.06375cm"[^>]*fo:text-indent="-0\\.79375cm"`,
				"u"
			).test(content)
		).toBe(true)
	})

	it("writes a bullet of more than one character as its first, keeping the shape", async () => {
		const box = textBox("none")
		const { content } = await written({
			...box,
			text: {
				bodyPr: {},
				paragraphs: [
					{
						pPr: { lvl: 1, marL: 171_450, indent: -171_450, bullet: { kind: "char", char: "••" } },
						runs: [{ kind: "r", text: "Node", rPr: {} }]
					}
				]
			}
		})

		expect(content).toContain("Node")
		expect(content).toContain('text:bullet-char="•"')
	})

	it("adds the space after a paragraph and before the next together", async () => {
		const { settings, manifest } = await written(textBox("none"))

		expect(settings).toMatch(/config:name="ParagraphSummation" config:type="boolean">true</u)
		expect(manifest).toContain('manifest:full-path="settings.xml"')
	})

	it("writes a text box that fits its text as a shape free to grow or shrink to it", async () => {
		const { content } = await written(textBox("shape"))
		const style = styleOf(content, "draw:custom-shape")

		expect(content).toMatch(/<draw:custom-shape\b[^>]*draw:name="TextBox 49"[\s\S]*?draw:type="rectangle"/u)
		expect(style).toContain('draw:auto-grow-height="true"')
		expect(style).toContain('fo:min-height="0cm"')
	})

	it("keeps a text box of a fixed size a text frame", async () => {
		const { content } = await written(textBox("none"))

		expect(content).toMatch(/<draw:frame\b[^>]*draw:name="TextBox 49"[^>]*>\s*<draw:text-box>/u)
	})
})
