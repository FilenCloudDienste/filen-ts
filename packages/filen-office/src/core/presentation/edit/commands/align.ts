import type { SlideRef } from "../../model"
import type { DeckOp } from "../ops"

// Align and Distribute, relative to the slide or to the selection. With one shape PowerPoint aligns to the slide
// whatever the setting, and distributing needs three shapes across the selection (or one across the slide).

export type AlignEdge = "left" | "center" | "right" | "top" | "middle" | "bottom"
export type DistributeAxis = "horizontal" | "vertical"
export type AlignTarget = "slide" | "selection"

export const ALIGN_EDGES: readonly AlignEdge[] = ["left", "center", "right", "top", "middle", "bottom"]

// What a choice of `target` means for a selection of `count` shapes.
export function alignTarget(count: number, target: AlignTarget): AlignTarget {
	return count < 2 ? "slide" : target
}

export function canAlign(count: number): boolean {
	return count >= 1
}

export function canDistribute(count: number, target: AlignTarget): boolean {
	return alignTarget(count, target) === "slide" ? count >= 1 : count >= 3
}

export function alignOp(slide: SlideRef, ids: readonly number[], edge: AlignEdge, target: AlignTarget): DeckOp | undefined {
	if (!canAlign(ids.length)) return undefined

	return { family: "shape", kind: "align", slide, shapes: [...ids], edge, relativeTo: alignTarget(ids.length, target) }
}

export function distributeOp(slide: SlideRef, ids: readonly number[], axis: DistributeAxis, target: AlignTarget): DeckOp | undefined {
	if (!canDistribute(ids.length, target)) return undefined

	return { family: "shape", kind: "distribute", slide, shapes: [...ids], axis, relativeTo: alignTarget(ids.length, target) }
}
