// A drag that began with a double or triple click selects whole words or paragraphs: the one pressed stays
// selected, and past either of its ends the selection grows to the whole unit under the pointer, anchored at
// the pressed unit's far end.

export interface UnitRange {
	readonly from: number
	readonly to: number
}

export function unitDragSelection(pressed: UnitRange, under: UnitRange): { readonly anchor: number; readonly head: number } {
	if (under.to > pressed.to) return { anchor: pressed.from, head: under.to }
	if (under.from < pressed.from) return { anchor: pressed.to, head: under.from }

	return { anchor: pressed.from, head: pressed.to }
}
