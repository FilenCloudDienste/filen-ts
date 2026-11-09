// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/displayList"
import type { Effect, ShapeNode } from "../core/presentation/model"
import type { SlideRender } from "../core/presentation/output"
import { renderSlide } from "../core/presentation/render/slide"
import { paintSlideCanvas } from "../dom/presentation/thumbs"
import { paintSlide } from "../react/presentation/paint/slide"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"
import { SLIDE, THEME, THEME_PART, body, deckOf, renderServices, xfrm } from "./fixtures/presentation/renderDeck"
import { RecordingCanvas } from "./presentationCanvasRecorder"

// Shape effects as PowerPoint draws them: on the text of a shape with no fill or line (its first outer shadow too),
// on the drawing otherwise; inner shadows and soft edges as an SVG filter the drawing references.

const SLICING = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }
const EFFECTS: readonly Effect[] = [
	{ kind: "outerShdw", color: { kind: "srgb", rgb: "000000" }, blurRad: 38100, dist: 38100, dir: 2700000 },
	{ kind: "glow", color: { kind: "srgb", rgb: "FFC000" }, rad: 63500 },
	{ kind: "reflection", blurRad: 0, stA: 50000, endA: 0, endPos: 60000, dist: 0, dir: 5400000 }
]

function shape(id: number, filled: boolean): ShapeNode {
	return {
		id,
		name: "Text",
		hidden: false,
		kind: "sp",
		xfrm: xfrm(0, 0, 1_905_000, 952_500),
		props: {
			effects: { effects: EFFECTS },
			...(filled ? { fill: { kind: "solid" as const, color: { kind: "srgb" as const, rgb: "336699" } } } : {})
		},
		text: body("Shadowed title")
	}
}

async function rendered(filled: boolean): Promise<SlideRender> {
	const fixture = renderServices({ parts: { [THEME_PART]: THEME } })

	return renderSlide(deckOf([], [], [shape(2, filled)]), SLIDE, fixture.services, SLICING)
}

function context(): Parameters<typeof paintSlide>[1] {
	return { document, session: undefined, signal: { aborted: false } }
}

describe("effects of a shape with no fill or line", () => {
	it("keep the first outer shadow and are marked for the text", async () => {
		const layer = (await rendered(false)).layers[0]

		expect(layer?.effectsOnText).toBe(true)
		expect(layer?.effects?.map(effect => effect.kind)).toEqual(["outerShadow", "glow", "reflection"])
	})

	it("stay on a filled shape's drawing, which carries its first outer shadow", async () => {
		const layer = (await rendered(true)).layers[0]

		expect(layer?.effectsOnText).toBeUndefined()
		expect(layer?.effects?.map(effect => effect.kind)).toEqual(["glow", "reflection"])
	})

	it("are drawn on the text holder, with an inert mirrored copy of the text", async () => {
		const root = paintSlide(await rendered(false), context()).root as HTMLElement
		const holder = root.querySelector<HTMLElement>(".fo-slide-layer > .fo-slide-text")
		const copy = root.querySelector<HTMLElement>(".fo-slide-reflection .fo-slide-reflection-text")

		// The first outer shadow (3 px at 45 degrees), which no drawing item carries.
		expect(holder?.style.filter).toMatch(/^drop-shadow\(2\.828\d*px 2\.828\d*px 2px rgba\(0,0,0,1\)\)/u)
		expect(holder?.style.filter).toContain("rgba(255,192,0,1)")
		expect(root.querySelector<HTMLElement>(".fo-slide-drawing")?.style.filter ?? "").toBe("")
		expect(copy?.textContent).toContain("Shadowed title")
		expect(copy?.hasAttribute("inert")).toBe(true)
		expect(copy?.style.pointerEvents).toBe("none")
		// The editor's text holder is the layer's direct child; the copy never is.
		expect(root.querySelectorAll(".fo-slide-layer > .fo-slide-text")).toHaveLength(1)
	})

	it("stay on a filled shape's drawing when painted", async () => {
		const root = paintSlide(await rendered(true), context()).root as HTMLElement

		expect(root.querySelector<HTMLElement>(".fo-slide-drawing")?.style.filter).toContain("drop-shadow(0 0")
		expect(root.querySelector<HTMLElement>(".fo-slide-text")?.style.filter ?? "").toBe("")
		expect(root.querySelector(".fo-slide-reflection-text")).toBeNull()
		expect(root.querySelectorAll(".fo-slide-reflection svg")).toHaveLength(1)
	})

	it("cast on the text on a canvas only when the shape draws nothing", async () => {
		const shadowedText = (render: SlideRender): number => {
			const ctx = new RecordingCanvas(192, 108)

			paintSlideCanvas(ctx, render, 0.1, { image: () => undefined })

			return ctx.calls.filter(call => call.op === "fillText" && call.shadow[0] !== "rgba(0, 0, 0, 0)").length
		}

		expect(shadowedText(await rendered(false))).toBeGreaterThan(0)
		expect(shadowedText(await rendered(true))).toBe(0)
	})
})

describe("inner shadows and soft edges", () => {
	function effected(effects: NonNullable<SlideRender["layers"][number]["effects"]>): HTMLElement {
		const render = fixtureSlideRender(fixtureDeck(), 0)
		const layer = render.layers[2] as SlideRender["layers"][number]

		return paintSlide({ ...render, layers: [{ ...layer, effects }] }, context()).root as HTMLElement
	}

	it("draw as an SVG filter the drawing references before its CSS filters", () => {
		const root = effected([
			{ kind: "innerShadow", color: rgba("000000", 0.5), blur: 8, dx: 2, dy: 3, sx: 1, sy: 1 },
			{ kind: "softEdge", radius: 10 },
			{ kind: "glow", color: rgba("FFC000"), radius: 4 }
		])
		const filter = root.querySelector("filter")
		const id = filter?.getAttribute("id") ?? ""
		const primitives = [...(filter?.children ?? [])].map(child => child.localName)

		expect(id).not.toBe("")
		expect(root.querySelector<HTMLElement>(".fo-slide-drawing")?.style.filter).toBe(
			`url(#${id}) drop-shadow(0 0 4px rgba(255,192,0,1))`
		)
		expect(primitives).toEqual([
			"feOffset",
			"feGaussianBlur",
			"feComponentTransfer",
			"feFlood",
			"feComposite",
			"feComposite",
			"feMerge",
			"feMorphology",
			"feGaussianBlur",
			"feComposite"
		])
		expect(filter?.querySelector("feOffset")?.getAttribute("dx")).toBe("2")
		expect(filter?.querySelector("feOffset")?.getAttribute("dy")).toBe("3")
		expect(filter?.querySelector("feFlood")?.getAttribute("flood-opacity")).toBe("0.502")
		expect(filter?.querySelector("feMorphology")?.getAttribute("radius")).toBe("5")
		// The soft edge masks the inner-shadowed graphic.
		expect(filter?.lastElementChild?.getAttribute("in")).toBe("inner")
	})

	it("feather a soft-edged picture alone, and add nothing for none", () => {
		const root = effected([{ kind: "softEdge", radius: 6 }])
		const filter = root.querySelector("filter")

		expect([...(filter?.children ?? [])].map(child => child.localName)).toEqual(["feMorphology", "feGaussianBlur", "feComposite"])
		expect(filter?.lastElementChild?.getAttribute("in")).toBe("SourceGraphic")
		expect(effected([{ kind: "blur", radius: 2 }]).querySelector("filter")).toBeNull()
	})
})
