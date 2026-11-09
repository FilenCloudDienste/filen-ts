import { shapeEffects, styleRef, type PaintContext, type ShapeEffect } from "../../drawingml/fill"
import { D, type DrawingReader } from "../../drawingml/reader"
import type { RenderEffects } from "../output"

// Shape effects as a layer draws them around its drawing, and the report of what was not drawn as written.

// What a render did not draw exactly, with counts (by effect or feature name), for the fidelity report.
export class RenderReport {
	readonly approximated = new Map<string, number>()
	readonly unsupported = new Map<string, number>()

	approximate(name: string, count: number = 1): void {
		this.approximated.set(name, (this.approximated.get(name) ?? 0) + count)
	}

	refuse(name: string, count: number = 1): void {
		this.unsupported.set(name, (this.unsupported.get(name) ?? 0) + count)
	}

	merge(other: RenderReport): void {
		for (const [name, count] of other.approximated) this.approximate(name, count)
		for (const [name, count] of other.unsupported) this.refuse(name, count)
	}

	toJSON(): { approximated: Record<string, number>; unsupported: Record<string, number> } {
		return { approximated: Object.fromEntries(this.approximated), unsupported: Object.fromEntries(this.unsupported) }
	}
}

// 3D on a shape (§20.1.5): read past, drawn flat.
export const FLAT: readonly string[] = ["scene3d", "sp3d"]

// The effects of a resolved element's spPr (its own, else its style's effect reference) beyond the first outer
// shadow, which the drawing itself carries; with `carried` false (the drawing drew no fill or line to carry it) that
// shadow too. A group's effects (grpSpPr, §20.1.2.2.22; no style) are all drawn around the group: its drawing carries
// none of them, its children's shadows being their own.
export function layerEffects(
	context: PaintContext,
	reader: DrawingReader,
	element: number,
	report: RenderReport,
	carried: boolean = true
): RenderEffects | undefined {
	const group = reader.local(element) === "grpSp"
	const read = group
		? shapeEffects(context, reader, reader.child(element, D.P, "grpSpPr"), undefined)
		: shapeEffects(
				context,
				reader,
				reader.child(element, D.P, "spPr"),
				styleRef(context, reader, reader.child(reader.child(element, D.P, "style"), D.A, "effectRef"), "effect")
			)

	const skipFirstShadow = carried && !group

	for (const name of read.approximated) report.approximate(name)
	if (read.repeated > 0) report.approximate("effectLst:repeated", read.repeated)

	let shadowSeen = false
	const out: ShapeEffect[] = []

	read.effects.forEach((effect, k) => {
		if (skipFirstShadow && read.sources[k] === "outerShdw" && !shadowSeen) shadowSeen = true
		else out.push(effect)
	})

	return out.length === 0 ? undefined : out
}
