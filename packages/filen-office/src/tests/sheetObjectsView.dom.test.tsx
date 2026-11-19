// @vitest-environment happy-dom

import { act, useSyncExternalStore } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { rasterOpaque } from "../core/docx/objects/images"
import { DocxMediaCache } from "../react/docx/media"
import { SheetObjects, type SheetObjectSource } from "../react/sheet/drawings/SheetObjects"
import { SheetGridModel } from "../react/sheet/model"
import type { SheetGridHandle } from "../react/sheet/SheetGrid"
import { createGridAxis } from "../react/sheet/axis"
import { gridView } from "../react/sheet/view"
import { KEPT, SOLD, barChart, chartFixture } from "./sheetChartFixtures"
import { CHART_FRAME, DRAWINGS, DRAWINGS_BYTES, PNG, bitmapEmf, withMedia, wsDr } from "./sheetDrawingsFixtures"
import { SheetSessionClosedError } from "../dom/sheet/client"
import { inThreadSheetHost } from "../dom/sheet/host"
import type { DrawingAnchor } from "../core/xlsx/drawings/anchor"
import type { SheetDrawingObject } from "../core/xlsx/drawings/feature"
import { IMMEDIATE, buildFixture, cells } from "./sheetSessionFixtures"

// Objects over the grid: pictures drawn with their bitmaps (a metafile's own too), a picture's media kept lent until
// the drawing replacing it shows, and a group holding a chart drawn again only when its chart's data changed.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

let root: Root | null = null

afterEach(() => {
	if (root !== null) act(() => root?.unmount())
	root = null
	document.body.replaceChildren()
	vi.restoreAllMocks()
})

const flush = async (): Promise<void> => {
	for (let k = 0; k < 10; k++) await act(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
}

interface ShownOptions {
	readonly onMove?: (object: SheetDrawingObject, anchor: DrawingAnchor) => Promise<boolean>
}

async function shown(
	bytes: Uint8Array,
	options: ShownOptions = {}
): Promise<{ model: SheetGridModel; container: HTMLElement; scroll: { top: number; width: number; height: number } }> {
	const scroll = { top: 0, width: 800, height: 600 }
	let model: SheetGridModel | null = null
	const opened = await inThreadSheetHost().open(bytes.slice(), { kind: "xlsx", slicing: IMMEDIATE }, event => model?.handleEvent(event))

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const { session, info } = opened

	model = new SheetGridModel({ source: session, edit: session, info })

	// The drawing is read beside the sheet: its layout comes in an event.
	for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))

	// The grid's frames: schedule draws one, which calls the frame listeners; a change the model reports draws one too.
	const frames = new Set<() => void>()
	let frame = 0
	const handle = {
		renderer: {
			schedule: () => {
				if (frame !== 0) return

				frame = requestAnimationFrame(() => {
					frame = 0

					for (const listener of frames) listener()
				})
			},
			currentView: () => {
				const axes = model.axes(0)
				const layout = model.layout(0)

				return axes === null || layout === null
					? null
					: gridView(
							// Scrolled as far as the objects go: the view's rows run to the grid's end.
							{ ...axes, rows: createGridAxis(layout.rows, 1_048_576, 1) },
							layout,
							{ top: scroll.top, left: 0 },
							scroll.width,
							scroll.height
						)
			},
			scrollBy: () => undefined
		},
		onFrame: (listener: () => void) => {
			const unpaint = model.onPaint(listener)

			frames.add(listener)

			return () => {
				frames.delete(listener)
				unpaint()
			}
		},
		focus: () => undefined
	} as unknown as SheetGridHandle
	const source: SheetObjectSource = {
		render: (sheet, key, stamp, since) =>
			session.query("drawing.render", { sheet, key, stamp, ...(since === undefined ? {} : { since }) }),
		media: partName => session.query("drawing.media", { partName })
	}
	const container = document.createElement("div")

	document.body.append(container)
	root = createRoot(container)

	const Objects = () => {
		// Follows the model as SheetBody does.
		useSyncExternalStore(model.subscribe, model.getSnapshot)

		const layout = model.layout(0)

		return (
			<SheetObjects
				grid={model}
				handle={{ current: handle }}
				sheet={0}
				drawings={layout?.extensions?.drawings}
				source={source}
				selected={null}
				canEdit
				onSelect={() => undefined}
				onMove={options.onMove ?? (() => Promise.resolve(true))}
				mac={false}
				onDelete={() => undefined}
				label={object => object.name}
			/>
		)
	}

	act(() => root?.render(<Objects />))
	await flush()

	return { model, container, scroll }
}

function pointer(element: HTMLElement, type: string, x: number, y: number): void {
	act(() => {
		element.dispatchEvent(
			new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y })
		)
	})
}

function svgOf(container: HTMLElement, name: string): SVGSVGElement | null {
	return container.querySelector<SVGSVGElement>(`[aria-label="${name}"] svg`)
}

describe("objects over the grid", () => {
	it("draws the bitmap a metafile picture carries", async () => {
		const { model, container } = await shown(DRAWINGS_BYTES)
		const inserted = await model.command({
			type: "drawing.insertImage",
			sheet: 0,
			placement: { from: { row: 20, col: 1, rowOff: 0, colOff: 0 } },
			bytes: bitmapEmf(),
			name: "",
			alt: ""
		})

		expect(inserted.ok).toBe(true)
		await flush()

		const added = model.layout(0)?.extensions?.drawings?.objects.at(-1)
		const image = svgOf(container, added?.name ?? "")?.querySelector("image")

		expect(image?.getAttribute("href")).toMatch(/^blob:/)
	})

	it("keeps a picture's media lent until the drawing replacing it shows", async () => {
		const { model, container } = await shown(DRAWINGS_BYTES)
		const first = svgOf(container, "Picture 1")
		const picture = model.layout(0)?.extensions?.drawings?.objects.find(object => object.name === "Picture 1")

		if (first === null || picture === undefined || picture.anchor.mode !== "twoCell") throw new Error("no picture")

		const showing: (SVGSVGElement | null)[] = []

		vi.spyOn(DocxMediaCache.prototype, "release").mockImplementation(function () {
			showing.push(svgOf(container, "Picture 1"))
		})

		const moved = await model.command({
			type: "drawing.move",
			sheet: 0,
			key: picture.key,
			stamp: picture.stamp,
			anchor: { ...picture.anchor, from: { ...picture.anchor.from, row: 4 }, to: { ...picture.anchor.to, row: 8 } }
		})

		expect(moved.ok).toBe(true)
		await flush()
		expect(showing.length).toBeGreaterThan(0)
		expect(showing.every(svg => svg !== null && svg !== first)).toBe(true)
	})

	it("draws a group holding a chart again only when the chart's data changed", async () => {
		const fixture = chartFixture(barChart([SOLD, KEPT], { title: "Grouped" }))
		const group =
			"<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>" +
			"<xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>18</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>" +
			'<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="9" name="Group 8"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr>' +
			'<xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="2743200"/><a:chOff x="0" y="0"/><a:chExt cx="4572000" cy="2743200"/></a:xfrm></xdr:grpSpPr>' +
			CHART_FRAME.slice(CHART_FRAME.indexOf("<xdr:graphicFrame"), CHART_FRAME.indexOf("<xdr:clientData/>")).replace(
				'<a:ext cx="0" cy="0"/>',
				'<a:ext cx="4572000" cy="2743200"/>'
			) +
			"</xdr:grpSp><xdr:clientData/></xdr:twoCellAnchor>"
		const { model, container } = await shown(
			buildFixture({
				...fixture,
				parts: {
					...fixture.parts,
					"xl/drawings/drawing1.xml": { text: wsDr(group), type: "application/vnd.openxmlformats-officedocument.drawing+xml" }
				}
			})
		)
		const first = svgOf(container, "Group 8")

		expect(first).not.toBeNull()

		await model.command({ type: "cells.set", sheet: 1, cells: cells([[0, 0, "2"]]) })
		await flush()
		expect(svgOf(container, "Group 8")).toBe(first)

		await model.command({ type: "cells.set", sheet: 0, cells: cells([[2, 1, "50"]]) })
		await flush()
		expect(svgOf(container, "Group 8")).not.toBe(first)
		expect(svgOf(container, "Group 8")).not.toBeNull()
	})
})

describe("pictures over the grid as they scroll", () => {
	it("keeps each picture's URL while it is scrolled away and back, however many pictures there are", async () => {
		const { model, scroll } = await shown(DRAWINGS_BYTES)

		for (let k = 0; k < 140; k++) {
			// Bytes of its own (after the image's end): a part of its own.
			const bytes = new Uint8Array(PNG.length + 4)

			bytes.set(PNG)
			new DataView(bytes.buffer).setUint32(PNG.length, k)

			const inserted = await act(() =>
				model.command({
					type: "drawing.insertImage",
					sheet: 0,
					placement: { from: { row: 40 + k * 40, col: 1, rowOff: 0, colOff: 0 } },
					bytes,
					name: "",
					alt: ""
				})
			)

			expect(inserted.ok).toBe(true)
		}

		await flush()

		const made = vi.spyOn(URL, "createObjectURL")
		const revoked = vi.spyOn(URL, "revokeObjectURL")
		// Inserted pictures are parts of their own: each has its own URL.
		const step = async (top: number): Promise<void> => {
			scroll.top = top
			act(() => model.repaint())
			await flush()
		}

		for (let top = 0; top <= 140 * 40 * 20; top += 600) await step(top)

		const first = made.mock.calls.length

		for (let top = 140 * 40 * 20; top >= 0; top -= 600) await step(top)

		expect(first).toBeGreaterThan(128)
		// Back over every picture: none made again, none revoked.
		expect(made.mock.calls.length).toBe(first)
		expect(revoked).not.toHaveBeenCalled()
	}, 60_000)

	it("keeps pictures drawn once they were near the view, and never draws those it never came near", async () => {
		const { model, scroll, container } = await shown(DRAWINGS_BYTES)

		for (let k = 0; k < 12; k++) {
			const bytes = new Uint8Array(PNG.length + 4)

			bytes.set(PNG)

			const view = new DataView(bytes.buffer)

			view.setUint32(16, 4000)
			view.setUint32(20, 2500)
			view.setUint32(PNG.length, k)

			const inserted = await act(() =>
				model.command({
					type: "drawing.insertImage",
					sheet: 0,
					placement: { from: { row: 200 + k * 200, col: 1, rowOff: 0, colOff: 0 } },
					bytes,
					name: "",
					alt: `Big ${String(k)}`
				})
			)

			expect(inserted.ok).toBe(true)
		}

		const drawn = (): string[] =>
			(model.layout(0)?.extensions?.drawings?.objects ?? [])
				.filter(
					object =>
						object.alt.startsWith("Big") &&
						(container.querySelector(`[data-object-key="${String(object.key)}"]`)?.childElementCount ?? 0) > 0
				)
				.map(object => object.alt)

		// Halfway down: the first six came near.
		for (let top = 0; top <= 6 * 200 * 20; top += 600) {
			scroll.top = top
			act(() => model.repaint())
			await flush()
		}

		expect(drawn()).toEqual(["Big 0", "Big 1", "Big 2", "Big 3", "Big 4", "Big 5"])
	}, 60_000)

	it("shows a cropped picture far larger than its box from a copy at the box's size", async () => {
		const big = PNG.slice()
		const view = new DataView(big.buffer)

		// The header says 2000 x 1500: the decode is stubbed, the size is what counts.
		view.setUint32(16, 2000)
		view.setUint32(20, 1500)

		const close = vi.fn()
		const bitmap = vi.fn((_blob: Blob, options: ImageBitmapOptions) => Promise.resolve({ close, options }))

		vi.stubGlobal("createImageBitmap", bitmap)
		vi.stubGlobal("fetch", () => Promise.resolve({ blob: () => Promise.resolve(new Blob([big])) }))
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => undefined } as never)
		vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => {
			callback(new Blob(["copy"], { type: "image/png" }))
		})

		const made: Blob[] = []
		const create = URL.createObjectURL.bind(URL)

		vi.spyOn(URL, "createObjectURL").mockImplementation(object => {
			if (object instanceof Blob) made.push(object)

			return create(object)
		})

		try {
			// A crop keeps the picture on the SVG path: the copy is of the whole picture, its shown part at the box's size.
			const { container } = await shown(withMedia(buildFixture(cropped(DRAWINGS)), { "xl/media/image1.png": big }))
			const href = container.querySelector('[aria-label="Picture 1"] image')?.getAttribute("href")
			const copy = made.findIndex(blob => blob.size === 4)

			expect(bitmap).toHaveBeenCalledTimes(1)
			expect(bitmap.mock.calls[0]?.[1]).toMatchObject({ resizeWidth: 192, resizeHeight: 128 })
			expect(close).toHaveBeenCalled()
			expect(copy).toBeGreaterThanOrEqual(0)
			expect(href).toMatch(/^blob:/)
			expect(href).not.toBeUndefined()
		} finally {
			vi.unstubAllGlobals()
		}
	})
})

// The fixture with Picture 1 cropped by a tenth on the left.
function cropped(fixture: typeof DRAWINGS): typeof DRAWINGS {
	const drawing = fixture.parts?.["xl/drawings/drawing1.xml"]

	if (drawing === undefined || !("text" in drawing)) throw new Error("no drawing")

	return {
		...fixture,
		parts: {
			...fixture.parts,
			"xl/drawings/drawing1.xml": {
				...drawing,
				text: drawing.text.replace('<a:blip r:embed="rId1"/>', '<a:blip r:embed="rId1"/><a:srcRect l="10000"/>')
			}
		}
	}
}

describe("plain pictures on a canvas", () => {
	function stubDecode(): { bitmap: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; drawn: ReturnType<typeof vi.fn> } {
		const close = vi.fn()
		const bitmap = vi.fn((_blob: Blob, options: ImageBitmapOptions) => Promise.resolve({ close, options }))
		const drawn = vi.fn()

		vi.stubGlobal("createImageBitmap", bitmap)
		vi.stubGlobal("fetch", () => Promise.resolve({ blob: () => Promise.resolve(new Blob([PNG])) }))
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: drawn, imageSmoothingQuality: "low" } as never)

		return { bitmap, close, drawn }
	}

	it("decodes a plain picture at its box's device pixels, draws it and closes the decode, its canvas named by the object", async () => {
		const { bitmap, close, drawn } = stubDecode()

		try {
			const { container } = await shown(DRAWINGS_BYTES)
			const object = container.querySelector<HTMLElement>('[aria-label="Picture 1"]')
			const canvas = object?.querySelector("canvas")

			expect(object?.getAttribute("role")).toBe("img")
			expect(object?.querySelector("svg")).toBeNull()
			expect(canvas?.getAttribute("aria-hidden")).toBe("true")
			expect(bitmap.mock.calls[0]?.[1]).toMatchObject({ resizeWidth: 128, resizeHeight: 80, resizeQuality: "high" })
			expect(drawn).toHaveBeenCalledTimes(1)
			expect(drawn.mock.calls[0]?.[0]).toBe(await bitmap.mock.results[0]?.value)
			expect(close).toHaveBeenCalledAfter(drawn)
			expect(close).toHaveBeenCalledTimes(1)
			expect([canvas?.width, canvas?.height]).toEqual([128, 80])
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("draws a canvas again at the new device pixel ratio after a zoom or a move to another screen", async () => {
		const { bitmap } = stubDecode()
		const listeners: (() => void)[] = []
		const queries: string[] = []

		vi.stubGlobal("matchMedia", (query: string) => {
			queries.push(query)

			return {
				matches: false,
				addEventListener: (_type: string, listener: () => void) => {
					listeners.push(listener)
				},
				removeEventListener: (_type: string, listener: () => void) => {
					listeners.splice(listeners.indexOf(listener), 1)
				}
			}
		})

		try {
			const { container } = await shown(DRAWINGS_BYTES)
			const canvas = container.querySelector<HTMLCanvasElement>('[aria-label="Picture 1"] canvas')

			expect([canvas?.width, canvas?.height]).toEqual([128, 80])
			vi.stubGlobal("devicePixelRatio", 2)
			act(() => {
				for (const listener of [...listeners]) listener()
			})
			await flush()
			expect([canvas?.width, canvas?.height]).toEqual([256, 160])
			expect(bitmap.mock.calls.at(-1)?.[1]).toMatchObject({ resizeWidth: 256, resizeHeight: 160 })
			// Asked again for the ratio there is now.
			expect(queries.at(-1)).toBe("(resolution: 2dppx)")
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("gives a canvas's pixels back out of view and decodes again when it comes back", async () => {
		const { bitmap } = stubDecode()

		try {
			const { model, container, scroll } = await shown(DRAWINGS_BYTES)
			const canvas = container.querySelector<HTMLCanvasElement>('[aria-label="Picture 1"] canvas')
			const step = async (top: number): Promise<void> => {
				scroll.top = top
				act(() => model.repaint())
				await flush()
			}

			await step(20_000)
			expect([canvas?.width, canvas?.height]).toEqual([0, 0])
			await step(0)
			expect([canvas?.width, canvas?.height]).toEqual([128, 80])
			expect(bitmap).toHaveBeenCalledTimes(2)
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("decodes only the part of a large picture near the view, and places it where it stands", async () => {
		const close = vi.fn()
		const bitmap = vi.fn((..._args: unknown[]) => Promise.resolve({ close }))

		vi.stubGlobal("createImageBitmap", bitmap)
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage: () => undefined,
			imageSmoothingQuality: "low"
		} as never)

		try {
			const { model, container } = await shown(DRAWINGS_BYTES)
			const big = PNG.slice()
			const view = new DataView(big.buffer)

			// A 700 x 500 picture shown at its own size from A35, just below the 800 x 600 view.
			view.setUint32(16, 700)
			view.setUint32(20, 500)

			const inserted = await act(() =>
				model.command({
					type: "drawing.insertImage",
					sheet: 0,
					placement: { from: { row: 34, col: 0, rowOff: 0, colOff: 0 } },
					bytes: big,
					name: "",
					alt: "Large"
				})
			)

			expect(inserted.ok).toBe(true)
			await flush()
			await act(() => new Promise(resolve => setTimeout(resolve, 50)))
			await flush()

			const object = model.layout(0)?.extensions?.drawings?.objects.find(entry => entry.alt === "Large")
			const canvas = container.querySelector<HTMLCanvasElement>(`[data-object-key="${String(object?.key)}"] canvas`)
			const call = bitmap.mock.calls.find(args => args.length === 6)

			// Its top within half a view below the view, in 128 px steps; all of its width.
			expect(call?.slice(1, 5)).toEqual([0, 0, 700, 256])
			expect(call?.[5]).toMatchObject({ resizeWidth: 700, resizeHeight: 256 })
			expect([canvas?.style.left, canvas?.style.top, canvas?.style.width, canvas?.style.height]).toEqual([
				"0px",
				"0px",
				"700px",
				"256px"
			])
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("holds no pixels for a picture an opaque one above covers whole", async () => {
		const { bitmap } = stubDecode()

		try {
			const { model, container } = await shown(DRAWINGS_BYTES)
			const big = PNG.slice()
			const view = new DataView(big.buffer)

			// 700 x 500 RGB samples (colour type 2, no tRNS): opaque, over Picture 1 from A1.
			view.setUint32(16, 700)
			view.setUint32(20, 500)
			big[25] = 2

			const inserted = await act(() =>
				model.command({
					type: "drawing.insertImage",
					sheet: 0,
					placement: { from: { row: 0, col: 0, rowOff: 0, colOff: 0 } },
					bytes: big,
					name: "",
					alt: "Cover"
				})
			)

			expect(inserted.ok).toBe(true)
			// No scroll and no other frame: what the cover's drawing reports places the objects again by itself.
			await flush()
			await act(() => new Promise(resolve => setTimeout(resolve, 50)))
			await flush()

			const under = container.querySelector<HTMLCanvasElement>('[aria-label="Picture 1"] canvas')
			const cover = model.layout(0)?.extensions?.drawings?.objects.find(object => object.alt === "Cover")
			const over = container.querySelector<HTMLCanvasElement>(`[data-object-key="${String(cover?.key)}"] canvas`)

			expect(under?.width).toBe(0)
			expect(over?.width).toBeGreaterThan(0)
			expect(rasterOpaque(big)).toBe(true)
			// The fixture's own picture has an alpha channel: it covers nothing.
			expect(rasterOpaque(PNG)).toBe(false)
			expect(bitmap).toHaveBeenCalled()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("holds at most four views' device pixels on canvases, what shows first, drawing the pictures past that as SVG", async () => {
		stubDecode()

		try {
			const { model, container } = await shown(DRAWINGS_BYTES)

			for (let k = 0; k < 9; k++) {
				const big = PNG.slice()
				const view = new DataView(big.buffer)

				// 700 x 500 with an alpha channel: none covers another.
				view.setUint32(16, 700)
				view.setUint32(20, 500)
				big[30] = k

				await act(() =>
					model.command({
						type: "drawing.insertImage",
						sheet: 0,
						placement: { from: { row: k, col: k, rowOff: 0, colOff: 0 } },
						bytes: big,
						name: "",
						alt: `Big ${String(k)}`
					})
				)
			}

			await flush()
			await act(() => new Promise(resolve => setTimeout(resolve, 50)))
			await flush()

			const canvases = Array.from(container.querySelectorAll("canvas"))
			const held = canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0)

			expect(held).toBeGreaterThan(0)
			expect(held).toBeLessThanOrEqual(4 * 800 * 600)
			expect(container.querySelectorAll(".fo-sheet-object svg image").length).toBeGreaterThan(0)
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("draws a picture larger than the view as SVG, which rasters only the part on screen", async () => {
		const { bitmap } = stubDecode()

		try {
			const { model, container } = await shown(DRAWINGS_BYTES)
			const big = PNG.slice()
			const view = new DataView(big.buffer)

			view.setUint32(16, 2000)
			view.setUint32(20, 1500)

			await act(() =>
				model.command({
					type: "drawing.insertImage",
					sheet: 0,
					placement: { from: { row: 10, col: 0, rowOff: 0, colOff: 0 } },
					bytes: big,
					name: "",
					alt: "Huge"
				})
			)
			await flush()
			await act(() => new Promise(resolve => setTimeout(resolve, 50)))
			await flush()

			const huge = model.layout(0)?.extensions?.drawings?.objects.find(object => object.alt === "Huge")
			const element = container.querySelector(`[data-object-key="${String(huge?.key)}"]`)

			expect(element?.querySelector("svg image")).not.toBeNull()
			expect(element?.querySelector("canvas")).toBeNull()
			expect(bitmap.mock.calls.every(args => args.length === 2 || (args[3] as number) < 2000)).toBe(true)
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("lets pictures that went to SVG in a small view onto canvases again once the view grows", async () => {
		stubDecode()

		try {
			const { model, container, scroll } = await shown(DRAWINGS_BYTES)
			const settle = async (): Promise<void> => {
				act(() => model.repaint())
				await flush()
				await act(() => new Promise(resolve => setTimeout(resolve, 50)))
				await flush()
			}

			for (let k = 0; k < 6; k++) {
				const picture = PNG.slice()
				const view = new DataView(picture.buffer)

				view.setUint32(16, 300)
				view.setUint32(20, 200)
				picture[30] = k

				await act(() =>
					model.command({
						type: "drawing.insertImage",
						sheet: 0,
						placement: { from: { row: 0, col: 0, rowOff: k * 9525, colOff: k * 9525 } },
						bytes: picture,
						name: "",
						alt: `Small ${String(k)}`
					})
				)
			}

			const onSvg = (): number =>
				(model.layout(0)?.extensions?.drawings?.objects ?? []).filter(
					object =>
						object.alt.startsWith("Small") &&
						container.querySelector(`[data-object-key="${String(object.key)}"] svg image`) !== null
				).length

			scroll.width = 260
			scroll.height = 200
			await settle()
			expect(onSvg()).toBeGreaterThan(0)

			scroll.width = 800
			scroll.height = 600
			await settle()
			await settle()
			expect(onSvg()).toBe(0)
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("keeps what an object is with the object, not its place in z-order, when one before it is deleted", async () => {
		stubDecode()

		try {
			const { model, container } = await shown(DRAWINGS_BYTES)
			const huge = PNG.slice()
			const view = new DataView(huge.buffer)

			view.setUint32(16, 2000)
			view.setUint32(20, 1500)

			const insert = (bytes: Uint8Array, alt: string) =>
				act(() =>
					model.command({
						type: "drawing.insertImage",
						sheet: 0,
						placement: { from: { row: 8, col: 0, rowOff: 0, colOff: 0 } },
						bytes,
						name: "",
						alt
					})
				)

			await insert(huge, "Huge")

			const small = PNG.slice()

			small[30] = 7
			await insert(small, "Small")
			await flush()
			await act(() => new Promise(resolve => setTimeout(resolve, 50)))
			await flush()

			const hugeObject = model.layout(0)?.extensions?.drawings?.objects.find(object => object.alt === "Huge")

			if (hugeObject === undefined) throw new Error("no huge picture")

			await act(() =>
				model.command({ type: "drawing.delete", sheet: 0, objects: [{ key: hugeObject.key, stamp: hugeObject.stamp }] })
			)
			await flush()
			await act(() => new Promise(resolve => setTimeout(resolve, 50)))
			await flush()

			const smallObject = model.layout(0)?.extensions?.drawings?.objects.find(object => object.alt === "Small")
			const element = container.querySelector(`[data-object-key="${String(smallObject?.key)}"]`)

			// It took the huge picture's place in z-order, not its SVG.
			expect(smallObject?.key).toBe(hugeObject.key)
			expect(element?.querySelector("canvas")?.width).toBeGreaterThan(0)
			expect(element?.querySelector("svg image")).toBeNull()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("decodes two pictures at a time", async () => {
		const pending: (() => void)[] = []
		const close = vi.fn()
		const bitmap = vi.fn(
			() =>
				new Promise(resolve => {
					pending.push(() => {
						resolve({ close })
					})
				})
		)

		vi.stubGlobal("createImageBitmap", bitmap)
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage: () => undefined,
			imageSmoothingQuality: "low"
		} as never)

		try {
			const { model } = await shown(DRAWINGS_BYTES)

			for (let k = 0; k < 4; k++) {
				const bytes = new Uint8Array(PNG.length + 4)

				bytes.set(PNG)
				new DataView(bytes.buffer).setUint32(PNG.length, k)
				await act(() =>
					model.command({
						type: "drawing.insertImage",
						sheet: 0,
						placement: { from: { row: 8 + k * 4, col: 1, rowOff: 0, colOff: 0 } },
						bytes,
						name: "",
						alt: ""
					})
				)
			}

			await flush()
			expect(bitmap).toHaveBeenCalledTimes(2)

			while (pending.length > 0) {
				for (const next of pending.splice(0)) next()
				await flush()
			}

			expect(bitmap).toHaveBeenCalledTimes(5)
			expect(close).toHaveBeenCalledTimes(5)
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("keeps the SVG path for a cropped picture and where the platform cannot decode at a size", async () => {
		const { bitmap } = stubDecode()

		try {
			const { container } = await shown(withMedia(buildFixture(cropped(DRAWINGS)), { "xl/media/image1.png": PNG }))

			expect(container.querySelector('[aria-label="Picture 1"] svg image')).not.toBeNull()
			expect(bitmap).not.toHaveBeenCalled()
		} finally {
			vi.unstubAllGlobals()
			act(() => root?.unmount())
			root = null
		}

		const { container } = await shown(DRAWINGS_BYTES)

		expect(container.querySelector('[aria-label="Picture 1"] canvas')).toBeNull()
		expect(container.querySelector('[aria-label="Picture 1"] svg image')).not.toBeNull()
	})
})

describe("dragging and keys on an object", () => {
	it("re-places a dragged object on the next frame without drawing the cells again", async () => {
		vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => undefined)

		const { model, container } = await shown(DRAWINGS_BYTES)
		const element = container.querySelector<HTMLElement>('[aria-label="Picture 1"]')

		if (element === null) throw new Error("no picture")

		const before = element.style.transform
		const cells = model.cellsVersion()

		pointer(element, "pointerdown", 10, 10)
		pointer(element, "pointermove", 60, 70)
		pointer(element, "pointermove", 80, 90)
		await flush()

		expect(element.style.transform).not.toBe(before)
		expect(model.cellsVersion()).toBe(cells)
	})

	it("puts a dropped object back where it is when the move rejects, leaving no rejection unhandled", async () => {
		vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => undefined)

		const { container } = await shown(DRAWINGS_BYTES, { onMove: () => Promise.reject(new SheetSessionClosedError()) })
		const element = container.querySelector<HTMLElement>('[aria-label="Picture 1"]')

		if (element === null) throw new Error("no picture")

		const before = element.style.transform

		// A rejection nobody handles fails the run (vitest reports unhandled errors).
		pointer(element, "pointerdown", 10, 10)
		pointer(element, "pointermove", 60, 70)
		await flush()
		expect(element.style.transform).not.toBe(before)
		pointer(element, "pointerup", 60, 70)
		await flush()

		expect(element.style.transform).toBe(before)
	})

	it("leaves no rejection unhandled when a nudge, an undo or a redo rejects", async () => {
		const { model, container } = await shown(DRAWINGS_BYTES, { onMove: () => Promise.reject(new SheetSessionClosedError()) })
		const element = container.querySelector<HTMLElement>('[aria-label="Picture 1"]')
		const undo = vi.spyOn(model, "undo").mockRejectedValue(new SheetSessionClosedError())
		const redo = vi.spyOn(model, "redo").mockRejectedValue(new SheetSessionClosedError())

		if (element === null) throw new Error("no picture")

		// A rejection nobody handles fails the run (vitest reports unhandled errors).
		act(() => {
			element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
			element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "z", code: "KeyZ", ctrlKey: true }))
			element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "y", code: "KeyY", ctrlKey: true }))
		})
		await flush()

		expect([undo.mock.calls.length, redo.mock.calls.length]).toEqual([1, 1])
	})
})
