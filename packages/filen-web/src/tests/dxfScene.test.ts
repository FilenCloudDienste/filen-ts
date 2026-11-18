import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Color, type WebGLRenderer } from "three"
import { DxfViewer, type DxfSceneOptions } from "dxf-viewer"
import { PDF_FACES, decodeFace } from "@filen/office/core/pdfwrite/fonts"
import { dxfCanvas, dxfContainer, installDxfGlobals } from "@/features/preview/lib/dxfStubs"
import {
	DXF_DRAWING_PATH,
	DXF_FONT_PATH_PREFIX,
	createDxfViewer,
	dxfLoadFailure,
	loadDxf,
	watchDxfMessages
} from "@/features/preview/lib/dxfScene"
import { regularFace } from "@/features/preview/lib/dxfFonts.logic"
import { dxfDeclaredEncoding } from "@/features/preview/lib/dxfEncoding.logic"
import { DxfTextScan } from "@/features/preview/lib/dxfText.logic"

// The CAD worker's loading path without a GPU: the viewer built as the worker builds it (its stubs, its scene budget),
// on a renderer that records instead of drawing, its drawing and fonts answered as the worker's sandbox answers them.

const FONTS = fileURLToPath(new URL("../../../filen-office/assets/fonts/", import.meta.url))
const ARIMO = regularFace(PDF_FACES.arimo)

// Lines of a DXF: group code, value, ...
function dxf(...groups: (string | number)[]): string {
	return groups.map(String).join("\r\n") + "\r\n"
}

function section(name: string, ...groups: (string | number)[]): (string | number)[] {
	return [0, "SECTION", 2, name, ...groups, 0, "ENDSEC"]
}

// Without spreading: a test drawing's groups may outnumber the arguments a call takes.
function sectionOf(name: string, groups: readonly (string | number)[]): (string | number)[] {
	return [0, "SECTION", 2, name].concat(groups, [0, "ENDSEC"])
}

function drawing(entities: (string | number)[], blocks: (string | number)[] = [], header: (string | number)[] = []): string {
	return (
		sectionOf("HEADER", header)
			.concat(sectionOf("BLOCKS", blocks), sectionOf("ENTITIES", entities), [0, "EOF"])
			.map(String)
			.join("\r\n") + "\r\n"
	)
}

// A plan: two layers, a line, a circle and a text in Windows-1252.
const PLAN = dxf(
	...section("HEADER", 9, "$ACADVER", 1, "AC1015", 9, "$DWGCODEPAGE", 3, "ANSI_1252"),
	...section(
		"TABLES",
		0,
		"TABLE",
		2,
		"LAYER",
		70,
		2,
		0,
		"LAYER",
		2,
		"WALLS",
		70,
		0,
		62,
		1,
		6,
		"CONTINUOUS",
		0,
		"LAYER",
		2,
		"DIMS",
		70,
		0,
		62,
		5,
		6,
		"CONTINUOUS",
		0,
		"ENDTAB"
	),
	...section(
		"ENTITIES",
		...[0, "LINE", 8, "WALLS", 10, 0, 20, 0, 30, 0, 11, 100, 21, 0, 31, 0],
		...[0, "CIRCLE", 8, "DIMS", 10, 50, 20, 30, 30, 0, 40, 20],
		...[0, "TEXT", 8, "DIMS", 10, 10, 20, 70, 30, 0, 40, 8, 1, "Café"]
	),
	0,
	"EOF"
)

// Blocks B0..B(depth-1), each inserting the next twice; the last holds a line. 2^depth lines from a few KB.
function nestedBlocks(depth: number): string {
	const blocks: (string | number)[] = []

	for (let level = 0; level < depth; level++) {
		blocks.push(0, "BLOCK", 2, `B${String(level)}`, 10, 0, 20, 0, 30, 0)

		if (level === depth - 1) blocks.push(0, "LINE", 8, "0", 10, 0, 20, 0, 30, 0, 11, 1, 21, 1, 31, 0)
		else for (const x of [0, 1]) blocks.push(0, "INSERT", 2, `B${String(level + 1)}`, 10, x, 20, 0, 30, 0)

		blocks.push(0, "ENDBLK")
	}

	return drawing([0, "INSERT", 2, "B0", 10, 0, 20, 0, 30, 0], blocks)
}

// A patterned hatch over a 100-unit square, its one pattern line `dashes` long (all spaces when `spaces`).
function hatch(dashes: number, spaces: boolean): string {
	const pattern = Array.from({ length: dashes }, (_, index) => [49, spaces || index % 2 === 1 ? -0.0001 : 0.0001]).flat()

	return drawing([
		...[0, "HATCH", 8, "0", 10, 0, 20, 0, 30, 0, 2, "CUSTOM", 70, 0, 71, 0, 91, 1, 92, 3, 72, 0, 73, 1, 93, 4],
		...[10, 0, 20, 0, 10, 100, 20, 0, 10, 100, 20, 100, 10, 0, 20, 100, 97, 0],
		...[75, 0, 76, 2, 52, 0, 41, 1, 77, 0, 78, 1, 53, 0, 43, 0, 44, 0, 45, 0, 46, 1, 79, dashes, ...pattern, 98, 0]
	])
}

// The worker's resolve: the drawing once, the office faces decompressed.
function serve(text: string, encoding = "utf-8"): void {
	const bytes = encoding === "windows-1252" ? Uint8Array.from(text, char => char.charCodeAt(0)) : new TextEncoder().encode(text)
	let held: Blob | null = new Blob([bytes])

	vi.stubGlobal("fetch", (input: string) => {
		const path = input.replace(/^filen-ref:\/\/\//, "")

		if (path === DXF_DRAWING_PATH && held !== null) {
			const blob = held

			held = null

			return Promise.resolve(new Response(blob))
		}

		const face = path.startsWith(DXF_FONT_PATH_PREFIX) ? path.slice(DXF_FONT_PATH_PREFIX.length) : null

		if (face !== null && face === ARIMO?.file) {
			return Promise.resolve(new Response(new Blob([decodeFace(readFileSync(`${FONTS}${face}`), ARIMO) as Uint8Array<ArrayBuffer>])))
		}

		return Promise.resolve(new Response(null, { status: 404 }))
	})
}

// What dxf-viewer asks of a WebGLRenderer, recorded; setSize writes the canvas style as three's does.
function fakeRenderer() {
	const canvas = dxfCanvas(new EventTarget())
	const renderer = {
		domElement: canvas,
		outputColorSpace: "srgb",
		sortObjects: true,
		renders: 0,
		setPixelRatio: vi.fn(),
		setClearColor: vi.fn(),
		setSize: (width: number, height: number) => {
			canvas.style["width"] = `${String(width)}px`
			canvas.style["height"] = `${String(height)}px`
		},
		render: () => {
			renderer.renders++
		},
		dispose: vi.fn()
	}

	return renderer
}

// A drawing read as the worker reads it: its encoding from the header and the whole file.
function encodingOf(text: string): string {
	const scan = new DxfTextScan(dxfDeclaredEncoding(new TextEncoder().encode(text)))

	scan.add(new TextEncoder().encode(text))

	return scan.finish().encoding
}

async function finish(viewer: DxfViewer) {
	const notices = watchDxfMessages(viewer)
	const loaded = await loadDxf(viewer, ARIMO === undefined ? [] : [ARIMO.file]).then(
		() => "loaded" as const,
		(error: unknown) => dxfLoadFailure(error)
	)

	return { viewer, notices, loaded }
}

// Built as the worker builds it, with its budgets.
async function open(text: string) {
	const renderer = fakeRenderer()
	const viewer = createDxfViewer(renderer as unknown as WebGLRenderer, {
		width: 400,
		height: 300,
		background: new Color(0xffffff),
		pointSize: 2,
		encoding: encodingOf(text),
		fontWork: () => 0
	})

	return { renderer, ...(await finish(viewer)) }
}

// Built with small budgets of its own, to see what each part of the build is charged.
async function openWith(text: string, sceneOptions: DxfSceneOptions) {
	const renderer = fakeRenderer()
	const viewer = new DxfViewer(dxfContainer(400, 300) as unknown as HTMLElement, {
		renderer: renderer as unknown as WebGLRenderer,
		autoResize: false,
		canvasWidth: 400,
		canvasHeight: 300,
		fileEncoding: encodingOf(text),
		sceneOptions: { releaseParsedDxf: true, ...sceneOptions }
	})

	return await finish(viewer)
}

async function timed<T>(run: () => Promise<T>): Promise<{ result: T; ms: number }> {
	const started = performance.now()
	const result = await run()

	return { result, ms: performance.now() - started }
}

// A B-spline point as dxf-viewer 1.0.51 computed it before the patch (thibauts/b-spline): the reference the patched
// evaluation must match.
function referenceSpline(t: number, degree: number, points: number[][], knots: number[]): number[] {
	const n = points.length
	const low = knots[degree] ?? 0
	const high = knots[knots.length - 1 - degree] ?? 0
	const at = Math.min(high, Math.max(low, t * (high - low) + low))
	let s = degree

	for (; s < knots.length - 1 - degree; s++) {
		if (at >= (knots[s] ?? 0) && at <= (knots[s + 1] ?? 0)) break
	}

	const v = Array.from({ length: n }, (_, i) => [...(points[i] ?? [0, 0]), 1])

	for (let l = 1; l <= degree + 1; l++) {
		for (let i = s; i > s - degree - 1 + l; i--) {
			const alpha = (at - (knots[i] ?? 0)) / ((knots[i + degree + 1 - l] ?? 0) - (knots[i] ?? 0))
			const row = v[i] ?? []
			const previous = v[i - 1] ?? []

			for (let j = 0; j < 3; j++) row[j] = (1 - alpha) * (previous[j] ?? 0) + alpha * (row[j] ?? 0)
		}
	}

	const result = v[s] ?? [0, 0, 1]

	return [(result[0] ?? 0) / (result[2] ?? 1), (result[1] ?? 0) / (result[2] ?? 1)]
}

function spline(points: number[][], degree: number, knots: number[]): string {
	return drawing(
		[0, "SPLINE", 8, "0", 70, 8, 71, degree, 72, knots.length, 73, points.length, 74, 0].concat(
			knots.flatMap(knot => [40, knot]),
			points.flatMap(([x, y]) => [10, x ?? 0, 20, y ?? 0, 30, 0])
		)
	)
}

beforeAll(() => {
	installDxfGlobals()
	// dxf-viewer logs its scene's figures and each entity it skips.
	vi.spyOn(console, "log").mockImplementation(() => undefined)
	vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("the CAD worker's viewer", () => {
	it("builds a drawing with its layers, text drawn in the offered face", async () => {
		serve(PLAN, "windows-1252")

		const { renderer, viewer, notices, loaded } = await open(PLAN)

		expect(loaded).toBe("loaded")
		expect([...viewer.GetLayers(true)].map(layer => layer.name).sort()).toEqual(["DIMS", "WALLS"])
		expect(viewer.GetBounds()).not.toBeNull()
		expect(notices).toEqual({ missingGlyphs: false, skipped: 0 })
		expect(renderer.renders).toBeGreaterThan(0)
		// The renderer's setSize wrote into the stubbed style.
		expect(renderer.domElement.style).toEqual({ width: "400px", height: "300px" })

		const before = renderer.renders

		viewer.ShowLayer("DIMS", false)
		expect([...viewer.GetLayers(true)].find(layer => layer.name === "DIMS")?.visible).toBe(false)
		expect(renderer.renders).toBe(before + 1)
	})

	it("reports text no offered font draws", async () => {
		const text = drawing([0, "TEXT", 8, "0", 10, 0, 20, 0, 30, 0, 40, 8, 1, "中文"])

		serve(text)

		const { notices, loaded } = await open(text)

		expect(loaded).toBe("loaded")
		expect(notices.missingGlyphs).toBe(true)
	})

	it("counts the fonts loaded against the budget", async () => {
		const text = drawing([0, "TEXT", 8, "0", 10, 0, 20, 0, 30, 0, 40, 8, 1, "Plan"])

		serve(text)
		expect((await openWith(text, { maxWork: 10_000, fontWork: () => 10_001 })).loaded).toBe("tooComplex")
		serve(text)
		expect((await openWith(text, { maxWork: 10_000, fontWork: () => 10 })).loaded).toBe("loaded")
	})

	it("fails a file that is no drawing", async () => {
		const text = "not a drawing at all\r\n"

		serve(text)

		expect((await open(text)).loaded).toBe("malformed")
	})
})

describe("the scene budget", () => {
	it("refuses blocks nested in blocks past it, quickly", async () => {
		const text = nestedBlocks(40)

		serve(text)

		const { result, ms } = await timed(() => open(text))

		expect(text.length).toBeLessThan(8192)
		expect(result.loaded).toBe("tooComplex")
		expect(ms).toBeLessThan(10_000)
	}, 60_000)

	it("builds nesting within it", async () => {
		const text = nestedBlocks(8)

		serve(text)

		expect((await open(text)).loaded).toBe("loaded")
	})

	it("stops a chain of blocks at 32 deep, at a cost that does not grow with the chain", async () => {
		const chain = (depth: number): string => {
			const blocks: (string | number)[] = []

			for (let level = 0; level < depth; level++) {
				blocks.push(
					0,
					"BLOCK",
					2,
					`C${String(level)}`,
					10,
					0,
					20,
					0,
					30,
					0,
					0,
					"LINE",
					8,
					"0",
					10,
					0,
					20,
					0,
					30,
					0,
					11,
					1,
					21,
					1,
					31,
					0
				)

				if (level < depth - 1) blocks.push(0, "INSERT", 2, `C${String(level + 1)}`, 10, 1, 20, 0, 30, 0)

				blocks.push(0, "ENDBLK")
			}

			return drawing([0, "INSERT", 2, "C0", 10, 0, 20, 0, 30, 0], blocks)
		}

		const deep = chain(40)

		serve(deep)

		const { notices, loaded } = await open(deep)

		expect(loaded).toBe("loaded")
		expect(notices.skipped).toBeGreaterThan(0)

		const long = chain(4000)

		serve(long)

		const { result, ms } = await timed(() => open(long))

		expect(result.loaded).not.toBe("malformed")
		expect(ms).toBeLessThan(10_000)
	}, 60_000)

	it("charges each block instance for the block's vertices, flattened or instanced", async () => {
		// A 10-vertex block: flattened while instances × vertices stay under 1024.
		const flattened = (inserts: number): string =>
			drawing(
				Array.from({ length: inserts }, (_, index) => [0, "INSERT", 2, "SMALL", 10, index * 2, 20, 0, 30, 0]).flat(),
				[0, "BLOCK", 2, "SMALL", 10, 0, 20, 0, 30, 0, 0, "LWPOLYLINE", 8, "0", 90, 10, 70, 0]
					.concat(Array.from({ length: 10 }, (_, index) => [10, index, 20, index % 2]).flat())
					.concat([0, "ENDBLK"])
			)

		serve(flattened(3))
		expect((await openWith(flattened(3), { maxWork: 1000 })).loaded).toBe("loaded")
		serve(flattened(100))
		expect((await openWith(flattened(100), { maxWork: 1000 })).loaded).toBe("tooComplex")

		// A 2000-vertex block inserted 10,000 times: 20M vertices to draw every frame.
		const instanced = drawing(
			Array.from({ length: 10_000 }, (_, index) => [0, "INSERT", 2, "BIG", 10, index, 20, 0, 30, 0]).flat(),
			[0, "BLOCK", 2, "BIG", 10, 0, 20, 0, 30, 0, 0, "LWPOLYLINE", 8, "0", 90, 2000, 70, 0]
				.concat(Array.from({ length: 2000 }, (_, index) => [10, index, 20, index % 7]).flat())
				.concat([0, "ENDBLK"])
		)

		serve(instanced)
		expect((await open(instanced)).loaded).toBe("tooComplex")
	}, 60_000)

	it("charges each render batch", async () => {
		const colored = (colors: number): string =>
			drawing(
				Array.from({ length: colors }, (_, index) => [
					...[0, "LINE", 8, "0", 420, 0x100000 + index, 10, 0, 20, index, 30, 0, 11, 1, 21, index, 31, 0]
				]).flat()
			)

		serve(colored(20))
		expect((await openWith(colored(20), { maxWork: 1000 })).loaded).toBe("tooComplex")

		const same = drawing(
			Array.from({ length: 20 }, (_, index) => [0, "LINE", 8, "0", 10, 0, 20, index, 30, 0, 11, 1, 21, index, 31, 0]).flat()
		)

		serve(same)
		expect((await openWith(same, { maxWork: 1000 })).loaded).toBe("loaded")
	})

	it("charges an arc's segments once", async () => {
		// 36 segments: 36 vertices and 72 indices, the entity, its visit and its batch.
		const circle = drawing([0, "CIRCLE", 8, "0", 10, 0, 20, 0, 30, 0, 40, 5])

		serve(circle)
		expect((await openWith(circle, { maxWork: 36 + 72 + 1 + 1 + 64 })).loaded).toBe("loaded")
		serve(circle)
		expect((await openWith(circle, { maxWork: 36 + 72 + 1 + 1 + 64 - 1 })).loaded).toBe("tooComplex")
	})
})

describe("one entity's work", () => {
	it("skips an arc whose angles are not finite or past any drawing's, at once", async () => {
		for (const text of [
			drawing([0, "ARC", 8, "0", 10, 0, 20, 0, 30, 0, 40, 1, 50, 1e300, 51, 0]),
			drawing([0, "ARC", 8, "0", 10, 0, 20, 0, 30, 0, 40, 1, 50, 10, 51, 20], [], [9, "$ANGBASE", 50, 1e300]),
			drawing([0, "ELLIPSE", 8, "0", 10, 0, 20, 0, 30, 0, 11, 2, 21, 0, 31, 0, 40, 0.5, 41, 1e300, 42, 0]),
			drawing([0, "ELLIPSE", 8, "0", 10, 0, 20, 0, 30, 0, 11, 2, 21, 0, 31, 0, 40, 0.5, 41, 1e15, 42, 0])
		]) {
			serve(text)

			const { result, ms } = await timed(() => open(text))

			expect(result.loaded).toBe("loaded")
			expect(result.notices.skipped).toBe(1)
			expect(ms).toBeLessThan(2000)
		}
	})

	it("normalises an arc's end past its start in one step, as turning it by 2π would", async () => {
		// 350° to 10°, and 350° to 10° + 3 turns: the end turned once, a 20° arc across 0°.
		for (const end of [10, 10 - 3 * 360]) {
			const text = drawing([0, "ARC", 8, "0", 10, 0, 20, 0, 30, 0, 40, 10, 50, 350, 51, end])

			serve(text)

			const { viewer, loaded } = await open(text)
			const bounds = viewer.GetBounds()
			const sin = 10 * Math.sin((10 * Math.PI) / 180)

			expect(loaded).toBe("loaded")
			expect(bounds?.minY).toBeCloseTo(-sin, 5)
			expect(bounds?.maxY).toBeCloseTo(sin, 5)
			expect(bounds?.minX).toBeGreaterThan(9.8)
		}
	})

	it("samples a spline as before, in time that grows with its degree only", async () => {
		const points = Array.from({ length: 12 }, (_, index) => [index * 3, (index * 7) % 5])
		const knots = [0, 0, 0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8]
		const text = spline(points, 3, knots)
		const reference = Array.from({ length: points.length * 4 + 1 }, (_, index) =>
			referenceSpline(index / (points.length * 4), 3, points, knots)
		)

		serve(text)

		const { viewer, loaded } = await open(text)
		const bounds = viewer.GetBounds()

		expect(loaded).toBe("loaded")
		expect(bounds?.minX).toBeCloseTo(Math.min(...reference.map(([x]) => x ?? 0)), 9)
		expect(bounds?.maxX).toBeCloseTo(Math.max(...reference.map(([x]) => x ?? 0)), 9)
		expect(bounds?.minY).toBeCloseTo(Math.min(...reference.map(([, y]) => y ?? 0)), 9)
		expect(bounds?.maxY).toBeCloseTo(Math.max(...reference.map(([, y]) => y ?? 0)), 9)

		// 8000 control points of degree 3 build quickly; degree 999 over 1000 is skipped before sampling.
		const many = Array.from({ length: 8000 }, (_, index) => [index, index % 3])
		const big = spline(many, 3, [0, 0, 0, ...Array.from({ length: 7998 }, (_, index) => index), 7997, 7997, 7997])

		serve(big)

		const built = await timed(() => open(big))

		expect(built.result.loaded).toBe("loaded")
		expect(built.result.notices.skipped).toBe(0)
		expect(built.ms).toBeLessThan(5000)

		const high = spline(
			Array.from({ length: 1000 }, (_, index) => [index, index % 3]),
			999,
			Array.from({ length: 2000 }, (_, index) => (index < 1000 ? 0 : 1))
		)

		serve(high)

		const refused = await timed(() => open(high))

		expect(refused.result.notices.skipped).toBe(1)
		expect(refused.ms).toBeLessThan(2000)
	}, 60_000)

	it("draws a solid fill too large to triangulate as its outline", async () => {
		const vertices = 50_000
		const zigzag = Array.from({ length: vertices }, (_, index) => [10, index % 2 === 0 ? 0 : 100, 20, index / 100]).flat()
		const text = drawing(
			[0, "HATCH", 8, "0", 10, 0, 20, 0, 30, 0, 2, "SOLID", 70, 1, 71, 0, 91, 1, 92, 3, 72, 0, 73, 1, 93, vertices].concat(
				zigzag,
				[97, 0, 75, 0, 76, 1, 98, 0]
			)
		)

		serve(text)

		const { result, ms } = await timed(() => open(text))

		expect(result.loaded).toBe("loaded")
		expect(result.notices.skipped).toBe(0)
		// Its outline is drawn: the zig-zag's full extent.
		expect(result.viewer.GetBounds()).toEqual({ minX: 0, maxX: 100, minY: 0, maxY: (vertices - 1) / 100 })
		expect(ms).toBeLessThan(5000)
	}, 60_000)

	it("skips a hatch past one entity's work before drawing it, and gives its charge back", async () => {
		// Dash steps that draw nothing: refused before they run.
		const spaces = hatch(20_000, true)

		serve(spaces)

		const { result, ms } = await timed(() => open(spaces))

		expect(result.loaded).toBe("loaded")
		expect(result.notices.skipped).toBe(1)
		expect(ms).toBeLessThan(2000)

		// Two hatches each charged up to the entity limit, then skipped: refunded, the build stays within its budget.
		const two = (entities: string): string => entities
		const dashed = hatch(2, false).replace(/49\r\n0\.0001\r\n49\r\n-0\.0001/, "49\r\n0.5\r\n49\r\n-0.5")
		const body = /0\r\nSECTION\r\n2\r\nENTITIES\r\n([\s\S]*)0\r\nENDSEC\r\n0\r\nEOF/.exec(dashed)?.[1] ?? ""
		const both = two(dashed.replace(body, body + body))

		serve(both)

		const refunded = await openWith(both, { maxWork: 6000, maxEntityWork: 5000 })

		expect(refunded.loaded).toBe("loaded")
		expect(refunded.notices.skipped).toBe(2)
	})

	it("skips text whose layout would pass one entity's work before laying it out", async () => {
		const text = drawing([0, "MTEXT", 8, "0", 10, 0, 20, 0, 30, 0, 40, 2, 1, "x".repeat(30_000)])

		serve(text)

		const { result, ms } = await timed(() => open(text))

		expect(result.notices.skipped).toBe(1)
		expect(ms).toBeLessThan(2000)
	})
})
