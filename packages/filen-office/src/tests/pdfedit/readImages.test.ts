import { afterEach, describe, expect, it } from "vitest"
import { PdfEngineError, type PdfEngineClient } from "../../dom/pdfedit/client"
import { MUPDF_FORMATS, type MupdfFormat } from "../../dom/pdfedit/formats"
import type { PdfEngineArgs, PdfEngineValue } from "../../dom/pdfedit/protocol"
import { localEngine, stopLocalEngines } from "./localEngine"
import { startEngine, stopEngines } from "./harness"
import { imageSample, makePsd, makeTiff } from "./imageFixtures"
import { budget } from "../timing"

// The read role's image files (TIFF, Photoshop): a page per image, drawn whole into one bitmap or RGBA buffer, and the
// image's extent read from its header and the page's bounds without decoding it.

afterEach(() => {
	stopLocalEngines()
	stopEngines()
})

const UNBOUNDED = 1e12

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise

		return "ok"
	} catch (error) {
		return error instanceof PdfEngineError ? error.failure : String(error)
	}
}

async function open(format: MupdfFormat, bytes: Uint8Array, maxImagePixels = UNBOUNDED): Promise<PdfEngineClient> {
	const client = localEngine()

	await client.call("open", { bytes, role: "read", format, maxImagePixels })

	return client
}

async function rgba(
	client: PdfEngineClient,
	args: Omit<PdfEngineArgs<"renderPage">, "output" | "generation">
): Promise<Extract<PdfEngineValue<"renderPage">, { readonly output: "rgba" }>> {
	const value = await client.call("renderPage", { ...args, generation: 0, output: "rgba" })

	if (value.output !== "rgba") throw new Error("not the asked output")

	return value
}

function sampleAt(value: { readonly rgba: Uint8ClampedArray; readonly width: number }, x: number, y: number): number[] {
	const at = (y * value.width + x) * 4

	return [...value.rgba.subarray(at, at + 4)]
}

describe("the read role's image files", () => {
	it("opens every page of a TIFF and reads each image's extent from its header and the page at its resolution", async () => {
		const client = await open(
			"tiff",
			makeTiff(
				[
					[300, 200],
					[50, 40]
				],
				144
			)
		)
		const pages = await client.call("pages", { from: 0, count: 10, generation: 0 })

		// Points: pixels × 72 / 144.
		expect(pages.map(page => [page.width, page.height])).toEqual([
			[150, 100],
			[25, 20]
		])
		expect(await client.call("imageExtent", { page: 0, generation: 0 })).toEqual({ width: 300, height: 200 })
		expect(await client.call("imageExtent", { page: 1, generation: 0 })).toEqual({ width: 50, height: 40 })
		expect(await failure(client.call("imageExtent", { page: 2, generation: 0 }))).toBe("badRequest")
		expect(await failure(client.call("layout", { width: 400, height: 600, em: 11, generation: 1 }))).toBe("badRequest")
	})

	it("draws a page whole at its own pixels, never above them, and scaled down to fit", async () => {
		const client = await open("tiff", makeTiff([[300, 200]], 144))
		const own = await rgba(client, { page: 0, maxPixels: UNBOUNDED })

		expect([own.width, own.height, own.rgba.length]).toEqual([300, 200, 300 * 200 * 4])
		expect(sampleAt(own, 0, 0)).toEqual([imageSample(0, 0, 0, 0), imageSample(0, 0, 0, 1), imageSample(0, 0, 0, 2), 255])
		expect(sampleAt(own, 299, 199)).toEqual([
			imageSample(0, 299, 199, 0),
			imageSample(0, 299, 199, 1),
			imageSample(0, 299, 199, 2),
			255
		])

		const fitted = await rgba(client, { page: 0, maxPixels: (300 * 200) / 4 })

		expect([fitted.width, fitted.height]).toEqual([150, 100])

		const bitmap = await client.call("renderPage", { page: 0, generation: 0, maxPixels: 1000, output: "bitmap" })

		expect(bitmap.output).toBe("bitmap")
		expect(bitmap.output === "bitmap" ? [bitmap.bitmap.width, bitmap.bitmap.height] : []).toEqual([38, 25])
	})

	it("assembles a page of several tiles in place", async () => {
		const client = await open("tiff", makeTiff([[1500, 1100]]))
		const page = await rgba(client, { page: 0, maxPixels: UNBOUNDED })

		expect([page.width, page.height]).toEqual([1500, 1100])

		for (const [x, y] of [
			[1023, 1023],
			[1024, 1024],
			[1499, 0],
			[0, 1099],
			[1300, 1050]
		] as const)
			expect([x, y, ...sampleAt(page, x, y)]).toEqual([
				x,
				y,
				imageSample(0, x, y, 0),
				imageSample(0, x, y, 1),
				imageSample(0, x, y, 2),
				255
			])
	})

	it("opens a flattened Photoshop file as one page", async () => {
		const client = await open("psd", makePsd(120, 80))

		expect(await client.call("pages", { from: 0, count: 10, generation: 0 })).toHaveLength(1)
		expect(await client.call("imageExtent", { page: 0, generation: 0 })).toEqual({ width: 120, height: 80 })

		const page = await rgba(client, { page: 0, maxPixels: UNBOUNDED })

		expect([page.width, page.height]).toEqual([120, 80])
		expect(sampleAt(page, 7, 5)).toEqual([imageSample(0, 7, 5, 0), imageSample(0, 7, 5, 1), imageSample(0, 7, 5, 2), 255])
	})

	it("refuses a page whose image is over the pixel budget before decoding it, and still gives its extent", async () => {
		const client = await open("tiff", makeTiff([[300, 200]]), 300 * 200 - 1)

		expect(await client.call("imageExtent", { page: 0, generation: 0 })).toEqual({ width: 300, height: 200 })

		const before = await client.call("heap", {})

		expect(await failure(client.call("renderPage", { page: 0, generation: 0, maxPixels: 100, output: "rgba" }))).toBe("overBudget")
		expect(
			await failure(
				client.call("render", { page: 0, generation: 0, scale: 1, rotation: 0, tile: [0, 0, 64, 64], priority: "visible" })
			)
		).toBe("overBudget")
		expect(await client.call("heap", {})).toEqual(before)
	})

	it("refuses a malformed request, a stale generation and a damaged file", async () => {
		const client = await open("tiff", makeTiff([[30, 20]]))

		for (const maxPixels of [0, Number.NaN, Number.POSITIVE_INFINITY])
			expect(await failure(client.call("renderPage", { page: 0, generation: 0, maxPixels, output: "rgba" }))).toBe("badRequest")

		expect(
			await failure(client.call("renderPage", { page: 0, generation: 0, maxPixels: 100, output: "png" as unknown as "rgba" }))
		).toBe("badRequest")
		expect(await failure(client.call("renderPage", { page: 0, generation: 1, maxPixels: 100, output: "rgba" }))).toBe("cancelled")
		expect(await failure(open("tiff", new Uint8Array(64)))).toBe("notSupported")
		expect(await failure(open("psd", new Uint8Array(64)))).toBe("notSupported")
	})

	it(
		"draws a TIFF read through the sync range channel",
		async () => {
			const engine = startEngine(
				makeTiff([
					[200, 100],
					[10, 10]
				])
			)
			const opened = await engine.openRead({ format: "tiff", maxImagePixels: UNBOUNDED })

			expect(opened.status === "open" ? opened.document.pageCount : 0).toBe(2)

			const page = await engine.client.call("renderPage", { page: 0, generation: 0, maxPixels: UNBOUNDED, output: "rgba" })

			expect(page.output === "rgba" ? [page.width, page.height] : []).toEqual([200, 100])
		},
		budget(30_000)
	)

	it("keeps the image rows fixed and read whole", () => {
		for (const format of ["tiff", "psd"] as const) expect(MUPDF_FORMATS[format]).toMatchObject({ reflowable: false, readsWhole: true })
	})
})
