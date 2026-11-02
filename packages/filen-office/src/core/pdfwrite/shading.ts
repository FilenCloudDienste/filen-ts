import { appendAll } from "../arrays"
import { pdfName, type PdfDict, type PdfValue } from "./objects"

// Gradients as axial (type 2) and radial (type 3) shadings (ISO 32000-1 §8.7.4.5.3-4) over a stitching
// function (type 3, §7.10.4) of exponential interpolations (type 2, §7.10.3) between neighbouring stops.
// Reflect and repeat spreads are unrolled over the parameter range the painted area needs. Alpha that varies
// across the stops becomes a luminosity soft mask with the same geometry (§11.6.5.2), built by the writer.

export interface PdfGradient {
	readonly type: "axial" | "radial"
	// Axial: x0 y0 x1 y1. Radial: x0 y0 r0 x1 y1 r1 (start circle, end circle). In the space the gradient is
	// painted in.
	readonly coords: readonly number[]
	// Positions 0..1 ascending; colours 0xRRGGBBAA.
	readonly offsets: ArrayLike<number>
	readonly colors: ArrayLike<number>
	readonly spread?: "pad" | "reflect" | "repeat"
	// The area painted (min x, min y, max x, max y in the same space): how far reflect/repeat unroll, and the
	// soft mask's bounding box.
	readonly bounds: readonly [number, number, number, number]
}

// More periods than this pad instead (a hairline-thin repeating gradient over a page).
const MAX_PERIODS = 256

interface Stop {
	readonly offset: number
	readonly value: readonly number[]
}

function stopsOf(gradient: PdfGradient, channel: "rgb" | "alpha"): Stop[] {
	const stops: Stop[] = []
	const count = Math.min(gradient.offsets.length, gradient.colors.length)

	for (let index = 0; index < count; index++) {
		const color = (gradient.colors[index] ?? 0) >>> 0
		const offset = Math.min(1, Math.max(0, gradient.offsets[index] ?? 0))
		const value =
			channel === "rgb"
				? [((color >>> 24) & 255) / 255, ((color >>> 16) & 255) / 255, ((color >>> 8) & 255) / 255]
				: [(color & 255) / 255]

		stops.push({ offset: Math.max(offset, stops[stops.length - 1]?.offset ?? 0), value })
	}

	return stops
}

export function gradientAlpha(gradient: PdfGradient): { readonly uniform: boolean; readonly alpha: number } {
	const count = Math.min(gradient.offsets.length, gradient.colors.length)
	const first = (gradient.colors[0] ?? 0xff) & 255

	for (let index = 1; index < count; index++) if (((gradient.colors[index] ?? 0) & 255) !== first) return { uniform: false, alpha: 1 }

	return { uniform: true, alpha: first / 255 }
}

const round = (value: number): number => Math.round(value * 10000) / 10000

function exponential(c0: readonly number[], c1: readonly number[]): PdfDict {
	return { FunctionType: 2, Domain: [0, 1], C0: c0.map(round), C1: c1.map(round), N: 1 }
}

// The pieces of one period [0, 1]: constant before the first stop and after the last, interpolations between.
function period(stops: readonly Stop[], reversed: boolean): { functions: PdfDict[]; bounds: number[] } {
	const list = reversed ? stops.map(stop => ({ offset: 1 - stop.offset, value: stop.value })).reverse() : stops
	const functions: PdfDict[] = []
	const bounds: number[] = []
	let at = 0
	const first = list[0]
	const last = list[list.length - 1]

	if (first === undefined || last === undefined) return { functions: [exponential([0], [0])], bounds: [] }

	const piece = (end: number, c0: readonly number[], c1: readonly number[]): void => {
		if (end <= at + 1e-9) return
		if (functions.length > 0) bounds.push(round(at))

		functions.push(exponential(c0, c1))
		at = end
	}

	piece(first.offset, first.value, first.value)

	for (let index = 1; index < list.length; index++) {
		const from = list[index - 1]
		const to = list[index]

		if (from !== undefined && to !== undefined) piece(to.offset, from.value, to.value)
	}

	piece(1, last.value, last.value)

	if (functions.length === 0) functions.push(exponential(first.value, first.value))

	return { functions, bounds }
}

// The stitching function over [t0, t1] (whole periods when the spread unrolls).
function stitched(stops: readonly Stop[], t0: number, t1: number, spread: "pad" | "reflect" | "repeat"): PdfDict {
	const functions: PdfDict[] = []
	const bounds: number[] = []

	for (let k = Math.floor(t0); k < Math.ceil(t1); k++) {
		const piece = period(stops, spread === "reflect" && Math.abs(k) % 2 === 1)

		if (functions.length > 0) bounds.push(k)

		appendAll(functions, piece.functions)
		appendAll(
			bounds,
			piece.bounds.map(bound => round(k + bound))
		)
	}

	const domain = [Math.floor(t0), Math.ceil(t1)]

	if (functions.length === 1 && functions[0] !== undefined) return { ...functions[0], Domain: domain }

	return {
		FunctionType: 3,
		Domain: domain,
		Functions: functions,
		Bounds: bounds,
		Encode: functions.flatMap(() => [0, 1])
	}
}

// The parameter range the bounds need: t of the axis projection (axial) or of the end circle's radius
// (radial, from the start circle's centre), at the corners.
function range(gradient: PdfGradient): [number, number] {
	const [minX, minY, maxX, maxY] = gradient.bounds
	const corners = [
		[minX, minY],
		[maxX, minY],
		[minX, maxY],
		[maxX, maxY]
	]
	const c = gradient.coords
	let low = 0
	let high = 1

	if (gradient.type === "axial") {
		const dx = (c[2] ?? 0) - (c[0] ?? 0)
		const dy = (c[3] ?? 0) - (c[1] ?? 0)
		const length = dx * dx + dy * dy

		if (length === 0) return [0, 1]

		for (const [x = 0, y = 0] of corners) {
			const t = ((x - (c[0] ?? 0)) * dx + (y - (c[1] ?? 0)) * dy) / length

			low = Math.min(low, t)
			high = Math.max(high, t)
		}
	} else {
		const r1 = c[5] ?? 0

		if (r1 <= 0) return [0, 1]

		for (const [x = 0, y = 0] of corners) high = Math.max(high, Math.hypot(x - (c[0] ?? 0), y - (c[1] ?? 0)) / r1)

		low = 0
	}

	return [low, high]
}

// The shading dictionary for the colours ("rgb") or for the alpha soft mask ("alpha", DeviceGray).
export function shadingDict(gradient: PdfGradient, channel: "rgb" | "alpha"): PdfDict {
	const stops = stopsOf(gradient, channel)
	let spread = gradient.spread ?? "pad"
	let [t0, t1] = spread === "pad" ? [0, 1] : range(gradient)

	t0 = Math.floor(t0)
	t1 = Math.ceil(t1)

	if (t1 - t0 > MAX_PERIODS) {
		spread = "pad"
		t0 = 0
		t1 = 1
	}

	const c = gradient.coords
	const lerp = (from: number, to: number, t: number): number => from + (to - from) * t
	let coords: PdfValue[]

	if (gradient.type === "axial") {
		const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = c

		coords = [lerp(x0, x1, t0), lerp(y0, y1, t0), lerp(x0, x1, t1), lerp(y0, y1, t1)]
	} else {
		const [x0 = 0, y0 = 0, r0 = 0, x1 = 0, y1 = 0, r1 = 0] = c

		t0 = Math.max(0, t0)
		coords = [
			lerp(x0, x1, t0),
			lerp(y0, y1, t0),
			Math.max(0, lerp(r0, r1, t0)),
			lerp(x0, x1, t1),
			lerp(y0, y1, t1),
			Math.max(0, lerp(r0, r1, t1))
		]
	}

	return {
		ShadingType: gradient.type === "axial" ? 2 : 3,
		ColorSpace: pdfName(channel === "rgb" ? "DeviceRGB" : "DeviceGray"),
		Coords: coords.map(value => round(value as number)),
		Domain: [t0, t1],
		Function: stitched(stops, t0, t1, spread),
		Extend: [true, true]
	}
}

export function gradientKey(gradient: PdfGradient): string {
	return JSON.stringify([
		gradient.type,
		gradient.coords,
		Array.from(gradient.offsets),
		Array.from(gradient.colors),
		gradient.spread ?? "pad",
		gradient.bounds
	])
}
