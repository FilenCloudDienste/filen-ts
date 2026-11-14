import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import {
	applyOcrPage,
	OcrClient,
	renderPageForOcr,
	runOcrPages,
	serveOcr,
	type OcrModel,
	type OcrRunReport,
	type TesseractCore,
	type TesseractFactory
} from "@filen/office/dom/pdfedit/ocr"
import { scannedPdf, stubGraft, textPage } from "@filen/office/testing/ocr"
import { transformPoint } from "@filen/office/core/pdfedit/ocrGeometry"

// The whole text recognition path in Node with the real engine: MuPDF renders a scanned page, tesseract.js-core
// (the SIMD LSTM build, English model from the pinned tessdata_fast commit) recognises it into a text-only PDF page,
// a stand-in graft draws it over the page, and the saved file is read back by MuPDF and pdf.js: the words are found
// and their boxes lie where the scanned words are.

const { readTessdataManifest, ensureTessdata } = await import("../../vite/ocr-tessdata")

const LINES = ["The quick brown fox jumps over the lazy dog.", "Filen recognises scanned pages 12345."]
const CORE_DIR = dirname(createRequire(import.meta.url).resolve("tesseract.js-core/package.json"))

function isFactory(value: unknown): value is TesseractFactory {
	return typeof value === "function"
}

let model: OcrModel
let modelBytes: Uint8Array<ArrayBuffer>
let core: TesseractCore

beforeAll(async () => {
	const manifest = readTessdataManifest()
	const eng = manifest.languages.find(language => language.code === "eng")

	if (eng === undefined) throw new Error("no eng model pinned")

	const dir = await ensureTessdata(manifest, ["eng"])

	modelBytes = new Uint8Array(readFileSync(join(dir, eng.file)))
	model = { code: "eng", url: "eng", bytes: eng.bytes, sha256: eng.sha256, transferBytes: eng.gzipBytes }

	const factory: unknown = createRequire(import.meta.url)(join(CORE_DIR, "tesseract-core-simd-lstm.js"))
	const wasm = await WebAssembly.compile(readFileSync(join(CORE_DIR, "tesseract-core-simd-lstm.wasm")))

	if (!isFactory(factory)) throw new Error("no factory")

	core = {
		factory,
		instantiate: async imports => ({ instance: await WebAssembly.instantiate(wasm, imports as WebAssembly.Imports), module: wasm })
	}
}, 120_000)

// A worker in this thread: the client's messages reach the server's listener and back, asynchronously.
function inProcessWorker(): { readonly client: OcrClient; readonly stop: () => void } {
	type Listener = (event: { readonly data: unknown }) => void
	const toServer = new Set<Listener>()
	const toClient = new Set<Listener>()
	const stop = serveOcr(
		core,
		{
			postMessage: message => {
				queueMicrotask(() => {
					for (const listener of toClient) listener({ data: message })
				})
			},
			addEventListener: (_type, listener) => toServer.add(listener),
			removeEventListener: (_type, listener) => toServer.delete(listener)
		},
		{
			fetchModel: (asked, onBytes) => {
				expect(asked.code).toBe("eng")
				onBytes(modelBytes.byteLength)

				return Promise.resolve(modelBytes.slice())
			},
			sha256: bytes => Promise.resolve(createHash("sha256").update(bytes).digest("hex"))
		}
	)
	const client = new OcrClient({
		postMessage: message => {
			queueMicrotask(() => {
				for (const listener of toServer) listener({ data: message })
			})
		},
		addEventListener: (type: "message" | "error", listener: (event: { readonly data: unknown }) => void) => {
			if (type === "message") toClient.add(listener)
		},
		terminate: stop
	})

	return { client, stop }
}

interface Recognised {
	readonly saved: Uint8Array
	readonly report: OcrRunReport
	readonly ms: number
}

async function recognise(pdf: Uint8Array): Promise<Recognised> {
	const { client, stop } = inProcessWorker()
	const document = new mupdf.PDFDocument(pdf)

	try {
		await client.call("load", { models: [model] })

		const started = performance.now()
		const report = await runOcrPages({
			pages: [0],
			render: page => Promise.resolve(renderPageForOcr(mupdf, document, page)),
			flush: () => {
				mupdf.emptyStore()

				return Promise.resolve()
			},
			recognisers: [args => client.call("recognise", args, [args.pixels.buffer])],
			apply: edit => {
				applyOcrPage(mupdf, stubGraft, document, edit)

				return Promise.resolve()
			}
		})
		const ms = performance.now() - started

		return { saved: document.saveToBuffer("garbage=compact,compress").asUint8Array().slice(), report, ms }
	} finally {
		document.destroy()
		stop()
	}
}

// A word's box on page 1 in user space, by MuPDF's search: [x0, y0, x1, y1].
function wordBox(pdf: Uint8Array, word: string): readonly [number, number, number, number] {
	const document = new mupdf.PDFDocument(pdf)
	const page = document.loadPage(0)
	const hits = page.search(word, "")
	const quad = hits[0]?.[0]
	const transform = mupdf.Matrix.invert(page.getTransform())

	page.destroy()
	document.destroy()

	if (quad === undefined) throw new Error(`"${word}" not found`)

	const points = [0, 2, 4, 6].map(index => transformPoint(transform, quad[index] ?? 0, quad[index + 1] ?? 0))
	const xs = points.map(point => point[0])
	const ys = points.map(point => point[1])

	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

// Where the scanned words are: the source page's own text (upright scan placed full page).
const source = textPage(LINES).saveToBuffer("").asUint8Array().slice()

async function pdfjsText(pdf: Uint8Array): Promise<string> {
	const task = pdfjs.getDocument({ data: pdf.slice(), verbosity: 0 })
	const document = await task.promise
	const page = await document.getPage(1)
	const content = await page.getTextContent()
	const text = content.items.map(item => ("str" in item ? item.str : "")).join(" ")

	await task.destroy()

	return text
}

const timings: number[] = []

afterAll(() => {
	if (timings.length > 0) console.info(`ocr: ${timings.map(ms => `${ms.toFixed(0)} ms`).join(", ")} per page (Node, simd-lstm)`)
})

describe("OCR pipeline (Node, real engine)", () => {
	it("makes a scanned page searchable with text over the scanned words", async () => {
		const { saved, report, ms } = await recognise(scannedPdf({ lines: LINES, dpi: 300 }))

		timings.push(ms)
		expect(report.outcomes).toEqual([expect.objectContaining({ page: 0, status: "done" })])

		const text = await pdfjsText(saved)

		for (const word of ["quick", "brown", "lazy", "Filen", "recognises", "12345"]) expect(text).toContain(word)

		// Whole words (a glyph-less font spreads a word's box evenly over its letters, so only words line up), with the
		// line's baseline: its glyphs rise from it, the source font's also reach below.
		for (const [word, baseline] of [
			["quick", 700],
			["jumps", 700],
			["recognises", 660],
			["scanned", 660]
		] as const) {
			const found = wordBox(saved, word)
			const expected = wordBox(source, word)

			expect(Math.abs(found[0] - expected[0])).toBeLessThanOrEqual(2)
			expect(Math.abs(found[2] - expected[2])).toBeLessThanOrEqual(2)
			expect(Math.abs(found[1] - baseline)).toBeLessThanOrEqual(2)
		}
	}, 60_000)

	it("reads a scan placed on its side and a page with /Rotate", async () => {
		for (const options of [{ imageTurns: 1 as const }, { rotate: 90 as const }]) {
			const { saved, report } = await recognise(scannedPdf({ lines: LINES, dpi: 200, ...options }))

			expect(report.outcomes[0]?.status).toBe("done")
			expect(await pdfjsText(saved)).toContain("quick")
		}
	}, 60_000)

	it("turns an upside-down scan before reading it", async () => {
		const { saved, report } = await recognise(scannedPdf({ lines: LINES, dpi: 200, contentTurns: 2 }))
		const outcome = report.outcomes[0]

		expect(outcome?.status).toBe("done")
		expect(outcome?.status === "done" ? outcome.confidence : 0).toBeGreaterThan(70)

		// Upside down on the page: the word sits mirrored about the page centre.
		const found = wordBox(saved, "quick")
		const expected = wordBox(source, "quick")

		expect(Math.abs(found[0] - (612 - expected[2]))).toBeLessThanOrEqual(3)
		expect(Math.abs(found[2] - (612 - expected[0]))).toBeLessThanOrEqual(3)
	}, 60_000)

	it("refuses a model that does not match its pin", async () => {
		const { client, stop } = inProcessWorker()

		await expect(client.call("load", { models: [{ ...model, sha256: "0".repeat(64) }] })).rejects.toMatchObject({
			failure: "modelFailed"
		})
		await expect(
			client.call("recognise", { pixels: new Uint8Array(4), width: 2, height: 2, stride: 2, dpi: 300, orient: false })
		).rejects.toMatchObject({
			failure: "notReady"
		})
		stop()
	}, 60_000)
})
