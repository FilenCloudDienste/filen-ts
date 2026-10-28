// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { slideRef } from "../core/presentation/model"
import type { SlideLayer, SlideRender } from "../dom/presentation/protocol"
import { SlideView, type SlidePainter } from "../react/presentation/SlideView"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"

// A new render of the slide shown updates the painted slide in place: a layer that paints alike keeps its element
// (moved by its new matrix), only changed layers go through the painter again, a layer gone takes its element out,
// and a paint is released with the last of its layers.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const SIZE = { cx: 12_192_000, cy: 6_858_000 }
const REF = slideRef(10)

interface Paint {
	readonly layers: number
	released: boolean
}

let root: Root
let host: HTMLDivElement
let paints: Paint[]

// A background, then each layer as an element placed by its matrix (as the slide compositor draws them).
const painter: SlidePainter = (render, context) => {
	const document = context.document
	const slide = document.createElement("div")
	const background = document.createElement("div")
	const paint: Paint = { layers: render.layers.length, released: false }

	slide.append(background)
	render.layers.forEach((layer, index) => {
		const element = document.createElement("div")
		const [a, b, c, d, e, f] = layer.matrix

		element.dataset["foLayer"] = String(index)
		element.dataset["shape"] = String(layer.shape.id)
		element.style.transform = `matrix(${[a, b, c, d, e, f].map(String).join(",")})`
		slide.append(element)
	})
	paints.push(paint)

	return {
		root: slide,
		release: () => {
			paint.released = true
		}
	}
}

function base(): SlideRender {
	return { ...fixtureSlideRender(fixtureDeck(1), 0), ref: REF, index: 0, revision: 0 }
}

function moved(layer: SlideLayer, dx: number): SlideLayer {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = layer.matrix
	const text = layer.textMatrix

	return {
		...layer,
		matrix: [a, b, c, d, e + dx, f],
		...(text === undefined
			? {}
			: { textMatrix: [text[0] ?? 1, text[1] ?? 0, text[2] ?? 0, text[3] ?? 1, (text[4] ?? 0) + dx, text[5] ?? 0] })
	}
}

function show(render: SlideRender | undefined): void {
	act(() =>
		root.render(
			<SlideView
				render={render}
				size={SIZE}
				painter={painter}
				label="s"
			/>
		)
	)
}

function layerElements(): HTMLElement[] {
	return [...host.querySelectorAll<HTMLElement>(".fo-slide-content [data-fo-layer]")]
}

beforeEach(() => {
	paints = []
	host = document.createElement("div")
	document.body.append(host)
	root = createRoot(host)
})

afterEach(() => {
	act(() => root.unmount())
	host.remove()
})

describe("a painted slide across renders", () => {
	it("moves a layer that paints alike by its matrix, without painting it again", () => {
		const first = base()

		show(first)

		const before = layerElements()
		const layer = first.layers[1]

		if (layer === undefined) throw new Error("fixture")

		show({ ...first, revision: 1, layers: first.layers.map((each, index) => (index === 1 ? moved(each, 40) : each)) })

		const after = layerElements()

		expect(paints).toHaveLength(1)
		expect(after).toEqual(before)
		expect(after[1]?.style.transform.replace(/\s/gu, "")).toContain(`,${String((layer.matrix[4] ?? 0) + 40)},`)
	})

	it("paints again only the layers that changed, and keeps the slide's order", () => {
		const first = base()

		show(first)

		const before = layerElements()
		const changed = first.layers.map((layer, index) =>
			index === 0 ? { ...layer, drawing: { ...layer.drawing, width: layer.drawing.width + 1 } } : layer
		)

		show({ ...first, revision: 1, layers: changed })

		const after = layerElements()

		expect(paints.map(paint => paint.layers)).toEqual([first.layers.length, 1])
		expect(after[0]).not.toBe(before[0])
		expect(after.slice(1)).toEqual(before.slice(1))
		expect(after.map(element => element.dataset["foLayer"])).toEqual(first.layers.map((_, index) => String(index)))

		// The repainted layer changes again: its paint goes with it, the first (which holds the background) stays.
		show({ ...first, revision: 2, layers: first.layers })
		expect(paints.map(paint => paint.released)).toEqual([false, true, false])
	})

	it("takes out a layer that is gone and renumbers the rest", () => {
		const first = base()

		show(first)

		const before = layerElements()

		show({ ...first, revision: 1, layers: first.layers.slice(1) })

		const after = layerElements()

		expect(paints).toHaveLength(1)
		expect(after).toEqual(before.slice(1))
		expect(after.map(element => element.dataset["foLayer"])).toEqual(first.layers.slice(1).map((_, index) => String(index)))
	})

	it("paints a layer again rather than move it under someone else's transform", () => {
		const first = base()

		show(first)

		const element = layerElements()[1]

		if (element === undefined) throw new Error("fixture")

		// A drag's preview.
		element.style.transform = "matrix(1,0,0,1,999,0)"
		show({ ...first, revision: 1, layers: first.layers.map((each, index) => (index === 1 ? moved(each, 40) : each)) })

		expect(layerElements()[1]).not.toBe(element)
		expect(paints.map(paint => paint.layers)).toEqual([first.layers.length, 1])
	})

	it("paints a slide whole when its background or the slide changes, releasing the old paints", () => {
		const first = base()

		show(first)
		show({ ...first, revision: 1, background: { ...first.background, width: first.background.width + 1 } })
		show({ ...first, ref: slideRef(11), index: 1 })
		show(undefined)

		expect(paints.map(paint => paint.released)).toEqual([true, true, true])
		expect(layerElements()).toHaveLength(0)
	})
})
