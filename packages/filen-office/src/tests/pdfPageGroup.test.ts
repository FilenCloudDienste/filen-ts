import { describe, expect, it } from "vitest"
import { PdfWriter, type PdfPage } from "../core/pdfwrite"

// A page that composites (constant alpha, a soft mask, a blend mode, an image with an SMask) carries a transparency
// group in DeviceRGB (ISO 32000-1 §11.4.7), so viewers blend in RGB rather than the device's or output intent's space.
// Opaque pages carry none.

async function pages(draws: readonly ((page: PdfPage, writer: PdfWriter) => Promise<void> | void)[]): Promise<string[]> {
	const writer = await PdfWriter.create({ deterministic: true, deflate: null })

	for (const draw of draws) {
		const page = writer.beginPage(100, 100)

		await draw(page, writer)
		await writer.endPage(page)
	}

	const output = await writer.finish()
	const chunks: Uint8Array[] = []

	for (const part of output.parts) chunks.push(part instanceof Uint8Array ? part : new Uint8Array(await part.arrayBuffer()))

	const text = new TextDecoder("latin1").decode(Buffer.concat(chunks))

	// Page dictionaries in page order (written as each page ends).
	return [...text.matchAll(/<<\/Type \/Page\b[^\n]*/gu)].map(match => match[0])
}

const GROUP = "/Group <</Type /Group /S /Transparency /CS /DeviceRGB>>"

function rgba(alpha: number): Uint8Array {
	return new Uint8Array([255, 0, 0, alpha, 0, 255, 0, alpha, 0, 0, 255, alpha, 0, 0, 0, alpha])
}

describe("page transparency group", () => {
	it("is written only on pages that composite", async () => {
		const dicts = await pages([
			page => {
				page.rect(0, 0, 10, 10).fill()
			},
			page => {
				page.graphicsState({ fillAlpha: 0.5 }).rect(0, 0, 10, 10).fill()
			},
			page => {
				page.graphicsState({ blend: "Multiply" }).rect(0, 0, 10, 10).fill()
			},
			async (page, writer) => {
				page.drawImage(await writer.pixels({ key: "translucent", width: 2, height: 2, rgba: rgba(128) }), 0, 0, 10, 10)
			},
			async (page, writer) => {
				page.drawImage(await writer.pixels({ key: "opaque", width: 2, height: 2, rgba: rgba(255) }), 0, 0, 10, 10)
			},
			page => {
				page.graphicsState({ fillAlpha: 1, blend: "Normal" }).rect(0, 0, 10, 10).fill()
			},
			async page => {
				page.rect(0, 0, 10, 10).clip()
				// An alpha ramp: a luminosity soft mask.
				await page.gradient({
					type: "axial",
					coords: [0, 0, 75, 0],
					offsets: [0, 1],
					colors: [0xff0000ff, 0x0000ff00],
					bounds: [0, 0, 75, 75]
				})
			}
		])

		expect(dicts).toHaveLength(7)
		expect(dicts.map(dict => dict.includes(GROUP))).toEqual([false, true, true, true, false, false, true])
	})

	it("is written on a page tiled with a translucent picture", async () => {
		const tile = { width: 10, height: 10, matrix: [1, 0, 0, 1, 0, 0], flipX: false, flipY: false, crop: [0, 0, 0, 0] } as const
		const dicts = await pages([
			async (page, writer) => {
				await page.tile(await writer.pixels({ key: "a", width: 2, height: 2, rgba: rgba(255) }), tile, 0, 0, 50, 50)
			},
			async (page, writer) => {
				await page.tile(await writer.pixels({ key: "b", width: 2, height: 2, rgba: rgba(64) }), tile, 0, 0, 50, 50)
			}
		])

		expect(dicts.map(dict => dict.includes(GROUP))).toEqual([false, true])
	})

	it("is written again on a later page that reuses a translucent resource", async () => {
		const dicts = await pages([
			page => {
				page.graphicsState({ strokeAlpha: 0.25 }).rect(0, 0, 10, 10).stroke()
			},
			page => {
				page.graphicsState({ strokeAlpha: 0.25 }).rect(0, 0, 10, 10).stroke()
			}
		])

		expect(dicts.map(dict => dict.includes(GROUP))).toEqual([true, true])
	})
})
