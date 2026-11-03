import type { Rgba, ShadeRamp } from "./displayList"

// Rasterises a "shaded" paint (triangles with a colour per vertex: GDI gradient triangles, GDI+ path
// gradients over a polygon) at whatever resolution its renderer needs, so it stays sharp at any zoom.

export interface ShadedRaster {
	readonly rgba: Uint8Array
	readonly width: number
	readonly height: number
	// The raster's extent in the paint's local units (x, y, width, height).
	readonly bounds: readonly [number, number, number, number]
}

function mix(c1: Rgba, c2: Rgba, t: number): Rgba {
	const channel = (shift: number): number => Math.round(((c1 >>> shift) & 255) * (1 - t) + ((c2 >>> shift) & 255) * t)

	return ((channel(24) << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0)) >>> 0
}

// The two positions around `position` and how far it lies between them.
function interpolate(positions: Float32Array, position: number): [number, number, number] {
	if (positions.length === 0 || position <= (positions[0] ?? 0)) return [0, 0, 0]

	for (let k = 1; k < positions.length; k++) {
		const end = positions[k] ?? 1

		if (position <= end) {
			const start = positions[k - 1] ?? 0

			return [k - 1, k, end > start ? (position - start) / (end - start) : 1]
		}
	}

	const last = positions.length - 1

	return [last, last, 0]
}

// The colour at a pixel with weight `weight` towards a triangle's first vertex (the centre), given the
// colour along the opposite edge.
export function rampColor(ramp: ShadeRamp, weight: number, edge: Rgba): Rgba {
	// Inside the focus scale the centre colour is solid.
	const position = ramp.focus > 0 && ramp.focus < 1 ? Math.min(1, weight / (1 - ramp.focus)) : weight

	if (ramp.offsets !== null && ramp.colors !== null && ramp.offsets.length > 0) {
		const colors = ramp.colors
		const [from, to, t] = interpolate(ramp.offsets, position)

		return mix(colors[from] ?? 0, colors[to] ?? 0, t)
	}

	if (ramp.positions !== null && ramp.factors !== null && ramp.positions.length > 0) {
		const factors = ramp.factors
		const [from, to, t] = interpolate(ramp.positions, position)

		return mix(edge, ramp.center, (factors[from] ?? 0) * (1 - t) + (factors[to] ?? 0) * t)
	}

	return mix(edge, ramp.center, position)
}

export function shadeBounds(points: Float32Array): [number, number, number, number] | undefined {
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity

	for (let k = 0; k + 1 < points.length; k += 2) {
		const x = points[k] ?? 0
		const y = points[k + 1] ?? 0

		if (x < minX) minX = x
		if (x > maxX) maxX = x
		if (y < minY) minY = y
		if (y > maxY) maxY = y
	}

	return maxX > minX && maxY > minY && Number.isFinite(maxX - minX + maxY - minY) ? [minX, minY, maxX - minX, maxY - minY] : undefined
}

// The mean of the vertex colours (where a paint cannot be rasterised).
export function averageShade(colors: Uint32Array): Rgba {
	if (colors.length === 0) return 0

	let r = 0
	let g = 0
	let b = 0
	let a = 0

	for (const color of colors) {
		r += color >>> 24
		g += (color >>> 16) & 255
		b += (color >>> 8) & 255
		a += color & 255
	}

	const n = colors.length

	return ((Math.round(r / n) << 24) | (Math.round(g / n) << 16) | (Math.round(b / n) << 8) | Math.round(a / n)) >>> 0
}

// One shaded paint's triangles (x, y of three vertices each, local units), a colour per vertex, and its ramp.
export interface ShadedMesh {
	readonly points: Float32Array
	readonly colors: Uint32Array
	readonly ramp: ShadeRamp | null
}

// How close (in pixels) a pixel centre must be to count as inside, filling the edges' anti-aliasing.
const SLACK = 1.5
// The pixels a triangle's box gains on each axis from the slack band and rounding: what a sliver with no area costs.
const BAND = 2 * SLACK + 1
// Triangle visits per step between two looks at the clock.
const STEP_TRIANGLES = 64

function triangleCount(mesh: ShadedMesh): number {
	return Math.min(Math.floor(mesh.points.length / 6), Math.floor(mesh.colors.length / 3))
}

// The meshes' triangles (Gouraud shading, or through a mesh's ramp from each first vertex) over their joint bounds at
// `scale` pixels per local unit, shrunk to at most `maxPixels` and so the pixels the triangles visit (each its box
// plus the slack band) total at most `maxWork`; later triangles over earlier ones, as they are drawn. Pixels just
// outside an edge take the nearest triangle's colour, so the clipping outline never shows a gap. Built by steps, so
// a thread that must stay responsive can run it in slices (step()); undefined when even the least scale (one pixel on
// the longer side) would pass `maxWork`.
export class ShadeJob {
	readonly width: number
	readonly height: number
	// The raster's extent in the paint's local units (x, y, width, height).
	readonly bounds: readonly [number, number, number, number]
	// Allocated by the first step: a plan alone (a page sizing what a worker draws) holds no pixels.
	private pixels: Uint8Array | undefined
	private readonly meshes: readonly ShadedMesh[]
	private readonly sx: number
	private readonly sy: number
	private mesh = 0
	private triangle = 0

	private constructor(meshes: readonly ShadedMesh[], extent: readonly [number, number, number, number], width: number, height: number) {
		this.meshes = meshes
		this.bounds = extent
		this.width = width
		this.height = height
		this.sx = width / extent[2]
		this.sy = height / extent[3]
	}

	static plan(meshes: readonly ShadedMesh[], scale: number, maxPixels: number, maxWork: number = maxPixels * 4): ShadeJob | undefined {
		if (!(scale > 0) || !(maxPixels >= 1) || meshes.length === 0) return undefined

		let minX = Infinity
		let minY = Infinity
		let maxX = -Infinity
		let maxY = -Infinity
		// Per triangle its box is (w·f + BAND) × (h·f + BAND) pixels at scale f: the work is area·f² + edges·f + count,
		// summed over the triangles.
		let area = 0
		let edges = 0
		let count = 0

		for (const mesh of meshes) {
			const extent = shadeBounds(mesh.points)

			if (extent === undefined) continue

			minX = Math.min(minX, extent[0])
			minY = Math.min(minY, extent[1])
			maxX = Math.max(maxX, extent[0] + extent[2])
			maxY = Math.max(maxY, extent[1] + extent[3])

			const points = mesh.points
			const triangles = triangleCount(mesh)

			for (let t = 0; t < triangles; t++) {
				const p = t * 6
				const ax = points[p] ?? 0
				const ay = points[p + 1] ?? 0
				const bx = points[p + 2] ?? 0
				const by = points[p + 3] ?? 0
				const cx = points[p + 4] ?? 0
				const cy = points[p + 5] ?? 0
				const w = Math.max(ax, bx, cx) - Math.min(ax, bx, cx)
				const h = Math.max(ay, by, cy) - Math.min(ay, by, cy)

				area += w * h
				edges += (w + h) * BAND
				count++
			}
		}

		const spanX = maxX - minX
		const spanY = maxY - minY

		if (!(spanX > 0 && spanY > 0 && Number.isFinite(spanX + spanY))) return undefined

		const constant = count * BAND * BAND

		if (constant >= maxWork) return undefined

		// The largest f with area·f² + edges·f + constant ≤ maxWork.
		const budget = maxWork - constant
		const byWork = area > 0 ? (-edges + Math.sqrt(edges * edges + 4 * area * budget)) / (2 * area) : edges > 0 ? budget / edges : scale
		const fit = Math.min(scale, Math.sqrt(maxPixels / (spanX * spanY)), byWork)

		// Below one pixel on the longer side the raster would show nothing of the shading.
		if (!(fit * Math.max(spanX, spanY) >= 1)) return undefined

		const width = Math.max(1, Math.min(16_384, Math.ceil(spanX * fit)))
		const height = Math.max(1, Math.min(16_384, Math.ceil(spanY * fit)))

		return new ShadeJob(meshes, [minX, minY, spanX, spanY], width, height)
	}

	get done(): boolean {
		return this.mesh >= this.meshes.length
	}

	// Rasterises triangles until done or `stop()` says to (checked every few triangles); whether it is done.
	step(stop: () => boolean = () => false): boolean {
		while (this.mesh < this.meshes.length) {
			const mesh = this.meshes[this.mesh] as ShadedMesh
			const triangles = triangleCount(mesh)

			while (this.triangle < triangles) {
				const end = Math.min(triangles, this.triangle + STEP_TRIANGLES)

				for (; this.triangle < end; this.triangle++) this.draw(mesh, this.triangle)

				if (this.triangle < triangles && stop()) return false
			}

			this.mesh++
			this.triangle = 0

			if (this.mesh < this.meshes.length && stop()) return false
		}

		return true
	}

	result(): ShadedRaster {
		return { rgba: this.rgba, width: this.width, height: this.height, bounds: this.bounds }
	}

	private get rgba(): Uint8Array {
		this.pixels ??= new Uint8Array(this.width * this.height * 4)

		return this.pixels
	}

	private draw(mesh: ShadedMesh, t: number): void {
		const { rgba, width, height, sx, sy } = this
		const [minX, minY] = this.bounds
		const points = mesh.points
		const colors = mesh.colors
		const ramp = mesh.ramp
		const p = t * 6
		const ax = ((points[p] ?? 0) - minX) * sx
		const ay = ((points[p + 1] ?? 0) - minY) * sy
		const bx = ((points[p + 2] ?? 0) - minX) * sx
		const by = ((points[p + 3] ?? 0) - minY) * sy
		const cx = ((points[p + 4] ?? 0) - minX) * sx
		const cy = ((points[p + 5] ?? 0) - minY) * sy
		const ca = colors[t * 3] ?? 0
		const cb = colors[t * 3 + 1] ?? 0
		const cc = colors[t * 3 + 2] ?? 0
		const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

		if (Math.abs(area) < 1e-12) return

		const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - SLACK))
		const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx) + SLACK))
		const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - SLACK))
		const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy) + SLACK))
		const magnitude = Math.abs(area)
		const ea = magnitude / (Math.hypot(cx - bx, cy - by) || 1)
		const eb = magnitude / (Math.hypot(ax - cx, ay - cy) || 1)
		const ec = magnitude / (Math.hypot(bx - ax, by - ay) || 1)

		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				const px = x + 0.5
				const py = y + 0.5
				let wa = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area
				let wb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area
				let wc = 1 - wa - wb
				// Distance outside each edge, in pixels.
				const outside = Math.max(-wa * ea, -wb * eb, -wc * ec)

				if (outside > SLACK) continue

				const at = (y * width + x) * 4

				// A pixel already inside another triangle keeps that colour.
				if (outside > 0 && (rgba[at + 3] ?? 0) !== 0) continue

				wa = Math.max(0, wa)
				wb = Math.max(0, wb)
				wc = Math.max(0, wc)

				const sum = wa + wb + wc || 1

				if (ramp !== null) {
					const color = rampColor(ramp, wa / sum, mix(cb, cc, wc / (wb + wc || 1)))

					rgba[at] = color >>> 24
					rgba[at + 1] = (color >>> 16) & 255
					rgba[at + 2] = (color >>> 8) & 255
					rgba[at + 3] = color & 255
					continue
				}

				rgba[at] = Math.round(((ca >>> 24) * wa + (cb >>> 24) * wb + (cc >>> 24) * wc) / sum)
				rgba[at + 1] = Math.round((((ca >>> 16) & 255) * wa + ((cb >>> 16) & 255) * wb + ((cc >>> 16) & 255) * wc) / sum)
				rgba[at + 2] = Math.round((((ca >>> 8) & 255) * wa + ((cb >>> 8) & 255) * wb + ((cc >>> 8) & 255) * wc) / sum)
				rgba[at + 3] = Math.round(((ca & 255) * wa + (cb & 255) * wb + (cc & 255) * wc) / sum)
			}
		}
	}
}

// One mesh's raster at once (ShadeJob run to its end), for renderers that draw in a worker or a single pass.
export function shadeRaster(
	points: Float32Array,
	colors: Uint32Array,
	ramp: ShadeRamp | null,
	scale: number,
	maxPixels: number,
	maxWork: number = maxPixels * 4
): ShadedRaster | undefined {
	const job = ShadeJob.plan([{ points, colors, ramp }], scale, maxPixels, maxWork)

	if (job === undefined) return undefined

	job.step()

	return job.result()
}
