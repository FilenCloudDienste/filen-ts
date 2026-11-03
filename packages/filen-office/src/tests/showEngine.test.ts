import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compileSource, instantiate } from "../core/anim/timegraph"
import { DrawingList, IDENTITY, ItemKind } from "../core/drawingml/index"
import { bytesSource } from "../core/opc/index"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { slideRef, type ShapeNode, type SlideNode } from "../core/presentation/model"
import type { SlideLayer, SlideRender } from "../core/presentation/output"
import { drawingData } from "../core/presentation/render/slide"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { openOdpCapability } from "../dom/presentation/engine/open/odp"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import {
	drawingExtent,
	layerParents,
	layerScales,
	paragraphBands,
	planShowLayers,
	pptxTransition,
	showCapability,
	showLayerIndex,
	STATIC_LAYER
} from "../dom/presentation/engine/show"
import type { LayerPlan, ShowLayer } from "../dom/presentation/protocol"
import { presentationTextServices } from "../dom/presentation/engine/view"
import { installPresentationRealm, MAX_CANVAS_SIDE, type RasterCanvas, type RasterImage } from "../dom/presentation/services"
import { TIMING_XML, TimingBuilder } from "./animFixtures"
import { fixtureTextPage } from "./fixtures/presentation/textPage"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { odpBytes, page } from "./odpFixtures"
import { body, buildPptx, NS, para, sp, xfrm } from "./pptxFixtures"
import { RecordingCanvas } from "./presentationCanvasRecorder"

// The worker's side of the show: the layers a slide's timing animates (paragraph ranges split so each target covers
// whole layers, character targets on the whole shape), how they nest, the slide drawn as z-ordered bitmaps (static
// runs between animated shapes, paragraph bands, the byte budget), a pptx slide's transition (the Fallback when the
// Choice is a 3D one), and timegraph(): a source the page compiles to the same graph the worker checked.

const EMU = 9525
const BUDGETS = DEFAULT_PRESENTATION_BUDGETS.timing

describe("showLayerIndex", () => {
	it("gives each animated shape a whole layer and splits targeted paragraph ranges at every boundary", () => {
		const b = new TimingBuilder()
		const para = (shape: number, start: number, end: number) =>
			b.behavior(
				{
					type: "animEffect",
					common: { target: { kind: "text", shape, unit: "para", start, end }, attrNames: [] },
					transition: "in",
					filter: "fade"
				},
				{ dur: 500 }
			)
		const chars = b.behavior(
			{
				type: "animEffect",
				common: { target: { kind: "text", shape: 9, unit: "char", start: 0, end: 3 }, attrNames: [] },
				filter: "fade"
			},
			{ dur: 500 }
		)
		const timing = b.root([b.mainSeq([b.click([[0, [para(5, 0, 0), para(5, 0, 2), para(5, 4, 4), chars, b.spin(2, "withEffect")]]])])])
		const index = showLayerIndex(timing)

		expect([...index.shapes]).toEqual([2, 5, 5, 5, 5, 9])
		expect(index.ranges).toEqual([
			undefined,
			undefined,
			{ unit: "para", start: 0, end: 0 },
			{ unit: "para", start: 1, end: 2 },
			{ unit: "para", start: 4, end: 4 },
			undefined
		])
	})

	it("has no ranges when nothing is built by paragraph", () => {
		const b = new TimingBuilder()

		expect(showLayerIndex(b.root([b.mainSeq([b.click([[0, [b.flyIn(4, "clickEffect")]]])])]))).toEqual({ shapes: Int32Array.of(4) })
		expect(showLayerIndex(undefined)).toEqual({ shapes: new Int32Array(0) })
	})

	it("nests a paragraph range in its shape and a shape in its nearest animated group", () => {
		const group: ShapeNode = {
			id: 10,
			name: "g",
			hidden: false,
			kind: "grpSp",
			children: [
				{ id: 11, name: "a", hidden: false, kind: "sp" },
				{ id: 12, name: "inner", hidden: false, kind: "grpSp", children: [{ id: 13, name: "b", hidden: false, kind: "sp" }] }
			]
		}
		const layers = {
			shapes: Int32Array.of(10, 13, 13, 20),
			ranges: [undefined, undefined, { unit: "para" as const, start: 0, end: 0 }, undefined]
		}

		expect([...layerParents(layers, [group, { id: 20, name: "c", hidden: false, kind: "sp" }])]).toEqual([-1, 0, 1, -1])
	})
})

function drawn(id: number, x: number, y: number, w: number, h: number, extra: Partial<SlideLayer> = {}): SlideLayer {
	return {
		shape: { slide: slideRef(256), id },
		drawing: drawingDataOf(new DrawingList(), w, h),
		matrix: [1, 0, 0, 1, x, y],
		role: "shape",
		box: { id, xfrm: { x: x * EMU, y: y * EMU, cx: w * EMU, cy: h * EMU, rot: 0, flipH: false, flipV: false } },
		...extra
	}
}

function renderOf(layers: readonly SlideLayer[]): SlideRender {
	return {
		ref: slideRef(256),
		index: 0,
		revision: 0,
		hidden: false,
		background: drawingDataOf(new DrawingList(), 960, 540),
		layers,
		notesText: "",
		animated: true
	}
}

function nodeOf(shapes: readonly ShapeNode[]): SlideNode {
	return {
		ref: slideRef(256),
		kind: "slide",
		part: "",
		showMasterShapes: true,
		hidden: false,
		shapes: [...shapes],
		comments: [],
		revision: 0
	}
}

const SLIDE = { w: 960, h: 540 }

function drawingDataOf(list: DrawingList, width: number, height: number): ReturnType<typeof drawingData> {
	list.width = width
	list.height = height

	return drawingData(list)
}

describe("planShowLayers", () => {
	it("keeps z-order: the background run, static runs between animated shapes, master art static", () => {
		const master: SlideLayer = { ...drawn(2, 0, 0, 960, 40), shape: { slide: slideRef(1), id: 2 }, role: "master" }
		const render = renderOf([
			master,
			drawn(3, 10, 10, 100, 50),
			drawn(4, 200, 10, 100, 50),
			drawn(5, 400, 10, 100, 50),
			drawn(6, 600, 10, 100, 50)
		])
		const node = nodeOf([3, 4, 5, 6].map(id => ({ id, name: String(id), hidden: false, kind: "sp" as const })))
		const planned = planShowLayers(render, node, { shapes: [4, 6], dpr: 1 }, SLIDE)

		expect(planned.map(layer => [layer.shape, layer.background, layer.pieces.map(piece => piece.layer.shape.id)])).toEqual([
			[STATIC_LAYER, true, [2, 3]],
			[4, false, [4]],
			[STATIC_LAYER, false, [5]],
			[6, false, [6]]
		])
		expect(planned[0]?.bounds).toEqual([0, 0, 960, 540])
		expect(planned[1]?.bounds).toEqual([200, 10, 300, 60])
	})

	it("puts a group child the timing names in its own layer and the rest of the group in the group's", () => {
		const groupBox = { id: 10, xfrm: { x: 0, y: 0, cx: 170 * EMU, cy: 50 * EMU, rot: 0, flipH: false, flipV: false } }
		const layers = [drawn(11, 0, 0, 50, 50), drawn(12, 60, 0, 50, 50), drawn(13, 120, 0, 50, 50)].map(layer => ({
			...layer,
			box: groupBox
		}))
		const group: ShapeNode = {
			id: 10,
			name: "g",
			hidden: false,
			kind: "grpSp",
			children: [11, 12, 13].map(id => ({ id, name: String(id), hidden: false, kind: "sp" as const }))
		}
		const planned = planShowLayers(renderOf(layers), nodeOf([group]), { shapes: [10, 12], dpr: 1 }, SLIDE)

		expect(planned.map(layer => [layer.shape, layer.pieces.map(piece => piece.layer.shape.id)])).toEqual([
			[STATIC_LAYER, []],
			[10, [11]],
			[12, [12]],
			[10, [13]]
		])
	})

	it("cuts a body built by paragraph into bands: the drawing and the untargeted paragraphs stay with the shape", () => {
		const text = fixtureTextPage(["First", "Second", "Third"])
		const layer = drawn(5, 100, 100, 400, 300, { text })
		const planned = planShowLayers(
			renderOf([layer]),
			nodeOf([{ id: 5, name: "5", hidden: false, kind: "sp" }]),
			{ shapes: [5], ranges: [[{ target: "para", range: [1, 1] }]], dpr: 1 },
			SLIDE
		)
		const tops = [0, 1, 2].map(line => text.page.lineFloats[line * 5] ?? 0)

		expect(
			planned.map(entry => [
				entry.shape,
				entry.range?.range,
				entry.pieces.map(piece => [piece.layer.text === undefined, piece.bands])
			])
		).toEqual([
			[STATIC_LAYER, undefined, []],
			[
				5,
				undefined,
				[
					[true, undefined],
					[
						false,
						[
							[-1_000_000, tops[1]],
							[tops[2], 1_000_000]
						]
					]
				]
			],
			[5, [1, 1], [[false, [[tops[1], tops[2]]]]]]
		])
	})

	it("keeps what a drawing paints past its frame (a callout's pointer, half a stroke)", () => {
		const list = new DrawingList()

		list.width = 100
		list.height = 50

		const stroke = list.stroke({
			width: 4,
			paint: -1,
			dash: "solid",
			customDash: null,
			cap: "flat",
			join: "round",
			miterLimit: 8,
			compound: "sng",
			inset: false
		})
		const firstCommand = list.commandCount
		const firstCoord = list.coordCount

		list.moveTo(0, 0)
		list.lineTo(100, 0)
		list.lineTo(-60, 120)
		list.close()
		list.addItem(ItemKind.PATH, IDENTITY, 0, 0, 100, 50, firstCommand, firstCoord, -1, stroke, -1, -1, 0, 0)

		const layer = drawn(7, 300, 100, 100, 50, { drawing: drawingDataOf(list, 100, 50) })
		const planned = planShowLayers(
			renderOf([layer]),
			nodeOf([{ id: 7, name: "7", hidden: false, kind: "sp" }]),
			{ shapes: [7], dpr: 1 },
			SLIDE
		)

		expect(drawingExtent(layer.drawing)).toEqual([-62, -2, 102, 122])
		expect(planned[1]?.bounds).toEqual([238, 98, 402, 222])
	})

	it("merges the bands of neighbouring paragraphs", () => {
		const tops = new Map([
			[0, 0],
			[1, 20],
			[2, 40],
			[3, 60]
		])

		expect(paragraphBands(tops, paragraph => paragraph === 1 || paragraph === 2)).toEqual([[20, 60]])
		expect(paragraphBands(tops, paragraph => paragraph !== 2)).toEqual([
			[-1_000_000, 40],
			[60, 1_000_000]
		])
	})

	it("lowers every layer's scale together past the byte budget, and one layer's past the canvas side", () => {
		const layer = (w: number, h: number) => ({
			shape: 1,
			background: false,
			pieces: [],
			bounds: [0, 0, w, h] as [number, number, number, number]
		})
		const scales = layerScales([layer(1000, 1000), layer(1000, 1000)], 2, 4 * 1000 * 1000 * 2)

		expect(scales[0]).toBeCloseTo(1, 6)
		expect(layerScales([layer(5000, 10)], 2)[0]).toBeCloseTo(8192 / 5000, 6)
	})
})

describe("pptxTransition", () => {
	const sld = (inner: string) =>
		parseXml(
			encodeUtf8(
				`<p:sld ${NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p:cSld><p:spTree/></p:cSld>${inner}</p:sld>`
			)
		)

	it("reads p:transition: kind, options, speed, advance", () => {
		expect(pptxTransition(sld('<p:transition spd="slow" advClick="0" advTm="3000"><p:push dir="u"/></p:transition>'))).toEqual({
			kind: "push",
			namespace: "p",
			options: { dir: "u" },
			durationMs: 1000,
			speed: "slow",
			advance: { onClick: false, afterMs: 3000 }
		})
		expect(pptxTransition(sld('<p:transition><p:fade thruBlk="1"/></p:transition>'))).toMatchObject({
			kind: "fade",
			options: { thruBlk: true },
			durationMs: 500
		})
		expect(pptxTransition(sld(""))).toBeUndefined()
	})

	it("takes the Choice an ECMA kind with its p14:dur, and the Fallback for a 3D Choice", () => {
		const ac = (choice: string, fallback: string) =>
			`<mc:AlternateContent><mc:Choice Requires="p14">${choice}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`

		expect(
			pptxTransition(
				sld(
					ac(
						'<p:transition spd="slow" p14:dur="2000"><p:wipe dir="d"/></p:transition>',
						'<p:transition spd="slow"><p:wipe dir="d"/></p:transition>'
					)
				)
			)
		).toMatchObject({ kind: "wipe", durationMs: 2000, options: { dir: "d" } })
		expect(
			pptxTransition(
				sld(
					ac(
						'<p:transition spd="slow" p14:dur="1250"><p14:vortex dir="r"/></p:transition>',
						'<p:transition spd="slow"><p:fade/></p:transition>'
					)
				)
			)
		).toMatchObject({ kind: "fade", namespace: "p", durationMs: 1000 })
	})
})

// --- timegraph() and layers() over a real pptx ---

class Bitmap implements RasterImage {
	readonly width: number
	readonly height: number
	closed = false

	constructor(width: number, height: number) {
		this.width = width
		this.height = height
	}

	close(): void {
		this.closed = true
	}
}

class Canvas extends RecordingCanvas implements RasterCanvas {
	getContext(): RecordingCanvas {
		return this
	}

	transferToImageBitmap(): RasterImage {
		return new Bitmap(this.width, this.height)
	}

	close(): void {}
}

const canvases: Canvas[] = []

function deck(): Uint8Array {
	const box = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2563EB"/></a:solidFill>'

	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Spinner", undefined, `${xfrm(914400, 914400, 1828800, 914400)}${box}`) +
					sp(3, "Points", undefined, `${xfrm(914400, 2743200, 4572000, 1828800)}${box}`, body(para("One") + para("Two"))) +
					sp(4, "Flyer", undefined, `${xfrm(5486400, 914400, 1828800, 914400)}${box}`) +
					sp(5, "Still", undefined, `${xfrm(5486400, 2743200, 1828800, 914400)}${box}`),
				after: `<p:transition spd="med"><p:wipe dir="r"/></p:transition>${TIMING_XML}`
			}
		]
	})
}

async function harness(
	bytes: Uint8Array = deck()
): Promise<{ readonly context: CallContext; readonly ref: ReturnType<typeof slideRef>; close(): void }> {
	const outcome = await openPptxCapability.open({
		source: bytesSource(bytes),
		sourceKind: "bytes",
		options: { format: "pptx", fileName: "show.pptx" }
	})

	if (outcome.kind !== "opened") throw new Error(outcome.kind)

	const closers: (() => void)[] = []
	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "show.pptx" },
		services: { ...SERVICES, text: presentationTextServices },
		rangeSource: undefined,
		schedule: () => undefined,
		emit: () => undefined,
		onClose: listener => closers.push(listener)
	}
	const ref = outcome.deck.slides[0]

	if (ref === undefined) throw new Error("no slide")

	return {
		context: {
			session,
			signal: { aborted: false, onAbort: () => undefined },
			lane: "background",
			slicing: { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }
		},
		ref,
		close: () => {
			for (const closer of closers) closer()
		}
	}
}

beforeAll(() => {
	installPresentationRealm({
		text: {
			fontHost: nodeFontHost,
			replayFonts: true,
			fontAssets: nodeFontAssets,
			measurer: new HmtxMeasurer(),
			yield: () => Promise.resolve()
		},
		canvas: {
			canvas: (width, height) => {
				const made = new Canvas(Math.ceil(width), Math.ceil(height), `canvas${String(canvases.length)}`)

				canvases.push(made)

				return made
			},
			decode: () => Promise.resolve(undefined),
			copy: image => Promise.resolve(new Bitmap(image.width, image.height)),
			fontsReady: () => Promise.resolve()
		}
	})
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe("showCapability", () => {
	it("answers a source the page compiles to the graph the worker checked, with the slide's transition", async () => {
		const { context, ref, close } = await harness()

		try {
			const graph = await showCapability.timegraph(context, ref)
			const source = graph.source

			if (source === undefined) throw new Error("no source")

			const page = compileSource(ref, structuredClone(source), BUDGETS)

			expect(page.mainSteps).toBe(graph.mainSteps)
			expect(page.mainSteps).toBe(2)
			expect(page.tracks).toEqual(graph.tracks)
			expect([...source.layers.shapes]).toEqual([2, 3, 3, 4])
			expect([...source.parents]).toEqual([-1, -1, 1, -1])
			expect(source.transition).toMatchObject({ kind: "wipe", options: { dir: "r" }, durationMs: 750 })
			// The flyer's box as rendered (EMU).
			expect([...source.geometry.subarray(10, 15)]).toEqual([4, 5486400, 914400, 1828800, 914400])

			// Before the first click the fly-in shape and the faded paragraph are hidden; after both clicks and their
			// effects every layer is shown where it is drawn.
			const instance = instantiate(page)

			instance.fire({ kind: "slideBegin" }, 0)

			const before = instance.sample(0)

			expect(before.find(state => state.layer === 3)?.visible).toBe(false)
			expect(before.find(state => state.layer === 2)?.visible).toBe(false)

			instance.fire({ kind: "next" }, 100)
			instance.fire({ kind: "next" }, 5000)

			const after = instance.sample(60_000)

			for (const state of after) {
				expect(state.visible).toBe(true)
				expect(state.opacity).toBe(1)
				expect(state.matrix.map(value => Math.round(value * 1000) / 1000 + 0)).toEqual([1, 0, 0, 1, 0, 0])
			}
		} finally {
			close()
		}
	})

	it("draws the slide as z-ordered bitmaps at the stage's width, each painted from its own origin", async () => {
		const { context, ref, close } = await harness()

		try {
			const graph = await showCapability.timegraph(context, ref)

			canvases.length = 0

			const layers = await showCapability.layers(context, ref, 480, {
				shapes: [2, 3, 4],
				ranges: [undefined, [{ target: "para", range: [0, 0] }], undefined],
				dpr: 2
			})

			expect(graph.source?.layers.shapes.length).toBe(4)
			expect(layers.map(layer => [layer.shape, layer.range?.range])).toEqual([
				[STATIC_LAYER, undefined],
				[2, undefined],
				[3, undefined],
				[3, [0, 0]],
				[4, undefined],
				[STATIC_LAYER, undefined]
			])

			// The background run covers the 1280 x 720 px slide, drawn 480 px x 2 wide (0.75 device px per slide px).
			expect(layers[0]).toMatchObject({ x: 0, y: 0, width: 1280, height: 720 })
			expect(layers[0]?.bitmap.width).toBe(960)

			// The flyer's canvas: its box, painted from its own origin (its top-left corner at the canvas's).
			const flyer = layers[4]

			expect(flyer).toMatchObject({ x: 576, y: 96, width: 192, height: 96 })
			expect(canvases[4]?.width).toBe(144)
			expect(canvases[4]?.calls.find(call => call.op === "moveTo")?.transform).toEqual([0.75, 0, 0, 0.75, 0, 0])
			expect(canvases[4]?.calls.find(call => call.op === "moveTo")?.args).toEqual([0, 0])
		} finally {
			close()
		}
	})

	it("packs the layers into shared page bitmaps when asked, each painted at its place in its page", async () => {
		const { context, ref, close } = await harness()

		try {
			await showCapability.timegraph(context, ref)

			canvases.length = 0

			const plan = {
				shapes: [2, 3, 4],
				ranges: [undefined, [{ target: "para" as const, range: [0, 0] as const }], undefined],
				dpr: 2
			}
			const single = await showCapability.layers(context, ref, 480, plan)
			const atlased: LayerPlan = { ...plan, atlas: 1024 }
			const tiny: LayerPlan = { ...plan, atlas: 10 }
			const packed: readonly ShowLayer[] = await showCapability.layers(context, ref, 480, atlased)

			// The same layers in the same order, at the same places on the slide.
			expect(packed.map(layer => [layer.shape, layer.range?.range, layer.x, layer.y, layer.width, layer.height])).toEqual(
				single.map(layer => [layer.shape, layer.range?.range, layer.x, layer.y, layer.width, layer.height])
			)

			// Fewer bitmaps than layers; each layer's place is its own bitmap's size, inside its page.
			const pages = new Set(packed.map(layer => layer.bitmap))

			expect(pages.size).toBeLessThan(packed.length)
			packed.forEach((layer, k) => {
				const own = single[k]?.bitmap

				expect(layer.atlas).toMatchObject({ width: own?.width, height: own?.height })
				expect((layer.atlas?.x ?? -1) + (layer.atlas?.width ?? 0)).toBeLessThanOrEqual(layer.bitmap.width)
				expect((layer.atlas?.y ?? -1) + (layer.atlas?.height ?? 0)).toBeLessThanOrEqual(layer.bitmap.height)
			})

			// The flyer is painted from its place in the page, clipped to it.
			const flyer = packed[4]
			const page = canvases.find(canvas => canvas.calls.some(call => call.op === "rect" && call.args[0] === flyer?.atlas?.x))
			const move = page?.calls.find(call => call.op === "moveTo" && call.transform?.[4] === flyer?.atlas?.x)

			expect(move?.transform).toEqual([0.75, 0, 0, 0.75, flyer?.atlas?.x, flyer?.atlas?.y])

			for (const layer of [...single, ...packed]) layer.bitmap.close()

			await expect(showCapability.layers(context, ref, 480, tiny)).rejects.toMatchObject({ reason: "tooLarge" })

			// The page side runs from 64 px to the largest canvas, in whole px.
			for (const atlas of [63, MAX_CANVAS_SIDE + 1, 100.5, Number.NaN, Number.POSITIVE_INFINITY]) {
				const refusedPlan: LayerPlan = { ...plan, atlas }

				await expect(showCapability.layers(context, ref, 480, refusedPlan)).rejects.toMatchObject({ reason: "tooLarge" })
			}

			for (const atlas of [64, MAX_CANVAS_SIDE]) {
				const edgePlan: LayerPlan = { ...plan, atlas }
				const edge: readonly ShowLayer[] = await showCapability.layers(context, ref, 480, edgePlan)

				expect(edge.map(layer => layer.shape)).toEqual(single.map(layer => layer.shape))
				expect(edge.every(layer => layer.bitmap.width <= Math.max(atlas, layer.atlas?.width ?? 0))).toBe(true)

				for (const layer of edge) layer.bitmap.close()
			}
		} finally {
			close()
		}
	})

	it("describes the slide's objects for morph only in a deck one of whose slides morphs", async () => {
		const box = `${xfrm(914400, 914400, 1828800, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
		const morph =
			'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
			'<mc:Choice xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main" Requires="p159">' +
			'<p:transition spd="slow"><p159:morph option="byObject"/></p:transition></mc:Choice>' +
			'<mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>'
		const morphing = await harness(
			buildPptx({ slides: [{ shapes: sp(2, "Box", undefined, box) }, { shapes: sp(2, "Box", undefined, box), after: morph }] })
		)
		const still = await harness()

		try {
			// The first slide's objects are what the second one's morph starts from.
			expect((await showCapability.timegraph(morphing.context, morphing.ref)).source?.morph).toHaveLength(1)
			expect((await showCapability.timegraph(still.context, still.ref)).source?.morph).toBeUndefined()

			// A morph given in this session counts.
			const node = still.context.session.deck.nodes.get(still.ref)

			if (node === undefined) throw new Error("no slide")

			still.context.session.deck.nodes.set(still.ref, {
				...node,
				transition: { kind: "morph", namespace: "morph", options: {}, advance: { onClick: true } }
			})
			expect((await showCapability.timegraph(still.context, still.ref)).source?.morph).toHaveLength(4)
		} finally {
			morphing.close()
			still.close()
		}

		// An ODP deck (not scanned: ODF has no morph) morphs only by an edit.
		const odp = await openOdpCapability.open({
			source: bytesSource(odpBytes({ body: page('<draw:rect svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="2cm"/>') })),
			sourceKind: "bytes",
			options: { format: "odp", fileName: "show.odp" }
		})

		if (odp.kind !== "opened") throw new Error(odp.kind)

		const ref = odp.deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		const context = { ...still.context, session: { ...still.context.session, deck: odp.deck, package: odp.package } }

		expect((await showCapability.timegraph(context, ref)).source?.morph).toBeUndefined()

		const node = odp.deck.nodes.get(ref)

		if (node === undefined) throw new Error("no slide")

		odp.deck.nodes.set(ref, { ...node, transition: { kind: "morph", namespace: "morph", options: {}, advance: { onClick: true } } })
		expect((await showCapability.timegraph(context, ref)).source?.morph).toHaveLength(1)
	})

	it("refuses a stage width outside what it draws", async () => {
		const { context, ref, close } = await harness()

		try {
			await expect(showCapability.layers(context, ref, 8, { shapes: [], dpr: 1 })).rejects.toMatchObject({ reason: "tooLarge" })
			await expect(showCapability.layers(context, ref, 800, { shapes: [], dpr: 9 })).rejects.toMatchObject({ reason: "tooLarge" })
		} finally {
			close()
		}
	})
})
