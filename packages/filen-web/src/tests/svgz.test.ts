import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { gunzipSvg } from "@/features/preview/lib/svgz"

describe("gunzipSvg", () => {
	const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'

	it("inflates a gzipped SVG into an SVG blob", async () => {
		const blob = await gunzipSvg(gzipSync(SVG), 1024)

		expect(blob?.type).toBe("image/svg+xml")
		expect(await blob?.text()).toBe(SVG)
	})

	it("keeps a document exactly at the cap and stops one byte past it", async () => {
		const exact = new Uint8Array(4096).fill(0x20)

		expect((await gunzipSvg(gzipSync(exact), 4096))?.size).toBe(4096)
		expect(await gunzipSvg(gzipSync(exact), 4095)).toBeNull()
	})

	it("stops a bomb long before it is inflated", async () => {
		// 256 MiB of spaces in a few hundred kilobytes.
		const bomb = gzipSync(new Uint8Array(256 * 1024 * 1024).fill(0x20), { level: 9 })

		expect(bomb.byteLength).toBeLessThan(1024 * 1024)
		expect(await gunzipSvg(bomb, 32 * 1024 * 1024)).toBeNull()
	})

	it("rejects bytes that are no gzip stream", async () => {
		await expect(gunzipSvg(new TextEncoder().encode(SVG), 1024)).rejects.toThrow()
	})
})
