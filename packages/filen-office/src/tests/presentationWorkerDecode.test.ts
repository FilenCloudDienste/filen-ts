import { afterEach, describe, expect, it, vi } from "vitest"
import { platformImageDecoder } from "../core/pdfwrite/images"
import { offscreenCanvas } from "../dom/presentation/services"

// A worker's PNG decodes. Firefox decodes the Blob a worker's createImageBitmap is given on the page's main thread
// (hundreds of milliseconds for a large PNG), so there a PNG goes through ImageDecoder (WebCodecs), whose frame
// createImageBitmap takes without decoding again. Other engines keep createImageBitmap(Blob), which they decode off
// the page.

function png(width: number, height: number): Uint8Array {
	const out = new Uint8Array(33)
	const view = new DataView(out.buffer)

	out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
	view.setUint32(16, width)
	view.setUint32(20, height)
	out.set([8, 6, 0, 0, 0], 24)

	return out
}

const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0"
const CHROMIUM = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

class Blob {
	readonly parts: readonly Uint8Array[]

	constructor(parts: readonly Uint8Array[]) {
		this.parts = parts
	}
}

function scope(userAgent: string) {
	const frames: { closed: boolean }[] = []
	const decoders: { type: string; data: unknown }[] = []
	const createImageBitmap = vi.fn((source: unknown, options?: Record<string, unknown>) =>
		Promise.resolve({ width: Number(options?.["resizeWidth"] ?? 100), height: 100, close: () => undefined, source })
	)

	class ImageDecoder {
		static isTypeSupported(type: string): Promise<boolean> {
			return Promise.resolve(type === "image/png")
		}

		constructor(init: { type: string; data: unknown }) {
			decoders.push(init)
		}

		decode(): Promise<{ image: { closed: boolean; close(): void } }> {
			const frame = {
				closed: false,
				close() {
					frame.closed = true
				}
			}

			frames.push(frame)

			return Promise.resolve({ image: frame })
		}

		close(): void {}
	}

	return {
		global: { OffscreenCanvas: class {}, createImageBitmap, Blob, ImageDecoder, navigator: { userAgent } },
		createImageBitmap,
		frames,
		decoders
	}
}

describe("PNG decodes in a worker", () => {
	it("decodes a PNG in Firefox through ImageDecoder, handing createImageBitmap the decoded frame, then closes it", async () => {
		const firefox = scope(FIREFOX)
		const bitmap = await offscreenCanvas(firefox.global)?.decode(png(400, 200), "image/png", 100)

		expect(firefox.decoders).toEqual([{ type: "image/png", data: expect.any(Uint8Array) }])
		expect(firefox.createImageBitmap).toHaveBeenCalledOnce()
		expect(firefox.createImageBitmap.mock.calls[0]?.[0]).toBe(firefox.frames[0])
		expect(firefox.createImageBitmap.mock.calls[0]?.[1]).toMatchObject({ resizeWidth: 100 })
		expect(firefox.frames.every(frame => frame.closed)).toBe(true)
		expect(bitmap?.width).toBe(100)
	})

	it("keeps createImageBitmap(Blob) for a JPEG in Firefox and for a PNG elsewhere", async () => {
		const firefox = scope(FIREFOX)
		const chromium = scope(CHROMIUM)

		// A baseline JPEG's SOF0 of 200 x 100, three components.
		const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9)

		await offscreenCanvas(firefox.global)?.decode(jpeg, "image/jpeg", 100)
		await offscreenCanvas(chromium.global)?.decode(png(400, 200), "image/png", 100)

		expect(firefox.decoders).toHaveLength(0)
		expect(firefox.createImageBitmap.mock.calls[0]?.[0]).toBeInstanceOf(Blob)
		expect(chromium.decoders).toHaveLength(0)
		expect(chromium.createImageBitmap.mock.calls[0]?.[0]).toBeInstanceOf(Blob)
	})

	it("falls back to createImageBitmap(Blob) in Firefox when ImageDecoder fails", async () => {
		const firefox = scope(FIREFOX)

		firefox.global.ImageDecoder.prototype.decode = () => Promise.reject(new Error("EncodingError"))

		const bitmap = await offscreenCanvas(firefox.global)?.decode(png(40, 20), "image/png", 100)

		expect(bitmap).toBeDefined()
		expect(firefox.createImageBitmap.mock.calls[0]?.[0]).toBeInstanceOf(Blob)
	})

	describe("for PDF export", () => {
		afterEach(() => {
			vi.unstubAllGlobals()
		})

		it("reads a PNG's pixels in Firefox from its ImageDecoder frame, never decoding the Blob", async () => {
			const firefox = scope(FIREFOX)
			const drawn: unknown[] = []

			firefox.global.ImageDecoder.prototype.decode = function () {
				const frame = { displayWidth: 2, displayHeight: 1, closed: false, close: () => undefined }

				firefox.frames.push(frame)

				return Promise.resolve({ image: frame })
			}

			for (const [name, value] of Object.entries(firefox.global)) vi.stubGlobal(name, value)

			vi.stubGlobal(
				"OffscreenCanvas",
				class {
					width: number
					height: number

					constructor(width: number, height: number) {
						this.width = width
						this.height = height
					}

					getContext() {
						return {
							drawImage: (image: unknown) => drawn.push(image),
							getImageData: (_x: number, _y: number, width: number, height: number) => ({
								data: new Uint8ClampedArray(width * height * 4)
							})
						}
					}
				}
			)

			const decoded = await platformImageDecoder()?.decode(png(2, 1), "png", 100)

			expect(decoded).toMatchObject({ width: 2, height: 1 })
			expect(drawn).toEqual([firefox.frames[0]])
			expect(firefox.createImageBitmap).not.toHaveBeenCalled()
		})
	})
})
