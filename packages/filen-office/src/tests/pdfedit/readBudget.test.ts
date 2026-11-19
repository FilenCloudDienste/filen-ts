import { afterEach, describe, expect, it } from "vitest"
import { MUPDF_BYTES_PER_PIXEL } from "../../core/pdfedit/budget"
import { startEngine, stopEngines } from "./harness"
import { makeEpub } from "./readFixtures"
import { budget } from "../timing"

afterEach(stopEngines)

// MUPDF_BYTES_PER_PIXEL, measured as budget.ts says: each size in a fresh engine (wasm memory never shrinks), the heap
// grown by drawing an image page at full size in 1024-pixel tiles, once the page's image is read. A CMYK JPEG of noise
// is the heaviest decode; the growth steps make the figure vary by size, so several sizes are measured.
async function bytesPerPixel(side: number): Promise<number> {
	const engine = startEngine(makeEpub({ imageSide: side }), { blockBytes: 1024 * 1024 })

	// Stopped before the next size starts: only one grown heap is alive at a time.
	try {
		await engine.openRead({ format: "epub", layout: { width: side, height: side, em: 11 }, maxImagePixels: Number.MAX_SAFE_INTEGER })

		const pages = await engine.client.call("pages", { from: 0, count: 1000, generation: 0 })
		const page = pages.length - 1
		const size = pages[page]

		if (size === undefined) throw new Error("no image page")

		// Builds the page's list: the image is read (not decoded).
		await engine.client.call("text", { page, generation: 0 })

		const before = await engine.client.call("heap", {})

		for (let y = 0; y < size.height; y += 1024) {
			for (let x = 0; x < size.width; x += 1024) {
				await engine.client.call("render", {
					page,
					scale: 1,
					rotation: 0,
					tile: [x, y, Math.min(x + 1024, size.width), Math.min(y + 1024, size.height)],
					priority: "visible",
					generation: 0
				})
			}
		}

		const after = await engine.client.call("heap", {})

		return (after.heapBytes - before.heapBytes) / (side * side)
	} finally {
		engine.client.terminate()
	}
}

describe("MuPDF's bytes per pixel", () => {
	it(
		"stays within the budget's figure for an image page drawn whole",
		async () => {
			const measured: number[] = []

			for (const side of [1500, 2000, 2500, 3000]) measured.push(await bytesPerPixel(side))

			expect(Math.max(...measured)).toBeGreaterThan(MUPDF_BYTES_PER_PIXEL - 1)
			expect(Math.max(...measured)).toBeLessThanOrEqual(MUPDF_BYTES_PER_PIXEL)
		},
		budget(120_000)
	)
})
