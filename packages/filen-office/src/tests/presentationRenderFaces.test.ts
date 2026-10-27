import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import type { SlideRender } from "../core/presentation/output"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { presentationTextServices, renderSlideFor } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { HmtxMeasurer, nodeFontAssets } from "./layoutFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// Renders of a slide whose faces are not loaded yet lay its text out again once they are: every render that asked for
// them, also one that finished while another render was already loading them, never one in the fallback face.

const RECT = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
const WORDS = "Fly in by level one by one, then the second level and the third, each paragraph on its own click"
let loads = 0
let loaded = 0

function deck(): Uint8Array {
	return buildPptx({
		slides: [{ shapes: sp(4, "Words", undefined, `${xfrm(914400, 914400, 2743200, 2743200)}${RECT}`, body(para(WORDS))) }]
	})
}

async function context(): Promise<CallContext> {
	const outcome = await openPptxCapability.open({
		source: bytesSource(deck()),
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

// What a render's text says about the face it was laid out in: every text page's fragment positions.
function laidOut(render: SlideRender): string {
	return JSON.stringify(render.layers.map(layer => (layer.text === undefined ? null : [...layer.text.page.fragmentFloats])))
}

beforeAll(() => {
	installPresentationRealm({
		text: {
			// Faces load slowly: a second render finishes while the first one is still loading them.
			fontHost: {
				addBytes: async () => {
					loads++
					await new Promise(resolve => setTimeout(resolve, 30))
					loaded++

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

describe("presentation renders and faces", () => {
	it("lays both of two racing renders out in the loaded face", async () => {
		const h = await context()
		const ref = h.session.deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		// Each render notes how many faces had finished loading when it answered.
		const answered = (render: SlideRender) => ({ render, loaded })
		const [first, second] = await Promise.all([renderSlideFor(h, ref).then(answered), renderSlideFor(h, ref).then(answered)])
		const settled = await renderSlideFor(h, ref)

		expect(loads).toBeGreaterThan(0)
		// Neither answered before the faces it asked for were loaded, and both are laid out as a later render is.
		expect([first.loaded, second.loaded]).toEqual([loads, loads])
		expect(laidOut(first.render)).toBe(laidOut(settled))
		expect(laidOut(second.render)).toBe(laidOut(settled))
	})
})
