import { describe, expect, it } from "vitest"
import { GeoStatsSink, elevationProfile, haversine, pointAtDistance } from "@/features/preview/lib/geo/stats.logic"
import { buildLod, lodLevel, typicalStep } from "@/features/preview/lib/geo/lod.logic"
import { fitView, projection, scaleBar, toCanvas, zoomView } from "@/features/preview/lib/geo/project.logic"
import { distanceParts, duration, nearestSample } from "@/features/preview/components/geoViewer.logic"

describe("geo stats", () => {
	it("sums distance, climbs past the hysteresis only, and moving time above walking speed", () => {
		const sink = new GeoStatsSink()

		sink.segment()
		// 2 m of jitter is not climbing; 10 m is.
		sink.point(8, 47, 500, 0)
		sink.point(8, 47.0001, 502, 10_000)
		sink.point(8, 47.0002, 500, 20_000)
		sink.point(8, 47.0003, 510, 30_000)
		// Standing still for a minute.
		sink.point(8, 47.0003, 510, 90_000)

		const stats = sink.stats()

		expect(stats.gain).toBe(10)
		expect(stats.loss).toBe(0)
		expect(stats.distance).toBeCloseTo(haversine(8, 47, 8, 47.0003), 3)
		expect(stats.duration).toBe(90_000)
		expect(stats.moving).toBe(30_000)
		expect(stats.bounds).toEqual({ minLon: 8, minLat: 47, maxLon: 8, maxLat: 47.0003 })
	})

	it("gives no times without timestamps", () => {
		const sink = new GeoStatsSink()

		sink.point(0, 0, Number.NaN, Number.NaN)

		expect(sink.stats()).toMatchObject({ duration: null, moving: null, maxSpeed: null, minElevation: null })
	})

	it("finds the point nearest a distance by binary search", () => {
		const cumulative = Float64Array.of(0, 10, 30, 60)

		expect(pointAtDistance(cumulative, 0)).toBe(0)
		expect(pointAtDistance(cumulative, 14)).toBe(1)
		expect(pointAtDistance(cumulative, 25)).toBe(2)
		expect(pointAtDistance(cumulative, 1000)).toBe(3)
		expect(pointAtDistance(new Float64Array(0), 5)).toBe(-1)
		expect(nearestSample(cumulative, 46)).toBe(3)
	})

	it("samples the elevation profile evenly along the track", () => {
		const points = {
			lon: new Float64Array(5),
			lat: new Float64Array(5),
			ele: Float64Array.of(1, 2, Number.NaN, 4, 5),
			time: new Float64Array(5),
			segments: Uint32Array.of(0, 5)
		}
		const profile = elevationProfile(points, Float64Array.of(0, 1, 2, 3, 4), 5)

		expect([...profile.elevation]).toEqual([1, 2, 4, 5])
	})
})

describe("geo LOD", () => {
	it("keeps every bucket's first, last and extreme points, within each line, ascending", () => {
		const count = 40
		const x = Float64Array.from({ length: count }, (_, i) => i)
		const y = Float64Array.from({ length: count }, (_, i) => (i === 7 ? 100 : i === 9 ? -100 : 0))
		const [level1] = buildLod(x, y, Uint32Array.of(0, 20, 40))

		expect(level1?.segments[0]).toBe(0)
		expect([...(level1?.indices.subarray(0, 6) ?? [])]).toEqual([0, 3, 4, 7, 8, 9])
		// Indices of the second line start at its first point.
		expect(level1?.indices[level1.segments[1] ?? 0]).toBe(20)

		for (let k = 1; k < (level1?.indices.length ?? 0); k++) expect(level1?.indices[k] ?? 0).toBeGreaterThan(level1?.indices[k - 1] ?? 0)
	})

	it("draws coarser levels the closer points sit on screen", () => {
		expect(lodLevel(10)).toBe(0)
		expect(lodLevel(0.5)).toBe(1)
		expect(lodLevel(0.001)).toBe(4)
	})
})

describe("geo projection", () => {
	it("fits the bounds, zooms toward the pointer and picks round scale bars", () => {
		const bounds = { minLon: 8, minLat: 47, maxLon: 8.1, maxLat: 47.1 }
		const p = projection(bounds)
		const view = fitView(p, bounds, 1000, 1000)
		const zoomed = zoomView(view, view, 2, 1000, 1000, 100, 100)
		const before = toCanvas(view, 1000, 1000, (100 - 500) / view.scale + view.x, (100 - 500) / view.scale + view.y)
		const after = toCanvas(zoomed, 1000, 1000, (100 - 500) / view.scale + view.x, (100 - 500) / view.scale + view.y)

		expect(zoomed.scale).toBeCloseTo(view.scale * 2)
		expect(after.x).toBeCloseTo(before.x)
		expect(scaleBar(0.01, 100)).toEqual({ metres: 10_000, pixels: 100 })
		expect(scaleBar(1, 96).metres).toBe(50)
	})

	it("formats distances and durations", () => {
		expect(distanceParts(42_312).unit).toBe("km")
		expect(distanceParts(812)).toEqual({ unit: "m", value: "812" })
		expect(duration(7_864_000)).toBe("2:11:04")
		expect(duration(64_000)).toBe("1:04")
	})
})

describe("typicalStep", () => {
	it("takes the median step within lines, so far-apart clusters do not draw every point", () => {
		// Two dense clusters (steps of 1) joined by one long jump, and a second line starting far away.
		const x = Float64Array.from([0, 1, 2, 3, 1000, 1001, 1002, 5000, 5001])
		const y = new Float64Array(x.length)

		expect(typicalStep(x, y, Uint32Array.from([0, 7, 9]))).toBe(1)
		// Zoomed out to 0.01: the mean step (about 143) would pick every point; the median picks a coarse level.
		expect(lodLevel(143 * 0.01)).toBe(0)
		expect(lodLevel(typicalStep(x, y, Uint32Array.from([0, 7, 9])) * 0.01)).toBe(3)
		expect(typicalStep(Float64Array.from([0]), Float64Array.from([0]), Uint32Array.from([0, 1]))).toBe(0)
	})
})
