import { describe, expect, it } from "vitest"
import { fitWithin, selectWebpOrFallback, encodeCanvasThumb } from "@/features/drive/lib/thumbGenerators.logic"

describe("fitWithin", () => {
	it("returns the source size unchanged when already at or under maxDim (no upscale)", () => {
		expect(fitWithin(100, 50, 512)).toEqual({ width: 100, height: 50 })
	})

	it("leaves an exact-boundary size unchanged", () => {
		expect(fitWithin(512, 512, 512)).toEqual({ width: 512, height: 512 })
	})

	it("downscales preserving aspect ratio", () => {
		expect(fitWithin(1000, 500, 512)).toEqual({ width: 512, height: 256 })
	})

	it("scales the shorter dimension down by the same factor as the longer one, for a portrait source", () => {
		expect(fitWithin(500, 1000, 512)).toEqual({ width: 256, height: 512 })
	})

	it("rounds a fractional scaled dimension to the nearest integer", () => {
		// scale = 30/100 = 0.3 -> height 33 * 0.3 = 9.9, rounds up to 10.
		expect(fitWithin(100, 33, 30)).toEqual({ width: 30, height: 10 })
	})
})

describe("selectWebpOrFallback", () => {
	it("keeps the webp attempt when its type matches", async () => {
		const webp = new Blob(["webp-bytes"], { type: "image/webp" })
		const jpegFallback = () => Promise.reject(new Error("must not be called"))

		await expect(selectWebpOrFallback(webp, jpegFallback)).resolves.toBe(webp)
	})

	it("awaits the jpeg fallback when the attempt silently downgraded to png", async () => {
		const png = new Blob(["png-bytes"], { type: "image/png" })
		const jpeg = new Blob(["jpeg-bytes"], { type: "image/jpeg" })

		await expect(selectWebpOrFallback(png, () => Promise.resolve(jpeg))).resolves.toBe(jpeg)
	})
})

// Fakes are plain objects duck-typed against exactly the method attemptEncode/encodeCanvasThumb use
// (convertToBlob vs. toBlob), cast through `unknown` — the real classes don't exist as globals under
// this suite's node test environment (no DOM), but neither implementation ever references them as a
// value (no `instanceof`/`new`), so a structurally-matching fake exercises the exact same code path a
// real browser would.
interface FakeOffscreenCanvas {
	convertToBlob: (options?: { type?: string; quality?: number }) => Promise<Blob>
}
interface FakeHtmlCanvas {
	toBlob: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void
}

// exactOptionalPropertyTypes forbids an explicit `type: undefined` BlobPropertyBag property (same
// reason attemptEncode itself builds its options object conditionally) — the fakes below only ever
// see a defined type in practice (attemptEncode never omits it), so this just satisfies the type.
function typedBlob(type: string | undefined): Blob {
	return type === undefined ? new Blob([]) : new Blob([], { type })
}

describe("encodeCanvasThumb — OffscreenCanvas (convertToBlob) path", () => {
	it("returns the webp blob when the fake canvas honors the request", async () => {
		const calls: (string | undefined)[] = []
		const fake: FakeOffscreenCanvas = {
			convertToBlob: options => {
				calls.push(options?.type)

				return Promise.resolve(typedBlob(options?.type))
			}
		}

		const blob = await encodeCanvasThumb(fake as unknown as OffscreenCanvas)

		expect(blob.type).toBe("image/webp")
		expect(calls).toEqual(["image/webp"])
	})

	it("falls back to jpeg-0.85 when the fake canvas downgrades webp to png", async () => {
		const qualities: (number | undefined)[] = []
		const fake: FakeOffscreenCanvas = {
			convertToBlob: options => {
				if (options?.type === "image/webp") {
					return Promise.resolve(new Blob([], { type: "image/png" }))
				}

				qualities.push(options?.quality)

				return Promise.resolve(typedBlob(options?.type))
			}
		}

		const blob = await encodeCanvasThumb(fake as unknown as OffscreenCanvas)

		expect(blob.type).toBe("image/jpeg")
		expect(qualities).toEqual([0.85])
	})
})

describe("encodeCanvasThumb — HTMLCanvasElement (toBlob) path", () => {
	it("uses the callback-based toBlob API when convertToBlob is absent", async () => {
		const fake: FakeHtmlCanvas = {
			toBlob: (callback, type) => {
				callback(typedBlob(type))
			}
		}

		const blob = await encodeCanvasThumb(fake as unknown as HTMLCanvasElement)

		expect(blob.type).toBe("image/webp")
	})

	it("falls back to jpeg when toBlob downgrades webp to png", async () => {
		const fake: FakeHtmlCanvas = {
			toBlob: (callback, type, quality) => {
				if (type === "image/webp") {
					callback(new Blob([], { type: "image/png" }))

					return
				}

				expect(quality).toBe(0.85)
				callback(typedBlob(type))
			}
		}

		const blob = await encodeCanvasThumb(fake as unknown as HTMLCanvasElement)

		expect(blob.type).toBe("image/jpeg")
	})

	it("rejects when toBlob produces a null blob", async () => {
		const fake: FakeHtmlCanvas = {
			toBlob: callback => {
				callback(null)
			}
		}

		await expect(encodeCanvasThumb(fake as unknown as HTMLCanvasElement)).rejects.toThrow("canvas toBlob produced no result")
	})
})
