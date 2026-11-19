import { parseLength } from "../../../odf/units"
import { EMU_PER_PT } from "../../read/fills"
import type { AttributeChange } from "./shape"

// Elements whose box is svg:x/y/width/height (with draw:transform), and lines (their ends, §19.570–19.573): what the
// emitters write a box for, the proof gate moves a locked shape by, and a slide resize moves a master page shape by.
export const BOXED: ReadonlySet<string> = new Set([
	"draw:frame",
	"draw:custom-shape",
	"draw:rect",
	"draw:ellipse",
	"draw:circle",
	"draw:polygon",
	"draw:polyline",
	"draw:path",
	"draw:regular-polygon",
	"draw:caption",
	"draw:control",
	"draw:page-thumbnail",
	"dr3d:scene"
])
export const LINES: ReadonlySet<string> = new Set(["draw:line", "draw:connector", "draw:measure"])
export const LENGTHS: ReadonlySet<string> = new Set(["svg:x", "svg:y", "svg:width", "svg:height", "svg:x1", "svg:y1", "svg:x2", "svg:y2"])

export function emuOf(value: string | undefined): number | undefined {
	const points = parseLength(value)

	return points === undefined ? undefined : Math.round(points * EMU_PER_PT)
}

// A box's attribute changes less the lengths the element already writes as the same EMU (ODF 1.3 Part 1 §18.3.18:
// any unit), so a length an edit did not change keeps the file's text and unit.
export function changedLengths(changes: readonly AttributeChange[], attributes: ReadonlyMap<string, string>): AttributeChange[] {
	return changes.filter(change => {
		if (change.value === null || !LENGTHS.has(change.name)) return true

		const written = emuOf(attributes.get(change.name))

		return written === undefined || written !== emuOf(change.value)
	})
}
