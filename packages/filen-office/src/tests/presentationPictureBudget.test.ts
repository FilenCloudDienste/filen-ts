import { describe, expect, it, vi } from "vitest"
import { inThreadPresentationWorker, presentationWorkerPool } from "../dom/presentation/host"
import type { PresentationEvent } from "../dom/presentation/protocol"
import { offscreenCanvas } from "../dom/presentation/services"
import { buildPptx } from "./pptxFixtures"

// The decoded-pixel budget holds on both picture paths: the worker's canvas decode (its header read in full, so a
// JPEG frame header behind long APP segments is still found) and the bytes image() hands the page.

function deepJpeg(): Uint8Array {
	const app = (marker: number): Uint8Array => {
		const segment = new Uint8Array(2 + 65535)

		segment.set([0xff, marker, 0xff, 0xff])

		return segment
	}
	const parts = [
		new Uint8Array([0xff, 0xd8]),
		app(0xe1),
		app(0xe2),
		// SOF0: 30000 x 30000.
		new Uint8Array([0xff, 0xc0, 0x00, 0x11, 0x08, 0x75, 0x30, 0x75, 0x30, 0x03])
	]
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

// A PNG signature and IHDR of `width` x `height` (RGBA); the header is all the budget reads.
function pngHeader(width: number, height: number): Uint8Array {
	const out = new Uint8Array(33)
	const view = new DataView(out.buffer)

	out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
	view.setUint32(16, width)
	view.setUint32(20, height)
	out.set([8, 6, 0, 0, 0], 24)

	return out
}

describe("presentation picture budget", () => {
	it("refuses a JPEG over the pixel budget before decoding it, even when its frame header is past 64 KiB", async () => {
		const createImageBitmap = vi.fn(() => Promise.resolve({ width: 1, height: 1, close: () => undefined }))
		const canvas = offscreenCanvas({ OffscreenCanvas: class {}, createImageBitmap, Blob: class {} })

		await expect(canvas?.decode(deepJpeg(), "image/jpeg", 256)).resolves.toBeUndefined()
		expect(createImageBitmap).not.toHaveBeenCalled()
	})

	it("hands the page no picture over the pixel budget, and one within it", async () => {
		const bytes = buildPptx({
			slides: [{ shapes: "" }],
			defaults: '<Default Extension="png" ContentType="image/png"/>',
			parts: {
				"ppt/media/image1.png": { data: pngHeader(30_000, 30_000) },
				"ppt/media/image2.png": { data: pngHeader(100, 100) }
			}
		})
		const pool = presentationWorkerPool(() => inThreadPresentationWorker())
		let answer: (event: PresentationEvent) => void = () => undefined
		const opened = new Promise<PresentationEvent>(resolve => {
			answer = resolve
		})
		const client = pool.open({ kind: "bytes", bytes }, { format: "pptx", fileName: "a.pptx" }, event => {
			if (event.type === "opened" || event.type === "error") answer(event)
		})

		expect((await opened).type).toBe("opened")
		await expect(client.image("/ppt/media/image1.png")).resolves.toBeNull()
		await expect(client.image("/ppt/media/image2.png")).resolves.toMatchObject({ type: "image/png" })
		pool.dispose()
	})
})
