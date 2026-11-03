// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { DrawingList, IDENTITY, ItemKind } from "../core/drawingml/displayList"
import type { SlideRender } from "../core/presentation/output"
import { drawingData } from "../core/presentation/render/slide"
import type { PresentationSessionApi } from "../dom/presentation/protocol"
import { paintSlide } from "../react/presentation/paint/slide"
import { decodePng } from "./oracles/presentation/pixel"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"

// A Gouraud mesh (a 3D scene) on the slide canvas: rasterised once at the size it is drawn and shown as an image
// clipped to the mesh's outline, its corners in their own colours, not one flat fill.

// One drawing of `count` small gradient triangles, one shaded paint each (as an EMF's GradientFill records come), or
// of one mesh of `count` triangles over the whole drawing.
function trianglesLayer(count: number, oneMesh = false): SlideRender["layers"][number] {
	const list = new DrawingList()
	const side = Math.ceil(Math.sqrt(count))

	list.width = side * 5
	list.height = side * 5

	const add = (points: Float32Array, colors: Uint32Array, x: number, y: number, w: number, h: number): void => {
		const firstCommand = list.commandCount
		const firstCoord = list.coordCount

		list.moveTo(x, y)
		list.lineTo(x + w, y)
		list.lineTo(x, y + h)
		list.close()
		list.addItem(
			ItemKind.PATH,
			IDENTITY,
			x,
			y,
			w,
			h,
			firstCommand,
			firstCoord,
			list.paint({ kind: "shaded", points, colors, ramp: null }),
			-1,
			-1,
			-1,
			0,
			0
		)
	}
	const triangle = (t: number): number[] => {
		const x = (t % side) * 5
		const y = Math.floor(t / side) * 5

		return [x, y, x + 4, y, x, y + 4]
	}

	if (oneMesh) {
		const points = new Float32Array(count * 6)

		for (let t = 0; t < count; t++) points.set(triangle(t), t * 6)

		add(points, new Uint32Array(count * 3).fill(0x336699ff), 0, 0, side * 5, side * 5)
	} else {
		for (let t = 0; t < count; t++) {
			const [x = 0, y = 0] = triangle(t)

			add(Float32Array.from(triangle(t)), Uint32Array.of(0xff0000ff, 0x00ff00ff, 0x0000ffff), x, y, 4, 4)
		}
	}

	const base = fixtureSlideRender(fixtureDeck(), 0).layers[0] as SlideRender["layers"][number]
	const { text: _text, textMatrix: _matrix, ...layer } = base

	return { ...layer, drawing: drawingData(list), matrix: [1, 0, 0, 1, 0, 0] }
}

function meshLayer(size = 100): SlideRender["layers"][number] {
	const list = new DrawingList()

	list.width = size
	list.height = size

	const points = Float32Array.of(0, 0, size, 0, 0, size)
	const colors = Uint32Array.of(0xff0000ff, 0x00ff00ff, 0x0000ffff)
	const firstCommand = list.commandCount
	const firstCoord = list.coordCount

	list.moveTo(0, 0)
	list.lineTo(size, 0)
	list.lineTo(0, size)
	list.close()
	list.addItem(
		ItemKind.PATH,
		IDENTITY,
		0,
		0,
		size,
		size,
		firstCommand,
		firstCoord,
		list.paint({ kind: "shaded", points, colors, ramp: null }),
		-1,
		-1,
		-1,
		0,
		0
	)

	const base = fixtureSlideRender(fixtureDeck(), 0).layers[0] as SlideRender["layers"][number]
	const { text: _text, textMatrix: _matrix, ...layer } = base

	return { ...layer, drawing: drawingData(list), matrix: [1, 0, 0, 1, 10, 10] }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("shaded paints on the slide canvas", () => {
	it("shows a mesh as a raster of its corner colours, made once and revoked with the paint", async () => {
		const blobs: Blob[] = []
		const created = vi.spyOn(URL, "createObjectURL").mockImplementation(blob => {
			blobs.push(blob as Blob)

			return `blob:mesh/${String(blobs.length)}`
		})
		const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
		const render = { ...fixtureSlideRender(fixtureDeck(), 0), layers: [meshLayer()] }
		const painted = paintSlide(render, { document, session: undefined, signal: { aborted: false } })
		const image = (painted.root as HTMLElement).querySelector(".fo-slide-drawing image")

		// Rasterised after the paint's own task.
		expect(image?.getAttribute("href")).toBeNull()
		await vi.waitFor(() => expect(image?.getAttribute("href")).toBe("blob:mesh/1"))
		expect(created).toHaveBeenCalledTimes(1)

		const raster = decodePng(new Uint8Array(await (blobs[0] as Blob).arrayBuffer()))
		const at = (x: number, y: number): number[] =>
			Array.from(raster.data.subarray((y * raster.width + x) * 4, (y * raster.width + x) * 4 + 3))

		// Near the red corner red dominates, near the green one green.
		expect(at(1, 1)[0]).toBeGreaterThan(200)
		expect(at(raster.width - 4, 1)[1]).toBeGreaterThan(200)

		painted.release()

		expect(revoked).toHaveBeenCalledWith("blob:mesh/1")
	})

	it("shows 20,000 gradient triangles of one drawing as one item: one raster clipped to one path of their outlines", async () => {
		let urls = 0

		vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:mesh/${String(++urls)}`)
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

		const render = { ...fixtureSlideRender(fixtureDeck(), 0), layers: [trianglesLayer(20_000)] }
		const painted = paintSlide(render, { document, session: undefined, signal: { aborted: false } })
		const root = painted.root as HTMLElement
		const images = [...root.querySelectorAll(".fo-slide-drawing image")]
		const clips = [...root.querySelectorAll(".fo-slide-drawing clipPath")]

		expect(images).toHaveLength(1)
		expect(clips).toHaveLength(1)
		// The triangles' outlines are one path.
		expect(clips[0]?.children).toHaveLength(1)
		expect(urls).toBe(0)
		await vi.waitFor(() => expect(images[0]?.getAttribute("href")).toBe("blob:mesh/1"), { timeout: 60_000 })
		expect(urls).toBe(1)
		painted.release()
	}, 120_000)

	it("rasterises a large mesh in slices a macrotask apart, never in one long task", async () => {
		const gaps: number[] = []
		let last = performance.now()
		let turns = true
		const watch = (): void => {
			const now = performance.now()

			gaps.push(now - last)
			last = now

			if (turns) setTimeout(watch, 0)
		}
		const render = { ...fixtureSlideRender(fixtureDeck(), 0), layers: [trianglesLayer(200_000, true)] }

		vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:mesh/1")
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
		setTimeout(watch, 0)

		const painted = paintSlide(render, { document, session: undefined, signal: { aborted: false } })
		const image = (painted.root as HTMLElement).querySelector(".fo-slide-drawing image")

		await vi.waitFor(() => expect(image?.getAttribute("href")).toBe("blob:mesh/1"), { timeout: 60_000 })
		turns = false
		// The timer ran between slices: no gap the size of the whole raster (the PNG's encoding here, without a canvas,
		// is the one step that runs whole).
		expect(gaps.length).toBeGreaterThan(3)
		painted.release()
	}, 120_000)

	it("shares a paint's pixel budget among all its meshes, so the last painted (on top) is not the one left flat", async () => {
		vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:mesh/1")
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

		// Sixteen meshes of 2,000 x 2,000 px, each wanting a whole raster, together twice the paint's budget.
		const layers = Array.from({ length: 16 }, () => meshLayer(2000))
		const render = { ...fixtureSlideRender(fixtureDeck(), 0), layers }
		const painted = paintSlide(render, { document, session: undefined, signal: { aborted: false } })
		const images = [...(painted.root as HTMLElement).querySelectorAll(".fo-slide-drawing image")]

		expect(images).toHaveLength(16)
		await vi.waitFor(() => expect(images.every(image => image.getAttribute("href") === "blob:mesh/1")).toBe(true), {
			timeout: 100_000
		})
		painted.release()
	}, 120_000)

	it("asks the session's worker for a mesh's raster and shows its PNG, making none on the page", async () => {
		const asked: [number, number, number][] = []
		const png = new Blob([new Uint8Array(8)], { type: "image/png" })
		const session = {
			shade: (meshes: readonly unknown[], scale: number, maxPixels: number) => {
				asked.push([meshes.length, scale, maxPixels])

				return Promise.resolve({ png, bounds: [0, 0, 100, 100] as const })
			}
		} as unknown as PresentationSessionApi
		const created = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:worker/1")

		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

		const render = { ...fixtureSlideRender(fixtureDeck(), 0), layers: [meshLayer()] }
		const painted = paintSlide(render, { document, session, signal: { aborted: false } })
		const image = (painted.root as HTMLElement).querySelector(".fo-slide-drawing image")

		await vi.waitFor(() => expect(image?.getAttribute("href")).toBe("blob:worker/1"))
		expect(asked).toEqual([[1, 1, 2048 * 1024]])
		expect(created).toHaveBeenCalledWith(png)
		painted.release()
	})
})
