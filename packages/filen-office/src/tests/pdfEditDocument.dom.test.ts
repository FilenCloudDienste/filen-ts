import { describe, expect, it } from "vitest"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { makePdf } from "./pdfedit/fixtures"
import { pdfLinks } from "../dom/pdf/links"
import { PdfFinder } from "../dom/pdf/find"
import type { PdfPageText } from "../dom/pdfedit/text"
import { MupdfPdfDocument, PageViewport, placementKey, placementPosition, placementStart, type PdfEditEngine } from "../react/pdfedit/index"

// The editor's engine behind pdf.js's document contract (react/pdfedit/mupdfDocument.ts), over a stand-in engine.

const TEXT: PdfPageText = {
	lines: [{ str: "Hello world", x: 72, y: 760, size: 18, dx: 1, dy: 0, width: 100 }],
	links: [
		{ rect: [72, 450, 200, 470], url: "https://filen.io/" },
		{ rect: [72, 420, 200, 440], page: 1, left: 0, top: 800 }
	]
}

interface Drawn {
	readonly tile: readonly number[]
	readonly at: readonly [number, number]
}

function fakeEngine(): { readonly engine: PdfEditEngine; readonly calls: string[]; readonly tiles: unknown[] } {
	const calls: string[] = []
	const tiles: unknown[] = []
	const call = (op: string, args: unknown): Promise<unknown> => {
		calls.push(op)

		if (op === "pages") return Promise.resolve([{ width: 595, height: 842, label: "1" }])
		if (op === "text") return Promise.resolve(TEXT)
		if (op === "destination") return Promise.resolve({ page: 1, left: 10, top: 20 })
		if (op === "render") {
			tiles.push(args)

			return Promise.resolve({ bitmap: { width: 1, height: 1, close: () => undefined }, tile: Reflect.get(args as object, "tile") })
		}

		return Promise.resolve(null)
	}

	return {
		engine: {
			call: call as PdfEditEngine["call"],
			queued: ((op: string, args: unknown) => ({ promise: call(op, args), cancel: () => undefined })) as PdfEditEngine["queued"]
		},
		calls,
		tiles
	}
}

const FACTS = { info: { Title: "T" }, permissions: null, signatures: null, outline: null }

describe("the editor's document", () => {
	it("lays pages out as pdf.js would", async () => {
		const task = pdfjs.getDocument({ data: makePdf({ pages: 1 }), verbosity: 0 })
		const pdfjsPage = await (await task.promise).getPage(1)

		for (const rotation of [0, 90, 180, 270]) {
			const ours = new PageViewport({ viewBox: [0, 0, 595, 842], scale: 1.5, rotation })
			const theirs = pdfjsPage.getViewport({ scale: 1.5, rotation })

			expect(ours.transform).toEqual(theirs.transform)
			expect([ours.width, ours.height]).toEqual([theirs.width, theirs.height])
			expect(ours.convertToViewportPoint(72, 760)).toEqual(theirs.convertToViewportPoint(72, 760))
			expect(ours.clone({ scale: 2 }).transform).toEqual(theirs.clone({ scale: 2 }).transform)
		}

		await task.destroy()
	})

	it("serves text, links and tiles from the engine", async () => {
		const { engine, tiles } = fakeEngine()
		const document = MupdfPdfDocument.open(engine, { pageCount: 2, tileSize: 512, facts: FACTS })
		const page = await document.getPage(1)
		const viewport = page.getViewport({ scale: 1.5, rotation: 0 })

		expect([viewport.width, viewport.height]).toEqual([892.5, 1263])

		const content = await page.getTextContent()

		expect(content.items).toEqual([
			expect.objectContaining({ str: "Hello world", transform: [18, 0, -0, 18, 72, 760], width: 100, hasEOL: true })
		])
		expect(pdfLinks(await page.getAnnotations({ intent: "display" }))).toEqual([
			{ kind: "external", rect: [72, 450, 200, 470], url: "https://filen.io/" },
			{ kind: "internal", rect: [72, 420, 200, 440], dest: [1, { name: "XYZ" }, 0, 800, null] }
		])

		const drawn: Drawn[] = []
		const context = {
			canvas: { width: 1000, height: 600 },
			drawImage: (_bitmap: unknown, x: number, y: number) => {
				drawn.push({ tile: [], at: [x, y] })
			}
		}

		await page.render({ canvasContext: context, viewport, transform: [2, 0, 0, 2, 0, 0] }).promise
		expect(tiles).toEqual([
			{ page: 0, scale: 3, rotation: 0, tile: [0, 0, 512, 512], priority: "visible" },
			{ page: 0, scale: 3, rotation: 0, tile: [512, 0, 1000, 512], priority: "visible" },
			{ page: 0, scale: 3, rotation: 0, tile: [0, 512, 512, 600], priority: "visible" },
			{ page: 0, scale: 3, rotation: 0, tile: [512, 512, 1000, 600], priority: "visible" }
		])
		expect(drawn.map(entry => entry.at)).toEqual([
			[0, 0],
			[512, 0],
			[0, 512],
			[512, 512]
		])
		expect(await document.getMetadata()).toEqual({ info: { Title: "T" } })
		expect(await document.getPageIndex({ num: 7, gen: 0 })).toBe(1)
	})

	it("hands out new page objects only for the pages a change touched", async () => {
		const { engine, calls } = fakeEngine()
		const first = MupdfPdfDocument.open(engine, { pageCount: 2, tileSize: 512, facts: FACTS })
		const one = await first.getPage(1)
		const two = await first.getPage(2)
		const next = first.next([1], 2)

		expect(next).not.toBe(first)
		expect(await next.getPage(1)).toBe(one)
		expect(await next.getPage(2)).not.toBe(two)
		expect(calls.filter(op => op === "pages")).toHaveLength(3)
	})

	it("finds text through the viewer's finder", async () => {
		const { engine } = fakeEngine()
		const document = MupdfPdfDocument.open(engine, { pageCount: 2, tileSize: 512, facts: FACTS })
		const finder = new PdfFinder(document, { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 })
		const result = await finder.search("world", false, { aborted: false })

		expect(result?.matches.length).toBe(10)
	})
})

describe("keyboard placement", () => {
	const page = { width: 600, height: 800 }

	it("places, moves, resizes and stays on the page", () => {
		let rect = placementStart(page, { width: 100, height: 50 })

		expect(rect).toEqual({ x: 250, y: 375, width: 100, height: 50 })

		const step = (key: string, shiftKey = false, altKey = false) => {
			const next = placementKey(rect, page, { key, shiftKey, altKey })

			if (next?.kind === "move") rect = next.rect

			return next
		}

		step("ArrowRight", true)
		step("ArrowUp")
		expect(rect).toMatchObject({ x: 260, y: 376 })
		step("ArrowDown", false, true)
		expect(rect).toMatchObject({ y: 375, height: 51 })
		expect(placementPosition(rect, page)).toEqual({ left: 260, top: 374, width: 100, height: 51 })

		for (let index = 0; index < 100; index++) step("ArrowLeft", true)

		expect(rect.x).toBe(0)
		expect(step("Enter")).toEqual({ kind: "commit" })
		expect(step("Escape")).toEqual({ kind: "cancel" })
		expect(step("a")).toBeNull()
	})
})
