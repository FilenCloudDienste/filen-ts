import { describe, expect, it } from "vitest"
import {
	canvasColor,
	canvasDrawingImages,
	canvasTextFonts,
	paintDrawingCanvas,
	paintTextPageCanvas,
	patternMask,
	recolorPixels
} from "../core/drawingml/canvas"
import type { DrawingData } from "../core/drawingml/data"
import { DrawingList, IDENTITY, ItemFlag, ItemKind, rgba, type DrawingImage, type Paint, type Stroke } from "../core/drawingml/index"
import { fixtureTextPage } from "./fixtures/presentation/textPage"
import { RecordedGradient, RecordedPattern, RecordingCanvas, recordingSurfaces, type RecordedImage } from "./presentationCanvasRecorder"

const LINE: Stroke = {
	width: 2,
	paint: 0,
	dash: "dash",
	customDash: null,
	cap: "round",
	join: "bevel",
	miterLimit: 8,
	compound: "sng",
	inset: false
}

function dataOf(list: DrawingList): DrawingData {
	const c = list.compact()

	return {
		width: c.width,
		height: c.height,
		commands: c.commands,
		coords: c.coords,
		itemCount: c.itemCount,
		itemFloats: c.itemFloats,
		itemInts: c.itemInts,
		paints: c.paints,
		strokes: c.strokes,
		images: c.images,
		texts: c.texts,
		shadows: c.shadows,
		...(c.clips.length > 0 ? { clips: c.clips } : {}),
		...(c.itemClips !== null ? { itemClips: c.itemClips } : {})
	}
}

function rectangle(list: DrawingList, x: number, y: number, width: number, height: number): [number, number] {
	const command = list.commandCount
	const coord = list.coordCount

	list.moveTo(x, y)
	list.lineTo(x + width, y)
	list.lineTo(x + width, y + height)
	list.lineTo(x, y + height)
	list.close()

	return [command, coord]
}

function shape(
	fill: Paint | undefined,
	options: { stroke?: Stroke; flags?: number; matrix?: number[]; shadow?: boolean } = {}
): DrawingData {
	const list = new DrawingList()

	list.width = 100
	list.height = 50

	const fillIndex = fill === undefined ? -1 : list.paint(fill)
	const strokeIndex =
		options.stroke === undefined ? -1 : list.stroke({ ...options.stroke, paint: list.paint({ kind: "solid", color: rgba("FF0000") }) })
	const shadowIndex = options.shadow === true ? list.shadow({ color: rgba("000000", 0.5), blur: 4, dx: 3, dy: 2, sx: 1, sy: 1 }) : -1
	const [command, coord] = rectangle(list, 0, 0, 100, 50)

	list.addItem(
		ItemKind.PATH,
		options.matrix ?? IDENTITY,
		0,
		0,
		100,
		50,
		command,
		coord,
		fillIndex,
		strokeIndex,
		-1,
		shadowIndex,
		options.flags ?? 0,
		0
	)

	return dataOf(list)
}

const NO_IMAGES = { image: (): RecordedImage | undefined => undefined }

describe("canvas painter: paths", () => {
	it("fills a solid path in the item's space placed by the caller's matrix", () => {
		const ctx = new RecordingCanvas()

		paintDrawingCanvas(
			ctx,
			shape({ kind: "solid", color: rgba("336699") }, { matrix: [1, 0, 0, 1, 10, 5] }),
			[2, 0, 0, 2, 0, 0],
			NO_IMAGES
		)

		const fill = ctx.ops("fill")[0]

		expect(fill?.fill).toBe("#336699ff")
		expect(fill?.transform).toEqual([2, 0, 0, 2, 20, 10])
		expect(ctx.ops("moveTo")[0]?.args).toEqual([0, 0])
		expect(ctx.depth).toBe(0)
	})

	it("blends a fill modifier toward white", () => {
		const ctx = new RecordingCanvas()

		paintDrawingCanvas(ctx, shape({ kind: "solid", color: rgba("000000") }, { flags: ItemFlag.LIGHTEN }), [1, 0, 0, 1, 0, 0], NO_IMAGES)

		expect(ctx.ops("fill")[0]?.fill).toBe(canvasColor(rgba("666666")))
	})

	it("fills even-odd paths with the even-odd rule", () => {
		const ctx = new RecordingCanvas()

		paintDrawingCanvas(
			ctx,
			shape({ kind: "solid", color: rgba("000000") }, { flags: ItemFlag.EVEN_ODD }),
			[1, 0, 0, 1, 0, 0],
			NO_IMAGES
		)

		expect(ctx.ops("fill")[0]?.args).toEqual(["evenodd"])
	})

	it("draws a linear gradient across the box at its angle", () => {
		const ctx = new RecordingCanvas()
		const stops = { offsets: new Float32Array([0, 1]), colors: new Uint32Array([rgba("FF0000"), rgba("0000FF")]) }

		paintDrawingCanvas(ctx, shape({ kind: "linear", stops, angle: 90, scaled: false }), [1, 0, 0, 1, 0, 0], NO_IMAGES)

		const gradient = ctx.ops("fill")[0]?.fill as RecordedGradient

		expect(gradient).toBeInstanceOf(RecordedGradient)
		expect(gradient.args.map(value => Math.round(value * 1000) / 1000)).toEqual([50, 0, 50, 50])
		expect(gradient.stops).toEqual([
			[0, "#ff0000ff"],
			[1, "#0000ffff"]
		])
	})

	it("draws a circle path gradient as a true circle through the box's corners, centred on its focus", () => {
		const ctx = new RecordingCanvas()
		const stops = { offsets: new Float32Array([0, 1]), colors: new Uint32Array([rgba("FFFFFF"), rgba("000000")]) }

		paintDrawingCanvas(
			ctx,
			shape({ kind: "path", shape: "circle", stops, focus: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 } }),
			[1, 0, 0, 1, 0, 0],
			NO_IMAGES
		)

		expect(ctx.ops("clip")).toHaveLength(1)

		const area = ctx.ops("fillRect")[0]

		const radius = Math.hypot(100, 50) / 2

		// A 100 x 50 box: the unit circle scaled to half the diagonal on both axes, at the box's centre.
		expect(area?.transform).toEqual([radius, 0, 0, radius, 50, 25])
		expect((area?.fill as RecordedGradient).kind).toBe("radial")
		expect((area?.fill as RecordedGradient).args).toEqual([0, 0, 0, 0, 0, 1])
	})

	it("repeats a metafile gradient's stops over every period it covers", () => {
		const ctx = new RecordingCanvas()
		const stops = { offsets: new Float32Array([0, 1]), colors: new Uint32Array([rgba("FF0000"), rgba("0000FF")]) }

		paintDrawingCanvas(
			ctx,
			shape({ kind: "gradient", type: "linear", stops, matrix: [25, 0, 0, 25, 0, 0], spread: "repeat" }),
			[1, 0, 0, 1, 0, 0],
			NO_IMAGES
		)

		const gradient = ctx.ops("fillRect")[0]?.fill as RecordedGradient

		// 100 px wide over 25 px periods: four periods, eight stops.
		expect(gradient.args).toEqual([0, 0, 4, 0])
		expect(gradient.stops).toHaveLength(8)
		expect(gradient.stops[2]).toEqual([0.25, "#ff0000ff"])
	})

	it("tiles a preset pattern from an 8x8 scratch canvas of its mask", () => {
		const ctx = new RecordingCanvas()
		const surfaces = recordingSurfaces()

		paintDrawingCanvas(
			ctx,
			shape({ kind: "pattern", pattern: "ltHorz", foreground: rgba("000000"), background: rgba("FFFFFF") }),
			[1, 0, 0, 1, 0, 0],
			{ ...NO_IMAGES, surface: surfaces.surface }
		)

		expect(ctx.ops("fill")[0]?.fill).toBeInstanceOf(RecordedPattern)

		const tile = surfaces.made[0]?.pixels ?? new Uint8ClampedArray()

		// Row 0 is the foreground (black), row 1 the background (white).
		expect([...tile.subarray(0, 4)]).toEqual([0, 0, 0, 255])
		expect([...tile.subarray(32, 36)]).toEqual([255, 255, 255, 255])
		expect(patternMask("ltHorz")?.reduce((sum, value) => sum + value, 0)).toBe(8)
	})

	it("draws a pattern as the blend of its colours without a scratch canvas", () => {
		const ctx = new RecordingCanvas()

		paintDrawingCanvas(
			ctx,
			shape({ kind: "pattern", pattern: "pct50", foreground: rgba("000000"), background: rgba("FFFFFF") }),
			[1, 0, 0, 1, 0, 0],
			NO_IMAGES
		)

		expect(ctx.ops("fill")[0]?.fill).toBe(canvasColor(rgba("808080")))
	})

	it("strokes with width, caps, joins and dashes in multiples of the width", () => {
		const ctx = new RecordingCanvas()

		paintDrawingCanvas(ctx, shape(undefined, { stroke: LINE }), [1, 0, 0, 1, 0, 0], NO_IMAGES)

		const stroke = ctx.ops("stroke")[0]

		expect(stroke?.stroke).toBe("#ff0000ff")
		expect(stroke?.lineWidth).toBe(2)
		expect(stroke?.dash).toEqual([8, 6])
	})

	it("casts a shadow offset and blurred in drawing space", () => {
		const ctx = new RecordingCanvas()

		paintDrawingCanvas(ctx, shape({ kind: "solid", color: rgba("FFFFFF") }, { shadow: true }), [2, 0, 0, 2, 0, 0], NO_IMAGES)

		expect(ctx.ops("fill")[0]?.shadow).toEqual(["#00000080", 8, 6, 4])
	})

	it("skips hidden items and hides an item whose clip chain is malformed", () => {
		const list = new DrawingList()
		const [command, coord] = rectangle(list, 0, 0, 10, 10)
		const fill = list.paint({ kind: "solid", color: rgba("000000") })

		list.addItem(ItemKind.PATH, IDENTITY, 0, 0, 10, 10, command, coord, fill, -1, -1, -1, ItemFlag.HIDDEN, 0, 5)
		list.addItem(ItemKind.PATH, IDENTITY, 0, 0, 10, 10, command, coord, fill, -1, -1, -1, 0, 0, 5)

		const data = dataOf(list)
		const broken: DrawingData = {
			...data,
			clips: [{ matrix: [...IDENTITY], firstCommand: 0, commandCount: 5, firstCoord: 0, evenOdd: false, parent: 7 }],
			itemClips: new Int32Array([-1, 0])
		}
		const ctx = new RecordingCanvas()

		paintDrawingCanvas(ctx, broken, [1, 0, 0, 1, 0, 0], NO_IMAGES)
		expect(ctx.ops("fill")).toHaveLength(0)

		const shown = new RecordingCanvas()

		paintDrawingCanvas(shown, data, [1, 0, 0, 1, 0, 0], NO_IMAGES)
		expect(shown.ops("fill")).toHaveLength(1)
	})

	it("cuts a subtracted clip out of the plane with the even-odd rule", () => {
		const list = new DrawingList()
		const [outerCommand, outerCoord] = rectangle(list, 0, 0, 100, 100)
		const outer = list.clip(IDENTITY, outerCommand, outerCoord, false, -1, 5)
		const [innerCommand, innerCoord] = rectangle(list, 25, 25, 50, 50)
		const inner = list.clip(IDENTITY, innerCommand, innerCoord, false, -1, 5)
		const region = list.clip(IDENTITY, 0, 0, false, -1, 0, { add: [outer], subtract: [inner] })
		const [command, coord] = rectangle(list, 0, 0, 100, 100)
		const item = list.addItem(
			ItemKind.PATH,
			IDENTITY,
			0,
			0,
			100,
			100,
			command,
			coord,
			list.paint({ kind: "solid", color: rgba("00FF00") }),
			-1,
			-1,
			-1,
			0,
			0
		)

		list.setItemClip(item, region)

		const ctx = new RecordingCanvas()

		paintDrawingCanvas(ctx, dataOf(list), [1, 0, 0, 1, 0, 0], NO_IMAGES)

		expect(ctx.ops("clip").map(call => call.args[0])).toEqual(["nonzero", "evenodd"])
		expect(ctx.ops("fill")).toHaveLength(1)
	})
})

describe("canvas painter: pictures", () => {
	const image = (overrides: Partial<DrawingImage> = {}): DrawingImage => ({
		partName: "/ppt/media/image1.png",
		format: "png",
		handling: "native",
		svgPartName: undefined,
		crop: { left: 0, top: 0, right: 0, bottom: 0 },
		alpha: 1,
		grayscale: false,
		biLevel: -1,
		duotone: null,
		brightness: 0,
		contrast: 0,
		colorChange: null,
		...overrides
	})

	function pictureData(picture: DrawingImage): DrawingData {
		const list = new DrawingList()

		list.width = 200
		list.height = 100
		list.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 200, 100, list.commandCount, list.coordCount, -1, -1, list.image(picture), -1, 0, 0, 0)

		return dataOf(list)
	}

	const decoded: RecordedImage = { width: 400, height: 200, name: "bitmap" }

	it("draws only the cropped source rectangle", () => {
		const ctx = new RecordingCanvas()

		paintDrawingCanvas(
			ctx,
			pictureData(image({ crop: { left: 0.25, top: 0, right: 0.25, bottom: 0.5 }, alpha: 0.5 })),
			[1, 0, 0, 1, 0, 0],
			{
				image: () => decoded
			}
		)

		const draw = ctx.ops("drawImage")[0]

		expect(draw?.args).toEqual(["bitmap", 100, 0, 200, 100, 0, 0, 200, 100])
		expect(draw?.alpha).toBe(0.5)
	})

	it("pads a negative crop inside a clip to the box", () => {
		const ctx = new RecordingCanvas()

		paintDrawingCanvas(ctx, pictureData(image({ crop: { left: -0.5, top: 0, right: -0.5, bottom: 0 } })), [1, 0, 0, 1, 0, 0], {
			image: () => decoded
		})

		expect(ctx.ops("clip")).toHaveLength(1)
		expect(ctx.ops("drawImage")[0]?.args).toEqual(["bitmap", 50, 0, 100, 100])
	})

	it("draws the placeholder for a picture it cannot show", () => {
		const ctx = new RecordingCanvas()

		paintDrawingCanvas(ctx, pictureData(image()), [1, 0, 0, 1, 0, 0], NO_IMAGES)

		expect(ctx.ops("fillRect")[0]?.fill).toBe("#f1f1f1")
		expect(ctx.ops("stroke")).toHaveLength(1)
	})

	it("recolours a picture in bounded bands on a scratch canvas", () => {
		const ctx = new RecordingCanvas()
		const surfaces = recordingSurfaces()
		const tall: RecordedImage = { width: 10, height: 300, name: "tall" }

		paintDrawingCanvas(ctx, pictureData(image({ grayscale: true })), [1, 0, 0, 1, 0, 0], {
			image: () => tall,
			surface: surfaces.surface
		})

		const scratch = surfaces.made[0]

		expect(scratch?.ops("getImageData").map(call => call.args[3])).toEqual([128, 128, 44])
		expect(ctx.ops("drawImage")[0]?.args[0]).toBe("surface0")
	})

	it("applies grey, contrast, bi-level, duotone and colour change as the SVG filter chain does", () => {
		const pixel = (overrides: Partial<DrawingImage>, rgb: readonly number[]): number[] => {
			const data = new Uint8ClampedArray([...rgb, 255])

			recolorPixels(data, image(overrides))

			return [...data]
		}

		expect(pixel({ grayscale: true }, [255, 0, 0])).toEqual([54, 54, 54, 255])
		expect(pixel({ biLevel: 0.5 }, [200, 200, 200])).toEqual([255, 255, 255, 255])
		expect(pixel({ biLevel: 0.5 }, [60, 60, 60])).toEqual([0, 0, 0, 255])
		expect(pixel({ duotone: [rgba("000000"), rgba("FF0000")] }, [255, 255, 255])).toEqual([255, 0, 0, 255])
		expect(pixel({ contrast: 0.5 }, [191, 128, 64])).toEqual([255, 129, 0, 255])
		expect(pixel({ colorChange: [rgba("00FF00"), rgba("0000FF", 0)] }, [0, 255, 0])).toEqual([0, 0, 255, 0])
	})

	it("lists the pictures to decode once each, hidden items skipped", () => {
		const list = new DrawingList()
		const picture = image()
		const ref = list.image(picture)

		list.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 10, 10, 0, 0, -1, -1, ref, -1, 0, 0, 0)
		list.addItem(
			ItemKind.IMAGE,
			IDENTITY,
			0,
			0,
			10,
			10,
			0,
			0,
			-1,
			-1,
			list.image(image({ partName: "/hidden.png" })),
			-1,
			ItemFlag.HIDDEN,
			0,
			0
		)

		const [command, coord] = rectangle(list, 0, 0, 10, 10)

		list.addItem(
			ItemKind.PATH,
			IDENTITY,
			0,
			0,
			10,
			10,
			command,
			coord,
			list.paint({ kind: "image", image: ref, stretch: undefined, tile: undefined }),
			-1,
			-1,
			-1,
			0,
			0
		)

		expect(canvasDrawingImages(dataOf(list)).map(found => found.partName)).toEqual(["/ppt/media/image1.png"])
	})
})

describe("canvas painter: text pages", () => {
	it("draws each fragment on its baseline in its style's font and colour", () => {
		const ctx = new RecordingCanvas()

		paintTextPageCanvas(ctx, fixtureTextPage(["Title", "Body"]), [1, 0, 0, 1, 40, 20])

		const texts = ctx.ops("fillText")

		expect(texts.map(call => call.args)).toEqual([
			["Title", 0, 18],
			["Body", 0, 42]
		])
		expect(texts[0]?.font).toBe('400 20px "fo-carlito", sans-serif')
		expect(texts[0]?.fill).toBe("#1F2937")
		expect(texts[0]?.transform).toEqual([1, 0, 0, 1, 40, 20])
	})

	it("draws the optional paint fields as the DOM painter does: a gradient across the span, outline and glow", () => {
		const ctx = new RecordingCanvas()

		paintTextPageCanvas(ctx, fixtureTextPage(["Decorated"], { decorated: [0] }), [1, 0, 0, 1, 0, 0])

		const fills = ctx.ops("fillText")
		const glyphs = fills[fills.length - 1]

		// The span's box: the fragment's 81 px by the style's ascent and descent; the paint at 90° runs top to bottom.
		expect(glyphs?.fill).toBeInstanceOf(RecordedGradient)
		expect((glyphs?.fill as RecordedGradient).args.map(value => Math.round(value * 1000) / 1000 + 0)).toEqual([40.5, 0, 40.5, 24])
		// A painted style's alpha is its stops' (as the DOM painter applies alpha only to a colour).
		expect(glyphs?.alpha).toBe(1)

		// The glow: two shadows (its radius and half of it) of copies drawn far off the page, then the glyphs.
		const glows = fills.slice(0, 2)

		expect(glows.map(call => call.shadow[1])).toEqual([4, 2])
		expect(glows.map(call => call.shadow[0])).toEqual(["#ffc00099", "#ffc00099"])
		expect(glows.every(call => (call.args[1] as number) + call.shadow[2] === 0)).toBe(true)

		const outline = ctx.ops("strokeText")

		expect(outline).toHaveLength(1)
		expect(outline[0]?.stroke).toBe("#1f2937ff")
		expect(outline[0]?.dash).toEqual([])
	})

	it("spaces characters itself where the context has no letterSpacing", () => {
		const ctx = new RecordingCanvas(0, 0, "canvas", false)
		const page = fixtureTextPage(["ab"])
		const fragmentFloats = new Float32Array(page.page.fragmentFloats)

		fragmentFloats[3] = 2

		paintTextPageCanvas(ctx, { ...page, page: { ...page.page, fragmentFloats } }, [1, 0, 0, 1, 0, 0])

		expect(ctx.ops("fillText").map(call => call.args)).toEqual([
			["a", 0, 18],
			["b", 11, 18]
		])
	})

	it("lists the fonts to load before painting", () => {
		expect(canvasTextFonts(fixtureTextPage(["a", "b"], { decorated: [1] }))).toEqual([
			'400 20px "fo-carlito", sans-serif',
			'400 14px "fo-carlito", sans-serif',
			'700 20px "fo-carlito", sans-serif'
		])
	})

	it("falls back to a plain font for one that is not the engine's", () => {
		const ctx = new RecordingCanvas()
		const page = fixtureTextPage(["x"])
		const style = page.styles[0]

		if (style === undefined) throw new Error("fixture")

		paintTextPageCanvas(ctx, { ...page, styles: [{ ...style, font: "20px url(x)" }] }, [1, 0, 0, 1, 0, 0])

		expect(ctx.ops("fillText")[0]?.font).toBe("400 16px serif")
	})
})
