import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import { PdfEngineError } from "../../dom/pdfedit/client"
import { isFatalEngineError } from "../../dom/pdfedit/server"
import { abortSyncRange } from "../../dom/pdfedit/syncRange"
import { estimateSavePeak, fitsBudget, PDF_DESKTOP_MEMORY, PDF_MOBILE_MEMORY } from "../../core/pdfedit/budget"
import { makePdf, wasmTrap } from "./fixtures"
import { startEngine, stopEngines } from "./harness"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { pdfSignatureFields } from "../../dom/pdf/signatureFields"
import { signedFixture } from "../pdfSignFixtures"
import { budget } from "../timing"

afterEach(stopEngines)

function rgbaOf(value: unknown): Uint8ClampedArray {
	const bitmap: unknown = Reflect.get(value as object, "bitmap")

	return Reflect.get(bitmap as object, "rgba") as Uint8ClampedArray
}

const TIMEOUT = budget(30_000)

describe("the PDF engine over the sync range bridge", () => {
	const imagePdf = makePdf({ pages: 60, imageBytes: 48 * 1024 })

	it(
		"opens a document and renders a tile reading only part of the file",
		async () => {
			const engine = startEngine(imagePdf)
			const opened = await engine.open()

			expect(opened.status).toBe("open")
			expect(opened.status === "open" ? opened.document.pageCount : 0).toBe(60)

			const pages = await engine.client.call("pages", { from: 0, count: 2 })

			expect(pages[0]).toMatchObject({ width: 595, height: 842 })

			const tile = await engine.client.call("render", {
				page: 0,
				scale: 0.5,
				rotation: 0,
				tile: [0, 0, 256, 256],
				priority: "visible"
			})

			expect(tile.tile).toEqual([0, 0, 256, 256])
			expect(engine.stats.bytesRead).toBeLessThan(imagePdf.length / 3)
		},
		TIMEOUT
	)

	it(
		"draws a tile exactly as MuPDF draws the whole page",
		async () => {
			const engine = startEngine(imagePdf)

			await engine.open()

			const scale = 0.75
			const tile = await engine.client.call("render", {
				page: 3,
				scale,
				rotation: 0,
				tile: [100, 200, 300, 380],
				priority: "visible"
			})
			const document = mupdf.Document.openDocument(imagePdf.slice(), "application/pdf")
			const page = document.loadPage(3)
			const whole = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
			const samples = whole.getPixels()
			const stride = whole.getStride()
			const rgba = rgbaOf(tile)
			let differing = 0

			for (let y = 0; y < 180; y++) {
				for (let x = 0; x < 200; x++) {
					const from = (y + 200) * stride + (x + 100) * 3
					const to = (y * 200 + x) * 4

					for (let channel = 0; channel < 3; channel++) {
						if (Math.abs((samples[from + channel] ?? 0) - (rgba[to + channel] ?? 0)) > 2) differing++
					}

					if (rgba[to + 3] !== 255) differing++
				}
			}

			whole.destroy()
			page.destroy()
			document.destroy()
			expect(differing).toBe(0)
		},
		TIMEOUT
	)

	it(
		"fails a read that fails or never comes back by its deadline, and reads it again on the next request",
		async () => {
			const blockBytes = 64 * 1024
			const lastBlock = Math.floor((imagePdf.length - 1) / blockBytes)
			const engine = startEngine(imagePdf, {
				blockBytes,
				failBlocks: new Set([lastBlock - 30]),
				hangBlocks: new Set([lastBlock - 20]),
				deadlineMs: 400,
				readAhead: 0
			})

			await engine.open()

			const failures: string[] = []
			let rendered = 0

			for (let page = 0; page < 60; page++) {
				const render = () =>
					engine.client.call("render", { page, scale: 0.1, rotation: 0, tile: [0, 0, 60, 84], priority: "visible" })

				await render().then(
					() => {
						rendered++
					},
					async (error: unknown) => {
						failures.push(error instanceof PdfEngineError ? `${error.failure}:${error.message}` : String(error))
						// The same page again: its bytes arrive this time.
						await render()
						rendered++
					}
				)
			}

			expect(failures).toEqual(["readFailed:failed", "readFailed:timeout"])
			expect(rendered).toBe(60)
		},
		TIMEOUT
	)

	it(
		"fails a waiting read at once when the reads are aborted",
		async () => {
			const blockBytes = 64 * 1024
			const lastBlock = Math.floor((imagePdf.length - 1) / blockBytes)
			const engine = startEngine(imagePdf, { blockBytes, hangBlocks: new Set([lastBlock - 30]) })

			await engine.open()

			const started = Date.now()
			const pending: Promise<unknown>[] = []

			for (let page = 0; page < 60; page++) {
				pending.push(
					engine.client
						.call("render", { page, scale: 0.1, rotation: 0, tile: [0, 0, 60, 84], priority: "visible" })
						.catch((error: unknown) => error)
				)
			}

			setTimeout(() => {
				abortSyncRange(engine.buffer)
			}, 300)

			const outcomes = await Promise.all(pending)

			expect(outcomes.some(outcome => outcome instanceof PdfEngineError && outcome.message === "aborted")).toBe(true)
			expect(Date.now() - started).toBeLessThan(budget(10_000))
		},
		TIMEOUT
	)

	it(
		"asks for a password and opens with the right one",
		async () => {
			const locked = makePdf({ pages: 2, userPassword: "user pass", ownerPassword: "owner pass" })
			const engine = startEngine(locked)

			expect((await engine.open()).status).toBe("password")
			expect((await engine.client.call("authenticate", { password: "wrong" })).status).toBe("password")

			const owner = await engine.client.call("authenticate", { password: "owner pass" })

			expect(owner).toMatchObject({ status: "open", access: "owner" })

			const user = startEngine(locked)
			const opened = await user.open("user pass")

			expect(opened).toMatchObject({ status: "open", access: "user" })
			expect(opened.status === "open" ? opened.document.encryption : "").toMatch(/AES/i)
		},
		TIMEOUT
	)

	it(
		"refuses a file that is not a PDF",
		async () => {
			const engine = startEngine(new TextEncoder().encode("not a pdf at all ".repeat(100)))

			await expect(engine.open()).rejects.toBeInstanceOf(PdfEngineError)
		},
		TIMEOUT
	)

	it(
		"poisons the engine on a wasm trap and refuses everything after it",
		async () => {
			const engine = startEngine(imagePdf, { trapOnHeap: true })
			let heard = ""

			engine.client.onPoisoned(message => {
				heard = message
			})
			await engine.open()
			await expect(engine.client.call("heap", {})).rejects.toMatchObject({ failure: "poisoned" })
			expect(heard).toBe("unreachable")
			expect(engine.client.poisoned).toBe("unreachable")
			await expect(engine.client.call("pages", { from: 0, count: 1 })).rejects.toMatchObject({ failure: "poisoned" })
		},
		TIMEOUT
	)

	it(
		"reports the heap and frees the document on close",
		async () => {
			const engine = startEngine(imagePdf)

			await engine.open()

			const { heapBytes } = await engine.client.call("close", {})

			expect(heapBytes).toBeGreaterThan(1024 * 1024)
			await expect(engine.client.call("pages", { from: 0, count: 1 })).rejects.toMatchObject({ failure: "closed" })
		},
		TIMEOUT
	)
})

// What pdf.js reads of the signatures, the cross-check the page passes in.
async function pdfjsHints(bytes: Uint8Array) {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
	const hints = pdfSignatureFields(await (await task.promise).getSignatures())

	await task.destroy()

	return hints
}

describe("signature verification in the engine", () => {
	it(
		"verifies a signed file read through the bridge",
		async () => {
			const bytes = signedFixture("approval-rsa.pdf")
			const engine = startEngine(bytes)

			await engine.open()

			const report = await engine.client.call("verifySignatures", { fields: await pdfjsHints(bytes) })

			expect(report.signatures.map(signature => signature.state)).toEqual(["unchanged"])
		},
		TIMEOUT
	)

	it(
		"opens the signed revision of a file changed after signing over the same reader",
		async () => {
			const bytes = signedFixture("approval-content-changed.pdf")
			const engine = startEngine(bytes)

			await engine.open()

			const report = await engine.client.call("verifySignatures", { fields: await pdfjsHints(bytes) })

			expect(report.signatures.map(signature => [signature.state, signature.changes?.allowed])).toEqual([["changed", false]])
		},
		TIMEOUT
	)
})

describe("engine errors and budgets", () => {
	it("tells fatal engine errors from refusals", () => {
		expect(isFatalEngineError(wasmTrap())).toBe(true)
		expect(isFatalEngineError("ABORT")).toBe(true)
		expect(isFatalEngineError(new Error("malloc (1048576 bytes) failed"))).toBe(true)
		expect(isFatalEngineError(new RangeError("Maximum call stack size exceeded"))).toBe(true)
		expect(isFatalEngineError("TRYLATER")).toBe(false)
		expect(isFatalEngineError(new Error("cannot find object in xref"))).toBe(false)
	})

	it("sizes saves against the budget", () => {
		expect(fitsBudget(estimateSavePeak(PDF_DESKTOP_MEMORY.editMaxBytes, false), PDF_DESKTOP_MEMORY)).toBe(true)
		expect(fitsBudget(estimateSavePeak(PDF_DESKTOP_MEMORY.editMaxBytes + 1024 * 1024, false), PDF_DESKTOP_MEMORY)).toBe(false)
		expect(PDF_MOBILE_MEMORY.editMaxBytes).toBeLessThan(PDF_DESKTOP_MEMORY.editMaxBytes)
		expect(estimateSavePeak(10, true)).toBeGreaterThan(estimateSavePeak(10, false))
	})
})
