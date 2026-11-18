import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Color, type WebGLRenderer } from "three"
import { PDF_FACES, decodeFace } from "@filen/office/core/pdfwrite/fonts"
import { dxfCanvas, installDxfGlobals } from "@/features/preview/lib/dxfStubs"
import {
	DXF_DRAWING_PATH,
	DXF_FONT_PATH_PREFIX,
	createDxfViewer,
	dxfLoadFailure,
	loadDxf,
	watchDxfMessages
} from "@/features/preview/lib/dxfScene"
import { regularFace } from "@/features/preview/lib/dxfFonts.logic"
import { dxfFileEncoding } from "@/features/preview/lib/dxfEncoding.logic"

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

function drawing(entities: (string | number)[], blocks: (string | number)[] = [], header: (string | number)[] = []): string {
	return dxf(...section("HEADER", ...header), ...section("BLOCKS", ...blocks), ...section("ENTITIES", ...entities), 0, "EOF")
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

async function open(text: string) {
	const renderer = fakeRenderer()
	const encoding = dxfFileEncoding(new TextEncoder().encode(text))
	const viewer = createDxfViewer(renderer as unknown as WebGLRenderer, {
		width: 400,
		height: 300,
		background: new Color(0xffffff),
		pointSize: 2,
		encoding
	})
	const notices = watchDxfMessages(viewer)
	const loaded = await loadDxf(viewer, ARIMO === undefined ? [] : [ARIMO.file]).then(
		() => "loaded" as const,
		(error: unknown) => dxfLoadFailure(error)
	)

	return { renderer, viewer, notices, loaded }
}

beforeAll(() => {
	installDxfGlobals()
	// dxf-viewer logs its scene's figures.
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

	it("refuses blocks nested in blocks past the scene budget, quickly", async () => {
		const text = nestedBlocks(40)

		serve(text)

		const started = performance.now()
		const { loaded } = await open(text)

		expect(text.length).toBeLessThan(8192)
		expect(loaded).toBe("tooComplex")
		// The whole budget is spent first: seconds, not the 2^40 visits the file asks for.
		expect(performance.now() - started).toBeLessThan(30_000)
	}, 60_000)

	it("builds nesting within the budget", async () => {
		const text = nestedBlocks(8)

		serve(text)

		expect((await open(text)).loaded).toBe("loaded")
	})

	it("refuses an arc whose angles would turn without end", async () => {
		const text = drawing([0, "ARC", 8, "0", 10, 0, 20, 0, 30, 0, 40, 1, 50, 1e300, 51, 0])

		serve(text)

		expect((await open(text)).loaded).toBe("tooComplex")
	})

	it("refuses a hatch whose dash steps go past the budget, even when they draw nothing", async () => {
		const text = hatch(20_000, true)

		serve(text)

		expect((await open(text)).loaded).toBe("tooComplex")
	})

	it("leaves out a hatch drawing more than one entity may, and draws the rest", async () => {
		const text = hatch(20_000, false)

		serve(text)

		const { loaded, notices } = await open(text)

		expect(loaded).toBe("loaded")
		expect(notices.skipped).toBe(1)
	})

	it("fails a file that is no drawing", async () => {
		const text = "not a drawing at all\r\n"

		serve(text)

		expect((await open(text)).loaded).toBe("malformed")
	})
})
