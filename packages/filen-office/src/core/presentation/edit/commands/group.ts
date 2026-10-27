import type { LayerRole } from "../../output"
import type { ShapeLocks, SlideRef } from "../../model"
import type { DeckOp } from "../ops"
import { oneStep } from "./batch"

// Group and Ungroup. Placeholders cannot be grouped (PowerPoint refuses it too), nor shapes the file locks against it
// (noGrp; a group's noUngrp keeps it whole); the worker refuses anything else it cannot do (a child taking its group's
// fill) with a typed reason.

export interface GroupCandidate {
	readonly id: number
	readonly role: LayerRole
	readonly locks?: ShapeLocks
}

export function canGroup(shapes: readonly GroupCandidate[]): boolean {
	return (
		new Set(shapes.map(shape => shape.id)).size >= 2 &&
		shapes.every(shape => shape.role !== "placeholder" && shape.locks?.noGrp !== true)
	)
}

export function canUngroup(shapes: readonly GroupCandidate[]): boolean {
	return shapes.some(shape => shape.role === "group" && shape.locks?.noUngrp !== true)
}

export function groupOp(slide: SlideRef, ids: readonly number[]): DeckOp | undefined {
	return new Set(ids).size < 2 ? undefined : { family: "shape", kind: "group", slide, shapes: [...ids] }
}

// Every selected group, one op each (PowerPoint ungroups each group of a selection), sent as one step.
export function ungroupOps(slide: SlideRef, shapes: readonly GroupCandidate[]): DeckOp[] {
	return oneStep(
		shapes
			.filter(shape => shape.role === "group" && shape.locks?.noUngrp !== true)
			.map((shape): DeckOp => ({ family: "shape", kind: "ungroup", slide, group: shape.id }))
	)
}
