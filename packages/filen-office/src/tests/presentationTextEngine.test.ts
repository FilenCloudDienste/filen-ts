import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { bytesSource, type Slicing } from "../core/opc/index"
import { rgba } from "../core/drawingml/index"
import { notesTarget } from "../core/presentation/notes"
import { refused, slideRef, type Format, type ShapeRef, type SlideRef } from "../core/presentation/model"
import type { LayoutOptions } from "../core/presentation/text/body"
import { MeasureCache } from "../core/text/index"
import { SERVICES, type CallContext, type EngineServices, type EngineSession } from "../dom/presentation/engine"
import { layoutShapeText, type ShapeTextContext, type TextServices } from "../dom/presentation/engine/text"
import { presentationTextServices, renderSlideFor } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { fixtureBody, fixtureDeck } from "./fixtures/presentation/deck"
import { odpBytes, page } from "./odpFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { installTestRealm, openDeck } from "./presentationExportFixtures"
import { tableDeck, tableFrame } from "./presentationObjectsFixtures"
import { FakeMeasurer, testFont } from "./textFixtures"

// The options every body layout of the render is made with, recorded to compare with the editor's.
const laidOut = vi.hoisted(() => ({ options: [] as LayoutOptions[] }))

vi.mock("../core/presentation/text/body", async importOriginal => {
	const original = await importOriginal<typeof import("../core/presentation/text/body")>()

	return {
		...original,
		layoutBody: (...args: Parameters<typeof original.layoutBody>) => {
			laidOut.options.push(args[3] ?? {})

			return original.layoutBody(...args)
		}
	}
})

// layoutText in the worker: an edited body laid out in its shape's chain and box (the host's text services), the
// answer's layout in buffers of its own (the page's and the layout's are both transferred), and a typed refusal
// without text services or for a shape the services refuse.

const slicing = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }

function session(text: TextServices | undefined): EngineSession {
	const services: EngineServices = text === undefined ? SERVICES : { ...SERVICES, text }

	return {
		s: 1,
		deck: fixtureDeck(),
		package: { format: "pptx", variant: "pptx", bytes: 0, source: bytesSource(new Uint8Array(0)), sourceKind: "bytes", locks: 0 },
		options: { format: "pptx", fileName: "deck.pptx" },
		services,
		rangeSource: undefined,
		schedule: () => undefined,
		emit: () => undefined,
		onClose: () => undefined
	}
}

const prepared: string[] = []

const context: ShapeTextContext = {
	kind: "shapeText",
	context: { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } },
	box: { width: 200, height: 100 },
	environment: { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) },
	prepare: requests => {
		prepared.push(...requests.map(request => request.family))

		return Promise.resolve()
	},
	options: {},
	refit: false,
	revision: 7
}

describe("presentation layoutText", () => {
	it("lays out an edited body in the shape's chain and box", async () => {
		const target = { slide: slideRef(10), id: 2 }
		const result = await layoutShapeText(
			session({ shapeText: () => Promise.resolve(context) }),
			target,
			fixtureBody(["Typed text", "Second"]),
			slicing
		)

		expect(result.revision).toBe(7)
		expect(result.page.page.sourceTexts).toEqual(["Typed text", "Second"])
		expect(result.layout.lineCount).toBe(result.page.page.lineCount)
		expect(result.layout.lineInts.buffer).not.toBe(result.page.page.lineInts.buffer)
		expect(result.layout.styleCount).toBeGreaterThan(0)
		expect(result.layout.fonts.length).toBeGreaterThan(0)
		expect(prepared.length).toBeGreaterThan(0)
	})

	it("refuses without text services, and with the services' own reason", async () => {
		const target = { slide: slideRef(10), id: 2 }

		await expect(layoutShapeText(session(undefined), target, fixtureBody(["x"]), slicing)).rejects.toMatchObject({
			reason: "notImplemented"
		})
		await expect(
			layoutShapeText(
				session({ shapeText: () => Promise.resolve(refused("notFound", "shape")) }),
				target,
				fixtureBody(["x"]),
				slicing
			)
		).rejects.toMatchObject({ reason: "notFound" })
	})
})

describe("presentation shapeText", () => {
	beforeAll(() => {
		installTestRealm()
	})

	afterAll(() => {
		installPresentationRealm(undefined)
	})

	// Every pause a macrotask, every check past the slice: a second call starts while the first one's render runs.
	function interleaving(): Slicing {
		let now = 0

		return {
			pause: () => new Promise(resolve => setTimeout(resolve, 0)),
			sliceMs: 8,
			now: () => (now += 10)
		}
	}

	async function both(first: (slide: SlideRef) => ShapeRef, second: (slide: SlideRef) => ShapeRef): Promise<void> {
		const { session } = await openDeck(tableDeck())
		const slide = session.deck.slides[0] as SlideRef
		const slicing = interleaving()
		const found = await Promise.all([
			presentationTextServices.shapeText(session, first(slide), slicing),
			presentationTextServices.shapeText(session, second(slide), slicing)
		])

		for (const each of found) expect(each.kind).toBe("shapeText")
	}

	it("answers two overlapping calls for the same shape", async () => {
		await both(
			slide => ({ slide, id: 2 }),
			slide => ({ slide, id: 2 })
		)
	})

	it("answers two overlapping calls for different shapes and cells", async () => {
		await both(
			slide => ({ slide, id: 2 }),
			slide => ({ slide, id: 3, cell: { row: 1, col: 2 } })
		)
		await both(
			slide => ({ slide, id: 3, cell: { row: 0, col: 1 } }),
			slide => ({ slide, id: 3, cell: { row: 1, col: 0 } })
		)
	})

	// The editor's options equal one the render laid its bodies out with, the date apart.
	async function sameOptions(context: CallContext, target: ShapeRef): Promise<void> {
		laidOut.options.length = 0

		const found = await presentationTextServices.shapeText(context.session, target, context.slicing)

		if (found.kind !== "shapeText") throw new Error(found.kind)

		expect(laidOut.options.length).toBeGreaterThan(0)
		expect(laidOut.options).toContainEqual({ ...found.options, fields: { ...found.options.fields, now: expect.any(Date) } })
	}

	// The second slide, rendered first when its shapes are looked up (a render keeps the cells it laid out).
	async function opened(bytes: Uint8Array, format: Format = "pptx", render = true): Promise<{ context: CallContext; slide: SlideRef }> {
		const context = await openDeck(bytes, undefined, format)
		const slide = context.session.deck.slides[1] as SlideRef

		if (render) await renderSlideFor(context, slide)

		return { context, slide }
	}

	it("lays a shape, a cell and a notes body out with the render's options (pptx)", async () => {
		const bytes = buildPptx({
			slides: [
				{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("First"))) },
				{
					shapes:
						sp(2, "Title 1", 'type="title"', "", body(para("Second"))) +
						tableFrame(3, [
							["A1", "B1"],
							["A2", "B2"]
						]),
					notes: para("Speaker notes")
				}
			]
		})

		const shape = await opened(bytes)

		await sameOptions(shape.context, { slide: shape.slide, id: 2 })

		const cell = await opened(bytes, "pptx", false)

		await sameOptions(cell.context, { slide: cell.slide, id: 3, cell: { row: 1, col: 1 } })

		const notes = await opened(bytes)
		const target = notesTarget(notes.context.session.deck, notes.slide)

		if (target === undefined) throw new Error("no notes body")

		await sameOptions(notes.context, target)
	})

	it("lays a shape out with the render's options (odp)", async () => {
		const bytes = odpBytes({
			body:
				page("") +
				page(
					'<draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Second</text:p></draw:text-box></draw:frame>'
				)
		})
		const { context, slide } = await opened(bytes, "odp")
		const shape = context.session.deck.nodes.get(slide)?.shapes.find(each => each.text !== undefined)

		if (shape === undefined) throw new Error("no text shape")

		await sameOptions(context, { slide, id: shape.id })
	})
})
