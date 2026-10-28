import { parseLength } from "../../../odf/units"
import type { AttributeChange } from "./shape"

const EMU_PER_PT = 12_700
const LENGTHS: ReadonlySet<string> = new Set(["svg:x", "svg:y", "svg:width", "svg:height", "svg:x1", "svg:y1", "svg:x2", "svg:y2"])

function emuOf(value: string | undefined): number | undefined {
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
