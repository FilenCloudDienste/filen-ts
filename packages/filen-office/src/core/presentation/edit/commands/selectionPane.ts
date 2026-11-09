import type { ShapeRef, SlideRef } from "../../model"
import type { OutlineShape } from "../../outline"
import type { DeckOp } from "../ops"
import { xmlSafeText } from "../xmlText"

// The Selection Pane's commands and its list: Show All / Hide All and each object's eye (hidden), renaming (cNvPr
// name), and reordering by drag (z-order). The list shows the front-most object at the top, as PowerPoint's does,
// groups as rows whose members are indented under them.

// One row of the pane's list, top to bottom.
export interface OutlineRow {
	readonly shape: OutlineShape
	readonly depth: number
	// The group it is in (0: the slide).
	readonly parent: number
	// Its place among its siblings, back to front (the model's order), and their count.
	readonly index: number
	readonly count: number
}

// The rows shown: front-most first at every level, a collapsed group's members left out.
export function outlineRows(shapes: readonly OutlineShape[], collapsed: ReadonlySet<number>): OutlineRow[] {
	const out: OutlineRow[] = []
	const walk = (list: readonly OutlineShape[], depth: number, parent: number): void => {
		for (let index = list.length - 1; index >= 0; index--) {
			const shape = list[index] as OutlineShape

			out.push({ shape, depth, parent, index, count: list.length })

			if (shape.children !== undefined && shape.children.length > 0 && !collapsed.has(shape.id))
				walk(shape.children, depth + 1, shape.id)
		}
	}

	walk(shapes, 0, 0)

	return out
}

// Every object's id, members however deep included.
export function outlineIds(shapes: readonly OutlineShape[]): number[] {
	const out: number[] = []
	const walk = (list: readonly OutlineShape[]): void => {
		for (const shape of list) {
			out.push(shape.id)

			if (shape.children !== undefined) walk(shape.children)
		}
	}

	walk(shapes)

	return out
}

// The siblings of a level, back to front (0: the slide's top level); undefined for an id that is no group.
export function outlineLevel(shapes: readonly OutlineShape[], parent: number): readonly OutlineShape[] | undefined {
	if (parent === 0) return shapes

	for (const shape of shapes) {
		if (shape.id === parent) return shape.children ?? []

		const inner = shape.children === undefined ? undefined : outlineLevel(shape.children, parent)

		if (inner !== undefined) return inner
	}

	return undefined
}

// Whether the editor may hide, show or rename the object (a locked one, as the file or the session holds it, stays).
export function outlineEditable(shape: OutlineShape): boolean {
	return shape.lock === undefined
}

// Show All / Hide All: every object of the slide the editor may change, at every level, that is not as asked yet.
export function visibilityAllOp(slide: SlideRef, shapes: readonly OutlineShape[], hidden: boolean): DeckOp | undefined {
	const ids: number[] = []
	const walk = (list: readonly OutlineShape[]): void => {
		for (const shape of list) {
			if (outlineEditable(shape) && shape.hidden !== hidden) ids.push(shape.id)
			if (shape.children !== undefined) walk(shape.children)
		}
	}

	walk(shapes)

	return visibilityOp(slide, ids, hidden)
}

export function visibilityOp(slide: SlideRef, ids: readonly number[], hidden: boolean): DeckOp | undefined {
	return ids.length === 0 ? undefined : { family: "shape", kind: "setHidden", slide, shapes: [...new Set(ids)], hidden }
}

// A name as the rename box leaves it: what XML cannot carry taken out, trimmed; nothing (an empty name, or the one it
// has) is no op.
export function nameOp(target: ShapeRef, name: string, current: string): DeckOp | undefined {
	const next = xmlSafeText(name).trim()

	return next === "" || next === current ? undefined : { family: "shape", kind: "setName", target, name: next }
}

// A drag of `moved` (siblings of one level) dropped above (in front of) or below (behind) the row of `target`, a
// sibling of theirs: the z-order op that puts them there, undefined when they would not move.
export function reorderOp(
	slide: SlideRef,
	siblings: readonly OutlineShape[],
	moved: readonly number[],
	target: number,
	place: "above" | "below"
): DeckOp | undefined {
	const ids = new Set(moved)
	const kept = siblings.filter(shape => !ids.has(shape.id))
	const at = kept.findIndex(shape => shape.id === target)

	// Not all of one level, or dropped onto one of the dragged rows (they stay where they are).
	if (ids.size === 0 || ids.size + kept.length !== siblings.length || at < 0) return undefined

	const index = place === "above" ? at + 1 : at
	const order = [...kept.slice(0, index), ...siblings.filter(shape => ids.has(shape.id)), ...kept.slice(index)]

	if (order.every((shape, k) => shape === siblings[k])) return undefined

	return { family: "shape", kind: "zOrder", slide, shapes: [...ids], to: index }
}
