/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { loadGeo, type GeoFileFormat } from "@/features/preview/lib/geo/load"
import type { GeoPoints, GeoWaypoint } from "@/features/preview/lib/geo/extract.logic"
import { elevationProfile, pointAtDistance, type GeoStats } from "@/features/preview/lib/geo/stats.logic"
import { buildLod, lodLevel, typicalStep, type LodLevel } from "@/features/preview/lib/geo/lod.logic"
import {
	fitView,
	panView,
	projectX,
	projectY,
	projection,
	scaleBar,
	toCanvas,
	wheelFactor,
	zoomView,
	type GeoView
} from "@/features/preview/lib/geo/project.logic"
import type { CanvasInput, ShellToWorker, WorkerToShell } from "@/features/preview/components/canvasViewerShell.logic"

// One geo file, owned by its viewer: read into packed arrays, then drawn on demand into the shell's OffscreenCanvas
// (2D, equirectangular, no basemap and no tiles). Each frame draws the LOD level that matches the zoom, skipping
// chunks of the track the view does not show.

// Profile samples the page draws under the plot.
const PROFILE_SAMPLES = 512
// Points per culling chunk: a chunk whose box is outside the view is skipped whole.
const CHUNK = 256
const KEY_ZOOM = 1.5
const KEY_PAN = 64

export interface GeoColors {
	readonly track: string
	readonly waypoint: string
	readonly start: string
	readonly end: string
	readonly highlight: string
	readonly text: string
	readonly halo: string
}

export interface GeoSummary {
	readonly stats: GeoStats
	readonly waypoints: number
	readonly references: number
	// Too many points to plot: only stats.
	readonly tooMany: boolean
	readonly profile: { readonly distance: Float64Array; readonly elevation: Float64Array }
}

interface Plot {
	readonly points: GeoPoints
	readonly cumulative: Float64Array
	readonly x: Float64Array
	readonly y: Float64Array
	readonly lod: readonly LodLevel[]
	// Projected metres between consecutive points, on average.
	readonly spacing: number
	// Per CHUNK points: min x, min y, max x, max y.
	readonly chunks: Float64Array
	readonly waypoints: readonly { x: number; y: number }[]
	readonly fit: (width: number, height: number) => GeoView
}

let plot: Plot | null = null
let colors: GeoColors | null = null
let canvas: OffscreenCanvas | null = null
let context: OffscreenCanvasRenderingContext2D | null = null
let shell: MessagePort | null = null
let width = 1
let height = 1
let pixelRatio = 1
let view: GeoView | null = null
let fitted: GeoView | null = null
let highlighted = -1
let frame: number | null = null
const pointers = new Map<number, { x: number; y: number }>()

function send(message: WorkerToShell<number>): void {
	shell?.postMessage(message)
}

function build(
	points: GeoPoints,
	cumulative: Float64Array,
	waypoints: readonly GeoWaypoint[],
	bounds: NonNullable<GeoStats["bounds"]>
): Plot {
	const p = projection(bounds)
	const count = points.lon.length
	const x = new Float64Array(count)
	const y = new Float64Array(count)

	for (let i = 0; i < count; i++) {
		x[i] = projectX(p, points.lon[i] ?? 0)
		y[i] = projectY(p, points.lat[i] ?? 0)
	}

	const chunks = new Float64Array(Math.ceil(count / CHUNK) * 4)

	for (let c = 0; c * CHUNK < count; c++) {
		let minX = Number.POSITIVE_INFINITY
		let minY = Number.POSITIVE_INFINITY
		let maxX = Number.NEGATIVE_INFINITY
		let maxY = Number.NEGATIVE_INFINITY

		for (let i = c * CHUNK; i < Math.min(count, (c + 1) * CHUNK); i++) {
			minX = Math.min(minX, x[i] ?? 0)
			minY = Math.min(minY, y[i] ?? 0)
			maxX = Math.max(maxX, x[i] ?? 0)
			maxY = Math.max(maxY, y[i] ?? 0)
		}

		chunks.set([minX, minY, maxX, maxY], c * 4)
	}

	return {
		points,
		cumulative,
		x,
		y,
		lod: buildLod(x, y, points.segments),
		spacing: typicalStep(x, y, points.segments),
		chunks,
		waypoints: waypoints.map(waypoint => ({ x: projectX(p, waypoint.lon), y: projectY(p, waypoint.lat) })),
		fit: (w, h) => fitView(p, bounds, w, h)
	}
}

function schedule(): void {
	frame ??= requestAnimationFrame(() => {
		frame = null
		draw()
	})
}

// Whether a chunk's box meets the view (with a margin for the line width).
function chunkVisible(current: Plot, chunk: number, left: number, top: number, right: number, bottom: number): boolean {
	const at = chunk * 4

	return !(
		(current.chunks[at + 2] ?? 0) < left ||
		(current.chunks[at] ?? 0) > right ||
		(current.chunks[at + 3] ?? 0) < top ||
		(current.chunks[at + 1] ?? 0) > bottom
	)
}

function drawTrack(ctx: OffscreenCanvasRenderingContext2D, current: Plot, at: GeoView): void {
	const margin = 4 / at.scale
	const left = at.x - width / 2 / at.scale - margin
	const right = at.x + width / 2 / at.scale + margin
	const top = at.y - height / 2 / at.scale - margin
	const bottom = at.y + height / 2 / at.scale + margin
	const level = lodLevel(current.spacing * at.scale)
	const lod = level === 0 ? null : (current.lod[level - 1] ?? null)
	const segments = lod?.segments ?? current.points.segments

	ctx.beginPath()

	for (let s = 0; s + 1 < segments.length; s++) {
		let pen = false
		let chunk = -1
		let visible = true

		for (let k = segments[s] ?? 0; k < (segments[s + 1] ?? 0); k++) {
			const i = lod === null ? k : (lod.indices[k] ?? 0)
			const inChunk = Math.floor(i / CHUNK)

			if (inChunk !== chunk) {
				chunk = inChunk
				visible = chunkVisible(current, chunk, left, top, right, bottom)
			}

			// A chunk off screen is skipped whole; the pen lifts across it.
			if (!visible) {
				pen = false

				// Every point at level 0: jump to the next chunk.
				if (lod === null) k = Math.min(segments[s + 1] ?? 0, (chunk + 1) * CHUNK) - 1

				continue
			}

			// toCanvas, inlined: no object per point.
			const px = ((current.x[i] ?? 0) - at.x) * at.scale + width / 2
			const py = ((current.y[i] ?? 0) - at.y) * at.scale + height / 2

			if (pen) ctx.lineTo(px, py)
			else ctx.moveTo(px, py)

			pen = true
		}
	}

	ctx.stroke()
}

function marker(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, radius: number, fill: string, square = false): void {
	ctx.beginPath()

	if (square) ctx.rect(x - radius, y - radius, radius * 2, radius * 2)
	else ctx.arc(x, y, radius, 0, Math.PI * 2)

	ctx.fillStyle = fill
	ctx.fill()
	ctx.stroke()
}

function draw(): void {
	const ctx = context
	const current = plot
	const palette = colors

	if (ctx === null || current === null || palette === null) return

	view ??= current.fit(width, height)
	fitted ??= view

	const at = view
	const r = pixelRatio

	ctx.clearRect(0, 0, width, height)
	ctx.lineJoin = "round"
	ctx.lineCap = "round"
	ctx.strokeStyle = palette.halo
	ctx.lineWidth = 5 * r
	drawTrack(ctx, current, at)
	ctx.strokeStyle = palette.track
	ctx.lineWidth = 2.5 * r
	drawTrack(ctx, current, at)
	ctx.strokeStyle = palette.halo
	ctx.lineWidth = 1.5 * r

	for (const waypoint of current.waypoints) {
		const point = toCanvas(at, width, height, waypoint.x, waypoint.y)

		marker(ctx, point.x, point.y, 4 * r, palette.waypoint)
	}

	const count = current.x.length

	if (count > 0) {
		const start = toCanvas(at, width, height, current.x[0] ?? 0, current.y[0] ?? 0)
		const end = toCanvas(at, width, height, current.x[count - 1] ?? 0, current.y[count - 1] ?? 0)

		marker(ctx, end.x, end.y, 5 * r, palette.end, true)
		marker(ctx, start.x, start.y, 5 * r, palette.start)
	}

	if (highlighted >= 0) {
		const point = toCanvas(at, width, height, current.x[highlighted] ?? 0, current.y[highlighted] ?? 0)

		marker(ctx, point.x, point.y, 6 * r, palette.highlight)
	}

	// The scale bar, bottom right.
	const bar = scaleBar(at.scale, 96 * r)
	const right = width - 16 * r
	const base = height - 16 * r

	ctx.strokeStyle = palette.text
	ctx.lineWidth = 2 * r
	ctx.beginPath()
	ctx.moveTo(right - bar.pixels, base - 6 * r)
	ctx.lineTo(right - bar.pixels, base)
	ctx.lineTo(right, base)
	ctx.lineTo(right, base - 6 * r)
	ctx.stroke()
	ctx.fillStyle = palette.text
	ctx.font = `${String(12 * r)}px system-ui, sans-serif`
	ctx.textAlign = "right"
	ctx.fillText(bar.metres >= 1000 ? `${String(bar.metres / 1000)} km` : `${String(bar.metres)} m`, right, base - 10 * r)
}

function input(events: readonly CanvasInput[]): void {
	const current = view
	const fit = fitted

	if (current === null || fit === null) return

	let next = current

	for (const event of events) {
		switch (event.type) {
			case "pointer": {
				const previous = pointers.get(event.id)

				if (event.phase === "down") {
					pointers.set(event.id, { x: event.x, y: event.y })
				} else if (event.phase === "move" && previous !== undefined) {
					if (pointers.size === 1) {
						next = panView(next, event.x - previous.x, event.y - previous.y)
					} else {
						// Two fingers: zoom by the change in their distance, about their midpoint.
						const other = [...pointers.entries()].find(([id]) => id !== event.id)?.[1]

						if (other !== undefined) {
							const before = Math.hypot(previous.x - other.x, previous.y - other.y)
							const after = Math.hypot(event.x - other.x, event.y - other.y)

							if (before > 0)
								next = zoomView(next, fit, after / before, width, height, (event.x + other.x) / 2, (event.y + other.y) / 2)
						}
					}

					pointers.set(event.id, { x: event.x, y: event.y })
				} else if (event.phase === "up" || event.phase === "cancel") {
					pointers.delete(event.id)
				}

				break
			}
			case "wheel":
				next = zoomView(next, fit, wheelFactor(event.deltaY), width, height, event.x, event.y)

				break
			case "key":
				if (event.phase !== "down") break

				switch (event.key) {
					case "+":
					case "=":
						next = zoomView(next, fit, KEY_ZOOM, width, height, width / 2, height / 2)
						break
					case "-":
						next = zoomView(next, fit, 1 / KEY_ZOOM, width, height, width / 2, height / 2)
						break
					case "0":
						next = fit
						break
					case "ArrowLeft":
						next = panView(next, KEY_PAN * pixelRatio, 0)
						break
					case "ArrowRight":
						next = panView(next, -KEY_PAN * pixelRatio, 0)
						break
					case "ArrowUp":
						next = panView(next, 0, KEY_PAN * pixelRatio)
						break
					case "ArrowDown":
						next = panView(next, 0, -KEY_PAN * pixelRatio)
						break
				}

				break
		}
	}

	if (next !== current) {
		view = next
		schedule()
	}
}

function resize(next: { width: number; height: number; pixelRatio: number }): void {
	const refit = view !== null && fitted !== null && view === fitted

	width = next.width
	height = next.height
	pixelRatio = next.pixelRatio

	if (canvas !== null) {
		canvas.width = width
		canvas.height = height
	}

	if (plot !== null) {
		const fit = plot.fit(width, height)

		// A view still at its fit follows the canvas; a panned one keeps its place.
		if (refit || view === null) view = fit

		fitted = fit
	}

	schedule()
}

function onShell({ data }: MessageEvent<ShellToWorker>): void {
	switch (data.type) {
		case "canvas":
			canvas = data.canvas
			context = canvas.getContext("2d")
			resize(data)
			// A 2D canvas has no texture cap of its own: the shell's default bounds the backing store.
			send({ type: "limits", maxTextureSize: 4096 })

			break
		case "resize":
			resize(data)

			break
		case "input":
			input(data.events)

			break
		case "visibility":
			break
	}
}

const api = {
	load: async (bytes: Uint8Array, format: GeoFileFormat, palette: GeoColors): Promise<GeoSummary> => {
		colors = palette

		const loaded = await loadGeo(bytes, format)
		const bounds = loaded.stats.bounds

		if (loaded.points !== null && loaded.cumulative !== null && bounds !== null) {
			plot = build(loaded.points, loaded.cumulative, loaded.waypoints, bounds)
			schedule()
		}

		const profile =
			loaded.points !== null && loaded.cumulative !== null
				? elevationProfile(loaded.points, loaded.cumulative, PROFILE_SAMPLES)
				: { distance: new Float64Array(0), elevation: new Float64Array(0) }

		return Comlink.transfer(
			{
				stats: loaded.stats,
				waypoints: loaded.waypoints.length,
				references: loaded.references,
				tooMany: loaded.points === null,
				profile
			},
			[profile.distance.buffer, profile.elevation.buffer]
		)
	},
	attach: (port: MessagePort): void => {
		shell?.close()
		shell = port
		port.onmessage = onShell
	},
	// The point `distance` metres along the track is marked (the profile's hover); null clears it.
	highlight: (distance: number | null): void => {
		const next = distance === null || plot === null ? -1 : pointAtDistance(plot.cumulative, distance)

		if (next !== highlighted) {
			highlighted = next
			schedule()
		}
	},
	// Back to the whole track.
	fit: (): void => {
		if (fitted !== null) {
			view = fitted
			schedule()
		}
	},
	setColors: (palette: GeoColors): void => {
		colors = palette
		schedule()
	}
}

export type GeoWorkerApi = typeof api

Comlink.expose(api)
