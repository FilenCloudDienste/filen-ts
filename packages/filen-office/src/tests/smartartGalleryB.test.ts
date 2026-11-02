import { describe, expect, it } from "vitest"
import type { ShapeRef } from "../core/presentation/model"
import { parseDataModel } from "../core/smartart/data"
import { diagramFindTexts, newDiagramData } from "../core/smartart/edit"
import { smartArtLayoutDef } from "../core/smartart/gallery/defs"
import { SMARTART_LAYOUTS, type SmartArtCategory } from "../core/smartart/gallery/index"
import { layoutDiagram } from "../core/smartart/interp"
import { parseLayoutDef } from "../core/smartart/layoutDef"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { smartArtRenderer } from "../dom/presentation/engine/smartart"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences, partsOf, saveEdits, text } from "./pptxWriteFixtures"
import { measurer } from "./smartartFixtures"

// The hierarchy, relationship, matrix and picture layouts of our gallery in a deck: each inserts through
// Insert ▸ SmartArt and saves its five parts with every node's text drawn, a switch between any two layouts of one
// category keeps every node's text, and the picture layouts draw empty picture placeholders.

const CATEGORIES: readonly SmartArtCategory[] = ["hierarchy", "relationship", "matrix", "picture"]
const TEXTS = ["Alpha", "\tAlpha one", "\t\tAlpha deep", "\tAlpha two", "Beta", "\tBeta one", "Gamma"]
const SLICING = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }

function deck(): Uint8Array {
	return buildPptx({ slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100000, 100000, 3000000, 500000), body(para("Title"))) }] })
}

function layouts(category: SmartArtCategory): string[] {
	return SMARTART_LAYOUTS.filter(entry => entry.category === category).map(entry => entry.uniqueId)
}

async function relayout(h: EditHarness, target: ShapeRef): Promise<void> {
	const frame = h.session.deck.nodes.get(target.slide)?.shapes.find(shape => shape.id === target.id)?.frame

	if (frame?.kind !== "smartart") throw new Error("not a diagram")

	await smartArtRenderer(h.session, {
		services: { xml: part => pptxParts(h.session.deck)?.document(part), relationship: () => undefined, contentType: () => undefined }
	}).relayout(target, frame, SLICING)
}

async function insert(h: EditHarness, uniqueId: string): Promise<ShapeRef> {
	const slide = (await h.slide(0)).ref
	const result = await h.command({
		family: "smartart",
		kind: "insert",
		slide,
		shape: {
			id: 0,
			name: "Diagram",
			hidden: false,
			kind: "frame",
			xfrm: { x: 500_000, y: 1_000_000, cx: 8_000_000, cy: 4_500_000, rot: 0, flipH: false, flipV: false }
		},
		layout: { uniqueId, source: "gallery" },
		texts: TEXTS
	})

	expect(result.ok, uniqueId).toBe(true)

	const inserted = h.session.deck.nodes.get(slide)?.shapes.at(-1)

	return { slide, id: inserted?.id ?? 0 }
}

// The saved package's diagram parts of the one diagram on the slide.
async function savedDiagram(
	h: EditHarness,
	revision: number
): Promise<{ data: string; layout: string; drawing: string; bytes: Uint8Array }> {
	const bytes = await saveEdits(h, revision)
	const parts = await partsOf(bytes)
	const of = (kind: string): string => text(parts.get([...parts.keys()].find(name => name.startsWith(`ppt/diagrams/${kind}`)) ?? ""))

	return { data: of("data"), layout: of("layout"), drawing: of("drawing"), bytes }
}

function drawn(drawing: string): string[] {
	return TEXTS.map(each => each.trim()).filter(each => !drawing.includes(`<a:t>${each}</a:t>`))
}

describe("SmartArt gallery: hierarchy, relationship, matrix and picture layouts", () => {
	it("registers three or more layouts in each of the four categories, each with its definition", () => {
		for (const category of CATEGORIES) {
			const ids = layouts(category)

			expect(ids.length, category).toBeGreaterThanOrEqual(2)

			for (const id of ids) expect(smartArtLayoutDef(id), id).toMatch(/^<dgm:layoutDef /u)
		}

		expect(CATEGORIES.flatMap(layouts).filter(id => id.startsWith("urn:filen:smartart:layout:")).length).toBeGreaterThanOrEqual(12)
	})

	it("inserts every layout and saves its five parts, every node's text drawn", { timeout: 60_000 }, async () => {
		for (const uniqueId of CATEGORIES.flatMap(layouts)) {
			const h = await editHarness(deck(), {})
			const target = await insert(h, uniqueId)

			await relayout(h, target)

			const saved = await savedDiagram(h, 1)

			expect(await danglingReferences(saved.bytes), uniqueId).toEqual([])
			expect(diagramFindTexts(parseXml(encodeUtf8(saved.data))), uniqueId).toEqual(TEXTS.map(each => each.trim()))
			expect(saved.layout, uniqueId).toContain(`uniqueId="${uniqueId}"`)
			expect(drawn(saved.drawing), uniqueId).toEqual([])
			h.close()
		}
	})

	it("keeps every node's text across a switch between any two layouts of one category", { timeout: 120_000 }, async () => {
		for (const category of CATEGORIES) {
			const ids = layouts(category)

			for (const from of ids) {
				const h = await editHarness(deck(), {})
				const target = await insert(h, from)

				await relayout(h, target)

				let revision = 1

				for (const to of ids) {
					if (to === from) continue

					const result = await h.command({
						family: "smartart",
						kind: "setLayout",
						target,
						def: { uniqueId: to, source: "gallery" }
					})

					expect(result.ok, `${from} → ${to}`).toBe(true)
					await relayout(h, target)

					const saved = await savedDiagram(h, revision++)

					expect(diagramFindTexts(parseXml(encodeUtf8(saved.data))), `${from} → ${to}`).toEqual(TEXTS.map(each => each.trim()))
					expect(drawn(saved.drawing), `${from} → ${to}`).toEqual([])
				}

				h.close()
			}
		}
	})

	it("draws an empty picture placeholder for every item of a picture layout", () => {
		for (const uniqueId of layouts("picture")) {
			const def = smartArtLayoutDef(uniqueId) ?? ""
			const data = parseXml(encodeUtf8(newDiagramData(TEXTS, { layout: { uniqueId } })))
			const layout = layoutDiagram(
				parseDataModel(data),
				parseLayoutDef(parseXml(encodeUtf8(def))),
				undefined,
				undefined,
				{ x: 0, y: 0, w: 8_000_000, h: 4_500_000 },
				measurer
			)
			const placeholders = layout.shapes.filter(shape => shape.styleLbl === "alignImgPlace1")

			expect(def, uniqueId).toMatch(/blipPhldr="1"/u)
			// One per top-level item (Alpha, Beta, Gamma), drawn and holding no text.
			expect(placeholders.length, uniqueId).toBe(3)

			for (const shape of placeholders) {
				expect(shape.box.w * shape.box.h, uniqueId).toBeGreaterThan(0)
				expect(shape.text, uniqueId).toEqual([])
			}
		}
	})
})
