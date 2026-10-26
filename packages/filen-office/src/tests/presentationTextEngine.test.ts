import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { rgba } from "../core/drawingml/index"
import { PresentationError, refused, slideRef } from "../core/presentation/model"
import { MeasureCache } from "../core/text/index"
import { SERVICES, type EngineServices, type EngineSession } from "../dom/presentation/engine"
import { layoutShapeText, type ShapeTextContext, type TextServices } from "../dom/presentation/engine/text"
import { fixtureBody, fixtureDeck } from "./fixtures/presentation/deck"
import { FakeMeasurer, testFont } from "./textFixtures"

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
		).rejects.toBeInstanceOf(PresentationError)
	})
})
