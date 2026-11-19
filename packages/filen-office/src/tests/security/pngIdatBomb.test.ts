import { afterEach, describe, expect, it, vi } from "vitest"
import { Unzlib, zlibSync } from "fflate"
import type { DrawingImage } from "@filen/office/core/drawingml"
import { effectImage } from "../../core/metafile/effects"
import { png, zlibZeros } from "./generate"
import { budget } from "../timing"

// A picture recoloured by a colour change decodes its PNG: the inflate stops at the size the header
// declares, however far the compressed data would expand.

function recolour(bytes: Uint8Array): DrawingImage {
	const image = { partName: undefined, format: "png", bytes, colorChange: null } as unknown as DrawingImage
	const picture = {
		colorChange: [0x000000ff, 0xff0000ff],
		grayscale: false,
		biLevel: -1,
		duotone: null,
		brightness: 0,
		contrast: 0
	} as unknown as DrawingImage

	return effectImage(image, picture, { spend: () => true })
}

// The width and height an encoded PNG declares in its header.
function declaredSize(bytes: Uint8Array): readonly [number, number] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	return [view.getUint32(16), view.getUint32(20)]
}

describe("PNG decoding in metafile pictures", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("stops inflating IDAT data past the declared size", () => {
		// A 1x1 picture whose IDAT inflates to 1 GiB.
		const input = png(1, 1, zlibZeros(1024))
		const push = vi.spyOn(Unzlib.prototype, "push")
		const started = performance.now()
		const out = recolour(input)

		expect(performance.now() - started).toBeLessThan(budget(500))
		// The first inflate step fills the single declared row; the remaining ~1 MiB of IDAT is never pushed.
		// 8 KiB is one inflate step (INFLATE_STEP in effects.ts); a whole-stream push is also a single call, so
		// the bound is on the compressed bytes handed over, not only on the number of calls.
		expect(push).toHaveBeenCalledTimes(1)
		expect(input.length).toBeGreaterThan(512 * 1024)
		expect(push.mock.calls.reduce((sum, [chunk]) => sum + chunk.length, 0)).toBeLessThanOrEqual(8 * 1024)
		expect(out.format).toBe("png")
		expect(out.bytes).toBeDefined()
		expect(out.bytes).not.toBe(input)
		expect(declaredSize(out.bytes ?? input)).toEqual([1, 1])
	})

	it("still recolours a well-formed picture", () => {
		// 2x1 RGBA: one black pixel, one white; filter byte 0.
		const out = recolour(png(2, 1, zlibSync(Uint8Array.of(0, 0, 0, 0, 255, 255, 255, 255, 255))))

		expect(out.bytes).toBeDefined()
		expect(out.bytes).not.toEqual(png(2, 1, zlibSync(Uint8Array.of(0, 0, 0, 0, 255, 255, 255, 255, 255))))
	})
})
