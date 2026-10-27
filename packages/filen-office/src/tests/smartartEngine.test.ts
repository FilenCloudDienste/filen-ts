import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ITEM_INTS, ItemInt, ItemKind } from "../core/drawingml/displayList"
import { D, drawingReader } from "../core/drawingml/reader"
import { PresentationError, type FrameRef, type SlideNode } from "../core/presentation/model"
import { cachedDrawing } from "../core/presentation/render/frame"
import type { RenderServices } from "../core/presentation/render/services"
import { renderSlide } from "../core/presentation/render/slide"
import type { Slicing } from "../core/slicing"
import { parseDataModel } from "../core/smartart/data"
import { encodeUtf8, parseXml } from "../core/xml/index"
import type { EngineSession } from "../dom/presentation/engine"
import { AVERAGE_MEASURER, relayoutDiagram, sampleData, smartArtRenderer } from "../dom/presentation/engine/smartart"
import { CORPUS_DIR } from "./corpusDir"
import { openRenderDeck } from "./fixtures/presentation/renderDeck"
import { MM, data, layout } from "./smartartFixtures"

// The SmartArt engine of the presentation worker: relayouts from a diagram's parts, the session cache, the
// renderer's hook for diagrams without a drawing cache, and the gallery's sample data.

const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }
const ROW =
	layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="box" val="40"/><dgm:constr type="h" for="ch" forName="box" val="20"/></dgm:constrLst>
	<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach>`)

function doc(markup: string): ReturnType<typeof parseXml> {
	return parseXml(encodeUtf8(markup))
}

function spCount(drawingXml: string): number {
	const document = doc(drawingXml)
	const reader = drawingReader(document)

	return reader.children(reader.child(document.documentElement(), D.Dsp, "spTree"), D.Dsp, "sp").length
}

describe("SmartArt relayout", () => {
	it("lays a diagram out from its data and layout parts and emits its drawing", () => {
		const emitted = relayoutDiagram(
			{
				data: doc(
					data([
						{ id: "a", text: "A" },
						{ id: "b", text: "B" }
					])
				),
				layout: doc(ROW),
				style: undefined,
				colors: undefined
			},
			{ w: 80 * MM, h: 20 * MM },
			() => AVERAGE_MEASURER
		)

		expect(spCount(emitted.drawingXml)).toBe(2)
		expect(emitted.shapes).toHaveLength(2)
	})

	it("refuses a malformed layout part and a data model past the point budget, typed", () => {
		const sources = {
			data: doc(data([{ id: "a" }])),
			layout: doc('<dgm:colorsDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>'),
			style: undefined,
			colors: undefined
		}

		expect(() => relayoutDiagram(sources, { w: 1, h: 1 }, () => AVERAGE_MEASURER)).toThrow(PresentationError)

		const many = Array.from({ length: 1700 }, (_, i) => ({ id: `n${i}` }))
		let reason: string | undefined

		try {
			relayoutDiagram(
				{ data: doc(data(many)), layout: doc(ROW), style: undefined, colors: undefined },
				{ w: 1, h: 1 },
				() => AVERAGE_MEASURER
			)
		} catch (error) {
			reason = error instanceof PresentationError ? error.reason : undefined
		}

		expect(reason).toBe("tooLarge")
	})

	it("builds sample data with each node under the nearest shallower one before it", () => {
		const model = parseDataModel(
			sampleData([
				{ level: 1, text: "Top" },
				{ level: 2, text: "Child" },
				{ level: 2, text: "Sibling" },
				{ level: 1, text: "Next" }
			])
		)
		const top = model.root.children.filter(point => point.type === "node")

		expect(top.map(point => point.paragraphs[0])).toEqual(["Top", "Next"])
		expect(top[0]?.children.filter(point => point.type === "node").map(point => point.paragraphs[0])).toEqual(["Child", "Sibling"])
	})
})

describe("SmartArt renderer hook", () => {
	const frame: Extract<FrameRef, { kind: "smartart" }> = {
		kind: "smartart",
		data: "/d.xml",
		layout: "/l.xml",
		style: "/s.xml",
		colors: "/c.xml"
	}
	const slide = {
		ref: 1,
		kind: "slide",
		part: "/ppt/slides/slide1.xml",
		showMasterShapes: true,
		hidden: false,
		shapes: [
			{
				id: 5,
				name: "Diagram",
				hidden: false,
				kind: "frame",
				xfrm: { x: 0, y: 0, cx: 80 * MM, cy: 20 * MM, rot: 0, flipH: false, flipV: false },
				frame
			}
		],
		comments: [],
		revision: 0
	} as unknown as SlideNode
	const parts = new Map([
		[
			"/d.xml",
			doc(
				data([
					{ id: "a", text: "A" },
					{ id: "b", text: "B" }
				])
			)
		],
		["/l.xml", doc(ROW)]
	])

	function session(): EngineSession {
		return {
			deck: { nodes: new Map([[slide.ref, slide]]), slides: [slide.ref], masters: [] },
			onClose: () => undefined
		} as unknown as EngineSession
	}

	function host(generation: { value: number }): { services: RenderServices; fontGeneration: () => number } {
		return {
			services: { xml: part => parts.get(part), relationship: () => undefined, contentType: () => undefined },
			fontGeneration: () => generation.value
		}
	}

	it("relays an uncached diagram out once per slide revision and font load", async () => {
		const generation = { value: 0 }
		const renderer = smartArtRenderer(session(), host(generation))
		const target = { slide: slide.ref, id: 5 }
		const first = await renderer.relayout(target, frame, SLICING)
		const again = await renderer.relayout(target, frame, SLICING)

		expect(first?.drawingXml).toContain("<dsp:drawing")
		expect(again).toBe(first)

		generation.value++

		const reloaded = await renderer.relayout(target, frame, SLICING)

		expect(reloaded).not.toBe(first)
		expect(reloaded?.drawingXml).toBe(first?.drawingXml)
	})

	it("hands the measurer the points that hold text, so it can ask for the faces their runs use", async () => {
		const asked: unknown[] = []
		const renderer = smartArtRenderer(session(), {
			...host({ value: 0 }),
			measurer: (_slide, texts) => {
				asked.push(...texts)

				return AVERAGE_MEASURER
			}
		})

		await renderer.relayout({ slide: slide.ref, id: 5 }, frame, SLICING)

		expect(asked.map(point => (typeof point === "string" ? point : (point as { id: string }).id))).toEqual(["a", "b"])
	})

	it("relays a diagram out again when its slide's theme is edited, the slide's revision unchanged", async () => {
		const themed = { ...slide, theme: { part: "/ppt/theme/theme1.xml", revision: 0 } } as unknown as SlideNode
		const deck = {
			deck: { nodes: new Map([[themed.ref, themed]]), slides: [themed.ref], masters: [] },
			onClose: () => undefined
		} as unknown as EngineSession
		const renderer = smartArtRenderer(deck, host({ value: 0 }))
		const target = { slide: themed.ref, id: 5 }
		const first = await renderer.relayout(target, frame, SLICING)

		expect(await renderer.relayout(target, frame, SLICING)).toBe(first)

		;(themed.theme as { revision: number }).revision++

		expect(await renderer.relayout(target, frame, SLICING)).not.toBe(first)
	})

	it("answers nothing for a frame without parts, so the renderer reports it undrawn", async () => {
		const renderer = smartArtRenderer(session(), host({ value: 0 }))

		expect(await renderer.relayout({ slide: slide.ref, id: 5 }, { ...frame, data: "/missing.xml" }, SLICING)).toBeUndefined()
		expect(await renderer.relayout({ slide: slide.ref, id: 99 }, frame, SLICING)).toBeUndefined()
	})
})

const PYRAMID = join(CORPUS_DIR, "pptx/lo__tdf149551_SmartArt_Pyramid.pptx")

describe.skipIf(!existsSync(PYRAMID))("SmartArt without its drawing cache, through the slide renderer", () => {
	it("draws the pyramid's three levels from its data and layout", async () => {
		const opened = await openRenderDeck(new Uint8Array(readFileSync(PYRAMID)))

		if (opened === undefined) throw new Error("deck did not open")

		const { deck, services } = opened
		const ref = deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		const node = deck.nodes.get(ref) as SlideNode
		const diagram = node.shapes.find(shape => shape.frame?.kind === "smartart")
		const smartFrame = diagram?.frame?.kind === "smartart" ? diagram.frame : undefined
		const drawing = smartFrame === undefined ? undefined : cachedDrawing(services, smartFrame.data, node.part)
		const session = { deck, onClose: () => undefined } as unknown as EngineSession
		// The cache part is withheld: the engine has to lay the diagram out.
		const hidden: RenderServices = { ...services, xml: part => (part === drawing ? undefined : services.xml(part)) }
		const uncached: RenderServices = { ...hidden, smartart: smartArtRenderer(session, { services: hidden }) }
		const render = await renderSlide(deck, ref, uncached, SLICING)
		const layers = render.layers.filter(l => l.role === "smartart")
		let paths = 0

		for (const layer of layers)
			for (let i = 0; i < layer.drawing.itemCount; i++)
				if (layer.drawing.itemInts[i * ITEM_INTS + ItemInt.KIND] === ItemKind.PATH) paths++

		expect(drawing).toBeDefined()
		// One trapezoid per level, each with its text laid out by the slide's text adapter.
		expect(paths).toBe(3)
		expect(layers.filter(layer => layer.text !== undefined).length + layers.length).toBeGreaterThanOrEqual(3)
	})
})
