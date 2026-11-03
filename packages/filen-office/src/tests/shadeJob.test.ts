import { describe, expect, it } from "vitest"
import { ShadeJob, shadeRaster } from "../core/drawingml/shade"
import { PngSteps } from "../core/drawingml/shadePng"
import { decodePng } from "./oracles/presentation/pixel"
import { budget, cpuMs } from "./timing"

// A shaded mesh's raster: bounded by the pixels its triangles visit (slack band included, so slivers with no area
// count), and built in steps that make the same raster as one pass.

const RED = 0xff0000ff
const GREEN = 0x00ff00ff
const BLUE = 0x0000ffff

// One large triangle sets the extent; the rest are full-width slivers whose boxes have almost no area.
function slivers(count: number): { points: Float32Array; colors: Uint32Array } {
	const points = new Float32Array(count * 6)
	const colors = new Uint32Array(count * 3).fill(RED)

	points.set([0, 0, 1000, 0, 0, 1000])

	for (let t = 1; t < count; t++) {
		const y = (t % 1000) + 0.25

		points.set([0, y, 1000, y, 500, y + 0.001], t * 6)
	}

	return { points, colors }
}

describe("a shaded mesh's raster", () => {
	it("bounds the pixels 200,000 slivers visit by the work budget, in well under a second of CPU", () => {
		const { points, colors } = slivers(200_000)
		const start = cpuMs()
		const raster = shadeRaster(points, colors, null, 4, 2048 * 2048)
		const spent = cpuMs() - start

		expect(raster).toBeDefined()
		expect(spent).toBeLessThan(budget(500))
	}, 120_000)

	it("refuses a mesh whose triangles alone pass the work budget, whatever the scale", () => {
		const { points, colors } = slivers(10_000)

		expect(ShadeJob.plan([{ points, colors, ramp: null }], 4, 100, 400)).toBeUndefined()
	})

	it("makes the same raster in steps as in one pass, later meshes over earlier ones", () => {
		const meshes = [
			{ points: Float32Array.of(0, 0, 100, 0, 0, 100), colors: Uint32Array.of(RED, GREEN, BLUE), ramp: null },
			{ points: Float32Array.of(20, 20, 120, 20, 20, 120), colors: Uint32Array.of(BLUE, BLUE, BLUE), ramp: null }
		]
		const whole = ShadeJob.plan(meshes, 2, 1_000_000)
		const stepped = ShadeJob.plan(meshes, 2, 1_000_000)

		if (whole === undefined || stepped === undefined) throw new Error("no raster")

		expect(whole.step()).toBe(true)

		let steps = 0

		while (!stepped.step(() => true)) steps++

		expect(steps).toBeGreaterThan(0)
		expect(stepped.result().rgba).toEqual(whole.result().rgba)
		expect(whole.result().bounds).toEqual([0, 0, 120, 120])

		const { rgba, width } = whole.result()
		const at = (x: number, y: number): number => ((y * width + x) * 4) as number

		// Inside both: the later, blue one.
		expect(Array.from(rgba.subarray(at(60, 60), at(60, 60) + 3))).toEqual([0, 0, 255])
		// Near the first's red corner, outside the second.
		expect(rgba[at(2, 2)]).toBeGreaterThan(200)
	})

	it("encodes a raster as a PNG in steps, every pixel kept", () => {
		const width = 300
		const height = 70
		const rgba = new Uint8Array(width * height * 4)

		for (let k = 0; k < rgba.length; k++) rgba[k] = (k * 7 + (k >> 9)) & 255

		const png = new PngSteps(rgba, width, height)
		let steps = 0

		while (!png.step(() => true)) steps++

		const parts = png.result()
		const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
		let at = 0

		for (const part of parts) {
			bytes.set(part, at)
			at += part.length
		}

		const decoded = decodePng(bytes)

		expect(steps).toBeGreaterThan(2)
		expect([decoded.width, decoded.height]).toEqual([width, height])
		expect(Array.from(decoded.data)).toEqual(Array.from(rgba))
	})
})
