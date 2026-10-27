import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import type { SlideRender } from "../core/presentation/output"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { presentationTextServices, renderSlideFor } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { HmtxMeasurer, nodeFontAssets } from "./layoutFixtures"
import { tableDeck } from "./presentationObjectsFixtures"

// A table's cells laid out while their faces were still loading are never kept for the next render: once the faces
// are loaded every cell draws in them, the first cell to ask for a face as much as the ones after it.

let loads = 0

async function context(): Promise<CallContext> {
	const outcome = await openPptxCapability.open({
		source: bytesSource(tableDeck()),
		sourceKind: "bytes",
		options: { format: "pptx", fileName: "deck.pptx" }
	})

	if (outcome.kind !== "opened") throw new Error(outcome.kind)

	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "deck.pptx" },
		services: { ...SERVICES, text: presentationTextServices },
		rangeSource: undefined,
		schedule: () => undefined,
		emit: () => undefined,
		onClose: () => undefined
	}

	return {
		session,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "priority",
		slicing: { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }
	}
}

// The face family each text style of a layer's text is drawn in (the font shorthand less its weight and size).
function families(render: SlideRender, role: string): string[] {
	return render.layers
		.filter(layer => layer.role === role && layer.text !== undefined)
		.flatMap(layer => (layer.text?.styles ?? []).map(style => style.font.replace(/^\S+ \S+ /, "")))
}

beforeAll(() => {
	installPresentationRealm({
		text: {
			fontHost: {
				addBytes: async () => {
					loads++
					await new Promise(resolve => setTimeout(resolve, 10))

					return true
				},
				addLocal: () => Promise.resolve(false),
				remove: () => undefined
			},
			replayFonts: true,
			fontAssets: nodeFontAssets,
			measurer: new HmtxMeasurer(),
			yield: () => Promise.resolve()
		},
		canvas: {
			canvas: () => undefined,
			decode: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(undefined),
			fontsReady: () => Promise.resolve()
		}
	})
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe("table cells and faces", () => {
	it("draws every cell in the loaded face, none in a layout made before the face loaded", async () => {
		const h = await context()
		const ref = h.session.deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		const first = await renderSlideFor(h, ref)
		const second = await renderSlideFor(h, ref)
		// The title is laid out on every render: the face the deck's text resolves to once loaded.
		const [face] = families(first, "placeholder")

		expect(loads).toBeGreaterThan(0)
		expect(face).toMatch(/^"/)
		expect(families(first, "table")).toHaveLength(12)
		expect(new Set(families(first, "table"))).toEqual(new Set([face]))
		expect(families(second, "table")).toEqual(families(first, "table"))
	})
})
