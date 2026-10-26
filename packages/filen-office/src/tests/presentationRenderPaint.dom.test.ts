// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { DrawingList, IDENTITY, ItemKind, rgba } from "../core/drawingml/displayList"
import type { SlideRender } from "../core/presentation/output"
import { drawingData, renderSlide } from "../core/presentation/render/slide"
import type { PresentationSessionApi } from "../dom/presentation/protocol"
import { paintSlide, releaseSlidePictures, SLIDE_PICTURE_BYTES, slidePictureCount } from "../react/presentation/paint/slide"
import type { PaintedSlide, SlidePaintContext, SlidePainter } from "../react/presentation/SlideView"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"
import { fixtureTextPage } from "./fixtures/presentation/textPage"
import { SLIDE, THEME, THEME_PART, deckOf, renderServices, xfrm } from "./fixtures/presentation/renderDeck"

// The slide compositor over renders from the renderer and the fixtures: one element per layer carrying its index,
// drawings placed by their matrix, text through paintPage at the text matrix (links kept), pictures loaded through
// the session and released.

const painter: SlidePainter = paintSlide

function session(images: Record<string, { bytes: Uint8Array; type: string }>): { api: PresentationSessionApi; asked: string[] } {
	const asked: string[] = []
	const api = {
		image: (part: string) => {
			asked.push(part)

			return Promise.resolve(images[part] ?? null)
		}
	} as unknown as PresentationSessionApi

	return { api, asked }
}

function context(api?: PresentationSessionApi): SlidePaintContext {
	return { document, session: api, signal: { aborted: false } }
}

async function settle(): Promise<void> {
	for (let k = 0; k < 5; k++) await Promise.resolve()
}

describe("paintSlide", () => {
	it("paints each layer as one element carrying its index, its drawing at its matrix and its text at the text matrix", () => {
		const render = fixtureSlideRender(fixtureDeck(), 0)
		const linked: SlideRender = {
			...render,
			layers: render.layers.map((layer, k) =>
				k === 0
					? {
							...layer,
							text: fixtureTextPage(["Linked title"], { link: "https://example.org/" }),
							textMatrix: [1, 0, 0, 1, 100, 50]
						}
					: layer
			)
		}
		const painted: PaintedSlide = painter(linked, context())
		const root = painted.root as HTMLElement
		const layers = [...root.querySelectorAll<HTMLElement>("[data-fo-layer]")]

		expect(root.style.width).toBe(`${String(12_192_000 / 9525)}px`)
		expect(layers.map(layer => layer.dataset["foLayer"])).toEqual(["0", "1", "2", "3"])
		// The text box relative to the layer box (the layer's matrix places that).
		expect(layers[0]?.style.transform).toBe(
			`matrix(1,0,0,1,${String(linked.layers[0]?.matrix[4])},${String(linked.layers[0]?.matrix[5])})`.replace(/(\.\d{4})\d+/g, "$1")
		)
		expect(layers[0]?.querySelector<HTMLElement>(".fo-slide-text")?.style.transform).toBe(
			`matrix(1,0,0,1,${String(Math.round((100 - (linked.layers[0]?.matrix[4] ?? 0)) * 10000) / 10000)},${String(Math.round((50 - (linked.layers[0]?.matrix[5] ?? 0)) * 10000) / 10000)})`
		)
		expect(layers[0]?.textContent).toContain("Linked title")
		expect(layers[0]?.querySelector("[data-fo-link]")?.closest<HTMLElement>("[data-fo-layer]")?.dataset["foLayer"]).toBe("0")
		expect(layers[2]?.querySelector<HTMLElement>(".fo-slide-drawing")?.getAttribute("aria-label")).toBe("A chart of the quarter")
		expect(root.querySelectorAll("svg")).toHaveLength(5)
		painted.release()
	})

	it("draws glow, blur and extra shadows as filters and a reflection as a masked mirror copy", () => {
		const render = fixtureSlideRender(fixtureDeck(), 0)
		const effected: SlideRender = {
			...render,
			layers: [
				{
					...(render.layers[2] as SlideRender["layers"][number]),
					effects: [
						{ kind: "glow", color: rgba("FFC000", 0.5), radius: 6 },
						{ kind: "blur", radius: 2 },
						{ kind: "reflection", blur: 1, startAlpha: 0.5, endAlpha: 0, endPos: 0.6, distance: 3, direction: 90 }
					]
				}
			]
		}
		const root = paintSlide(effected, context()).root as HTMLElement
		const drawing = root.querySelector<HTMLElement>(".fo-slide-drawing")

		expect(drawing?.style.filter).toBe("drop-shadow(0 0 6px rgba(255,192,0,0.502)) blur(2px)")
		expect(root.querySelectorAll(".fo-slide-reflection svg")).toHaveLength(1)
		expect(root.querySelector(".fo-slide-reflection")?.getAttribute("aria-hidden")).toBe("true")
	})

	it("loads pictures through the session, repaints the layer that shows them, shares them with later paints and revokes them with the session", async () => {
		const fixture = renderServices({ parts: { [THEME_PART]: THEME } })
		const deck = deckOf(
			[],
			[],
			[
				{
					id: 4,
					name: "Picture",
					hidden: false,
					kind: "pic",
					xfrm: xfrm(0, 0, 952500, 952500),
					props: { fill: { kind: "picture", part: "/ppt/media/image1.png" } }
				},
				{
					id: 5,
					name: "Picture",
					hidden: false,
					kind: "pic",
					xfrm: xfrm(952500, 0, 952500, 952500),
					props: { fill: { kind: "picture", part: "/ppt/media/image1.png" } }
				}
			]
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 })
		const { api, asked } = session({ "/ppt/media/image1.png": { bytes: new Uint8Array([137, 80, 78, 71]), type: "image/png" } })
		const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture/1")
		const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
		const painted = paintSlide(render, context(api))

		expect(painted.root.querySelectorAll("image[href^='blob:']")).toHaveLength(0)

		await settle()

		expect(asked).toEqual(["/ppt/media/image1.png"])
		expect(created).toHaveBeenCalledTimes(1)
		expect(painted.root.querySelectorAll("image")).toHaveLength(2)
		expect([...painted.root.querySelectorAll("image")].every(image => image.getAttribute("href") === "blob:fixture/1")).toBe(true)

		painted.release()

		// Kept for the next paint of the session (the next slide, the show): drawn in its first pass, never asked again.
		expect(revoked).not.toHaveBeenCalled()

		const again = paintSlide(render, context(api))

		expect([...again.root.querySelectorAll("image")].every(image => image.getAttribute("href") === "blob:fixture/1")).toBe(true)
		await settle()
		expect(asked).toEqual(["/ppt/media/image1.png"])
		expect(created).toHaveBeenCalledTimes(1)

		again.release()
		releaseSlidePictures(api)

		expect(revoked).toHaveBeenCalledWith("blob:fixture/1")
		expect(slidePictureCount(api)).toBe(0)
	})

	it("keeps pictures no paint shows within the byte budget, the least recently used revoked first", async () => {
		const fixture = renderServices({ parts: { [THEME_PART]: THEME } })
		const parts = [1, 2, 3].map(n => `/ppt/media/image${String(n)}.png`)
		const deck = deckOf(
			[],
			[],
			parts.map((part, index) => ({
				id: 4 + index,
				name: "Picture",
				hidden: false,
				kind: "pic" as const,
				xfrm: xfrm(index * 952500, 0, 952500, 952500),
				props: { fill: { kind: "picture" as const, part } }
			}))
		)
		const render = await renderSlide(deck, SLIDE, fixture.services, { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 })
		// Each a little over a third of the budget: two fit once no paint shows them, three do not.
		const bytes = new Uint8Array(Math.ceil(SLIDE_PICTURE_BYTES / 3) + 1)
		const { api } = session(Object.fromEntries(parts.map(part => [part, { bytes, type: "image/png" }])))

		vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:fixture/${String(Math.random())}`)

		const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
		const painted = paintSlide(render, context(api))

		await settle()
		expect(slidePictureCount(api)).toBe(3)

		const first = painted.root.querySelector("image")?.getAttribute("href")

		painted.release()

		expect(revoked).toHaveBeenCalledTimes(1)
		expect(revoked).toHaveBeenCalledWith(first)
		expect(slidePictureCount(api)).toBe(2)
		releaseSlidePictures(api)
		expect(revoked).toHaveBeenCalledTimes(3)
	})

	it("never shows a picture whose bytes are not a natively shown type, and asks for nothing once aborted", async () => {
		const render = fixtureSlideRender(fixtureDeck(), 0)
		const { api, asked } = session({ "/ppt/media/image1.png": { bytes: new Uint8Array([1]), type: "image/x-emf" } })
		const created = vi.spyOn(URL, "createObjectURL")

		paintSlide(render, { document, session: api, signal: { aborted: true } })
		await settle()

		expect(asked).toEqual([])

		paintSlide(render, context(api))
		await settle()

		expect(created).not.toHaveBeenCalled()
	})

	it("sizes every drawing holder to its frame, so each SVG draws at the layer's frame size", () => {
		const render = fixtureSlideRender(fixtureDeck(), 0)
		const root = paintSlide(render, context()).root as HTMLElement
		const background = root.querySelector<HTMLElement>(".fo-slide-background")

		expect(background?.style.width).toBe(`${String(render.background.width)}px`)
		expect(background?.style.height).toBe(`${String(render.background.height)}px`)

		const holders = [...root.querySelectorAll<HTMLElement>(".fo-slide-drawing")]

		expect(holders).toHaveLength(render.layers.length)
		holders.forEach((holder, k) => {
			const drawing = render.layers[k]?.drawing

			expect(Number.parseFloat(holder.style.width)).toBeCloseTo(drawing?.width ?? -1, 4)
			expect(Number.parseFloat(holder.style.height)).toBeCloseTo(drawing?.height ?? -1, 4)
		})
	})

	it("draws every SVG as a block, so a drawing shorter than a text line is not moved down to the baseline", () => {
		const render = fixtureSlideRender(fixtureDeck(), 0)
		const root = paintSlide(render, context()).root as HTMLElement
		const svgs = [...root.querySelectorAll<SVGElement>(".fo-slide-drawing > svg, .fo-slide-background > svg")]

		expect(svgs.length).toBeGreaterThan(0)
		expect(svgs.every(svg => svg.style.display === "block")).toBe(true)
	})

	it("draws a line with a zero-height frame with its stroke: at least 1 px high, in unscaled units", () => {
		const list = new DrawingList()

		list.width = 200
		list.height = 0

		const stroke = list.stroke({
			width: 3,
			paint: list.paint({ kind: "solid", color: rgba("008080") }),
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
		list.lineTo(200, 0)
		list.addItem(ItemKind.PATH, IDENTITY, 0, 0, 200, 0, firstCommand, firstCoord, -1, stroke, -1, -1, 0, 0)

		const render = fixtureSlideRender(fixtureDeck(), 0)
		const line: SlideRender = {
			...render,
			layers: [{ ...(render.layers[0] as SlideRender["layers"][number]), drawing: drawingData(list), matrix: [1, 0, 0, 1, 10, 20] }]
		}
		const root = paintSlide(line, context()).root as HTMLElement
		const holder = root.querySelector<HTMLElement>(".fo-slide-drawing")
		const svg = holder?.querySelector("svg")

		expect(holder?.style.width).toBe("200px")
		expect(holder?.style.height).toBe("1px")
		expect(svg?.getAttribute("width")).toBe("200")
		expect(svg?.getAttribute("height")).toBe("1")
		expect(svg?.getAttribute("viewBox")).toBe("0 0 200 1")
		expect(svg?.getAttribute("overflow")).toBe("visible")
		expect(svg?.querySelector("path")?.getAttribute("stroke-width")).toBe("3")
	})

	it("hands the text page's paint tables to paintPage, so a gradient-filled, outlined run draws them", () => {
		const render = fixtureSlideRender(fixtureDeck(), 0)
		const decorated: SlideRender = {
			...render,
			layers: [{ ...(render.layers[0] as SlideRender["layers"][number]), text: fixtureTextPage(["Gradient"], { decorated: [0] }) }]
		}
		const root = paintSlide(decorated, context()).root as HTMLElement
		const span = [...root.querySelectorAll<HTMLElement>(".fo-slide-text span")].find(element => element.textContent === "Gradient")

		expect(span?.style.cssText).toContain("gradient")
	})

	it("gives each layer box its drawing's size and place, and its SVG a non-zero size", () => {
		const render = fixtureSlideRender(fixtureDeck(), 0)
		const root = paintSlide(render, context()).root as HTMLElement

		render.layers.forEach((layer, k) => {
			const box = root.querySelector<HTMLElement>(`[data-fo-layer="${String(k)}"]`)
			const svg = box?.querySelector(".fo-slide-drawing svg")

			expect(Number.parseFloat(box?.style.width ?? "")).toBeCloseTo(layer.drawing.width, 4)
			expect(Number.parseFloat(box?.style.height ?? "")).toBeCloseTo(layer.drawing.height, 4)
			expect(box?.style.transform).toContain(`,${String(Math.round((layer.matrix[4] ?? 0) * 10000) / 10000)},`)
			expect(Number(svg?.getAttribute("width"))).toBeGreaterThan(0)
			expect(Number(svg?.getAttribute("height"))).toBeGreaterThan(0)
		})
	})
})
