import type { VerticalMetrics } from "./metrics"
import type { BundledFamily } from "./substitutes"
import { BUNDLED_FACES } from "./tables.generated"

export interface BundledFace {
	readonly family: BundledFamily
	// Path under assets/fonts, as the app serves or reads it.
	readonly file: string
	// A [min, max] range for variable fonts.
	readonly weight: number | readonly [number, number]
	readonly italic: boolean
	readonly bytes: number
	readonly metrics: VerticalMetrics
}

// Vertical metrics of an original font: from a project built to reproduce them, or read once from the original's
// own tables and recorded as numbers (assets/fonts/manifest.json measuredLineMetrics).
export interface OriginalMetrics {
	readonly source: string
	readonly metrics: VerticalMetrics
}

// Line metrics for a document's family name. "original": the original font's own; "calibrated":
// derived from page breaks Word recorded in public documents (no font file is read); "substitute": neither,
// so layout uses what the substitute draws with.
export type LineMetricsEntry = ({ readonly basis: "original" | "calibrated" } & OriginalMetrics) | { readonly basis: "substitute" }

const facesByFamily = new Map<BundledFamily, BundledFace[]>()

for (const face of BUNDLED_FACES) {
	const list = facesByFamily.get(face.family)

	if (list === undefined) facesByFamily.set(face.family, [face])
	else list.push(face)
}

function weightDistance(face: BundledFace, weight: number): number {
	const [min, max] = typeof face.weight === "number" ? [face.weight, face.weight] : face.weight

	return weight < min ? min - weight : weight > max ? weight - max : 0
}

// The face CSS font matching would pick: matching style first (an upright face stands in, slanted by the
// browser, when a family has no italic), then the closest weight, lighter on ties below 500 and heavier
// above, as the CSS rule prefers.
export function bundledFace(family: BundledFamily, weight: number, italic: boolean): BundledFace | undefined {
	const faces = facesByFamily.get(family)

	if (faces === undefined) return undefined

	const styled = faces.some(face => face.italic === italic) ? faces.filter(face => face.italic === italic) : faces
	let best: BundledFace | undefined
	let bestDistance = Infinity

	for (const face of styled) {
		const distance = weightDistance(face, weight)
		const center = typeof face.weight === "number" ? face.weight : face.weight[0]
		const preferred = weight > 500 ? center > weight : center < weight

		if (distance < bestDistance || (distance === bestDistance && preferred)) {
			best = face
			bestDistance = distance
		}
	}

	return best
}
