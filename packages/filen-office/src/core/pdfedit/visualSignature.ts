// A visual signature or initials as the signature dialog makes it and Fill & Sign places it: pen strokes (drawn)
// or a PNG (typed, or an image). Pure data, no PDF and no DOM: the page builds it, the engine worker places it
// (dom/pdfedit/fillSign/signature.ts) and the saved-signatures file stores it.

// Strokes in a box `width` × `height` (y down), each a flat run of x, y pairs inside it. Normalised by
// normalizeStrokes: cropped to the ink, integer units, the longer side PDF_SIGNATURE_UNITS.
export interface PdfSignatureStrokes {
	readonly kind: "strokes"
	readonly width: number
	readonly height: number
	readonly strokes: readonly (readonly number[])[]
}

// A PNG of `width` × `height` pixels (its aspect is the signature's).
export interface PdfSignatureImage {
	readonly kind: "image"
	readonly png: Uint8Array
	readonly width: number
	readonly height: number
}

export type PdfVisualSignature = PdfSignatureStrokes | PdfSignatureImage

export type PdfSignatureRole = "signature" | "initials"

// [x0, y0, x1, y1] with x0 < x1, y0 < y1 (y down, as MuPDF's page space).
export type PdfPageRect = readonly [number, number, number, number]

// The longer side of normalised strokes: enough resolution for any printed size, small as JSON.
export const PDF_SIGNATURE_UNITS = 1000
// A stroke longer than this many points is thinned (a long scribble on a fast digitiser).
export const PDF_SIGNATURE_MAX_POINTS = 2000
// Strokes in one signature.
export const PDF_SIGNATURE_MAX_STROKES = 200

// Width over height.
export function signatureAspect(signature: PdfVisualSignature): number {
	return signature.height > 0 ? signature.width / signature.height : 1
}

// Chaikin corner cutting, `rounds` times: a pointer's jitter becomes a smooth curve. End points are kept, so a
// stroke still starts and ends where the pen did; strokes of one or two points are returned as they are.
export function smoothStroke(points: readonly number[], rounds = 2): number[] {
	let current = points.slice(0, points.length - (points.length % 2))

	for (let round = 0; round < rounds && current.length >= 6; round++) {
		const next: number[] = [current[0] ?? 0, current[1] ?? 0]

		for (let index = 0; index + 3 < current.length; index += 2) {
			const x0 = current[index] ?? 0
			const y0 = current[index + 1] ?? 0
			const x1 = current[index + 2] ?? 0
			const y1 = current[index + 3] ?? 0

			next.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, 0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1)
		}

		next.push(current[current.length - 2] ?? 0, current[current.length - 1] ?? 0)
		current = next
	}

	return current
}

// Every `step`-th point (and the last) of a stroke longer than `max` points.
function thin(points: readonly number[], max: number): readonly number[] {
	const count = points.length / 2

	if (count <= max) return points

	const step = Math.ceil(count / max)
	const kept: number[] = []

	for (let index = 0; index < count; index += step) kept.push(points[index * 2] ?? 0, points[index * 2 + 1] ?? 0)

	if ((count - 1) % step !== 0) kept.push(points[points.length - 2] ?? 0, points[points.length - 1] ?? 0)

	return kept
}

// Strokes in any units (as drawn, y down) → cropped to their ink plus `padding` (a fraction of the longer side, so
// a round pen end is not cut), scaled to integer units with the longer side PDF_SIGNATURE_UNITS. Consecutive
// points that round to the same unit are merged. Null when there is no ink.
export function normalizeStrokes(strokes: readonly (readonly number[])[], padding = 0.02): PdfSignatureStrokes | null {
	let minX = Number.POSITIVE_INFINITY
	let minY = Number.POSITIVE_INFINITY
	let maxX = Number.NEGATIVE_INFINITY
	let maxY = Number.NEGATIVE_INFINITY
	const usable = strokes.filter(stroke => stroke.length >= 2).slice(0, PDF_SIGNATURE_MAX_STROKES)

	for (const stroke of usable) {
		for (let index = 0; index + 1 < stroke.length; index += 2) {
			const x = stroke[index] ?? 0
			const y = stroke[index + 1] ?? 0

			if (!Number.isFinite(x) || !Number.isFinite(y)) continue

			minX = Math.min(minX, x)
			minY = Math.min(minY, y)
			maxX = Math.max(maxX, x)
			maxY = Math.max(maxY, y)
		}
	}

	if (!Number.isFinite(minX)) return null

	const extent = Math.max(maxX - minX, maxY - minY, 1e-6)
	const pad = extent * padding
	const scale = PDF_SIGNATURE_UNITS / (extent + 2 * pad)
	const width = Math.max(1, Math.round((maxX - minX + 2 * pad) * scale))
	const height = Math.max(1, Math.round((maxY - minY + 2 * pad) * scale))
	const result: number[][] = []

	for (const stroke of usable) {
		const points: number[] = []

		for (let index = 0; index + 1 < stroke.length; index += 2) {
			const x = stroke[index] ?? 0
			const y = stroke[index + 1] ?? 0

			if (!Number.isFinite(x) || !Number.isFinite(y)) continue

			const ux = Math.round((x - minX + pad) * scale)
			const uy = Math.round((y - minY + pad) * scale)

			if (points.length >= 2 && points[points.length - 2] === ux && points[points.length - 1] === uy) continue

			points.push(ux, uy)
		}

		if (points.length >= 2) result.push([...thin(points, PDF_SIGNATURE_MAX_POINTS)])
	}

	return result.length === 0 ? null : { kind: "strokes", width, height, strokes: result }
}

// The largest box of `aspect` (width / height) centred in `box`.
export function fitBox(aspect: number, box: PdfPageRect): PdfPageRect {
	const [x0, y0, x1, y1] = box
	const width = x1 - x0
	const height = y1 - y0

	if (!(aspect > 0) || width <= 0 || height <= 0) return box

	const fittedWidth = Math.min(width, height * aspect)
	const fittedHeight = fittedWidth / aspect
	const left = x0 + (width - fittedWidth) / 2
	const top = y0 + (height - fittedHeight) / 2

	return [left, top, left + fittedWidth, top + fittedHeight]
}

// A signature's strokes mapped into `box` (page space, y down), aspect kept.
export function strokesInBox(signature: PdfSignatureStrokes, box: PdfPageRect): number[][] {
	const [x0, y0, x1] = fitBox(signatureAspect(signature), box)
	const scale = (x1 - x0) / Math.max(signature.width, 1e-6)

	return signature.strokes.map(stroke => stroke.map((value, index) => (index % 2 === 0 ? x0 + value * scale : y0 + value * scale)))
}
