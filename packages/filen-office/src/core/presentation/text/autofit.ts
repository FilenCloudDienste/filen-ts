import type { Xfrm } from "../model"
import { layoutBody, type BodyLayout, type LayoutOptions, type TextEnvironment } from "./body"
import type { ResolvedBody } from "./resolve"
import { turnOf } from "./vertical"

// Autofit refitted as a body is edited (ECMA-376 §21.1.2.1.3 normAutofit, §21.1.2.1.4 spAutoFit): PowerPoint finds a
// "shrink text on overflow" body's fontScale and lnSpcReduction anew from the text, and resizes a "resize shape to
// fit text" shape to its text. A file's stored values are drawn as they are until the body is edited.

// The steps PowerPoint writes: fontScale 7.5% and lnSpcReduction 10% less a step, lnSpcReduction to 20%, fontScale to
// 25% (92500/10000, 85000/20000 … 25000/20000).
const LAST_STEP = 10

function stepScale(step: number): number {
	return (1000 - 75 * step) / 1000
}

function stepReduction(step: number): number {
	return Math.min(2, step) / 10
}

// The step nearest a stored fontScale (the search starts there: most edits keep it or move one step).
function nearestStep(fontScale: number): number {
	return Math.max(0, Math.min(LAST_STEP, Math.round((1 - fontScale) / 0.075)))
}

export interface NormAutofitFit {
	readonly layout: BodyLayout
	readonly fontScale: number
	readonly lineSpacingReduction: number
}

// The largest step a normAutofit body fits its box at (from fontScale 1 and no reduction, so deleted text grows it
// back), the last step when none fits. Starts at the stored step and tries the next larger one first: an edit that
// keeps the step lays the body out twice.
export function refitNormAutofit(
	resolved: ResolvedBody,
	box: { readonly width: number; readonly height: number },
	env: TextEnvironment,
	options: LayoutOptions = {}
): NormAutofitFit {
	const layouts: (BodyLayout | undefined)[] = []
	const at = (step: number): BodyLayout => {
		const held = layouts[step]

		if (held !== undefined) return held

		const bodyPr = {
			...resolved.bodyPr,
			autofit: "normal" as const,
			fontScale: stepScale(step),
			lineSpacingReduction: stepReduction(step)
		}
		const layout = layoutBody({ ...resolved, bodyPr }, box, env, options)

		layouts[step] = layout

		return layout
	}
	const fits = (step: number): boolean => !at(step).overflow
	const start = nearestStep(resolved.bodyPr.fontScale)
	// The smallest fitting step in [low, high], `high` fitting (or the last step).
	const search = (from: number, to: number): number => {
		let low = from
		let high = to

		while (low < high) {
			const mid = (low + high) >> 1

			if (fits(mid)) high = mid
			else low = mid + 1
		}

		return high
	}
	let step: number

	if (fits(start)) step = start === 0 || !fits(start - 1) ? start : search(0, start - 1)
	else step = start === LAST_STEP ? LAST_STEP : search(start + 1, LAST_STEP)

	return { layout: at(step), fontScale: stepScale(step), lineSpacingReduction: stepReduction(step) }
}

const EMU_PER_PX = 9525
// A change smaller than this (EMU, half a px) leaves the box as it is.
const GROWTH_TOLERANCE = EMU_PER_PX / 2

// The box of a spAutoFit shape sized to its text: the text box (`box`, px, insets excluded, turned as layoutBody
// takes it) grown or shrunk by what the laid-out text needs past it, along the text's height (the shape's width for
// turned text), its top edge as the text reads kept where it is (turned with the shape's rotation and flips).
// `scale`: the shape's EMU per slide EMU along that axis (a group's child space). Undefined when nothing changes,
// and for stacked WordArt (its height is the column, not a line count).
export function spAutoFitXfrm(
	xfrm: Xfrm,
	vertical: string,
	box: { readonly width: number; readonly height: number },
	needed: number,
	scale = 1
): Xfrm | undefined {
	if (vertical === "wordArtVert" || vertical === "wordArtVertRtl") return undefined

	const turn = turnOf(vertical)
	const along = turn === 0 ? xfrm.cy : xfrm.cx
	const next = Math.max(0, Math.round(along + (needed - box.height) * EMU_PER_PX * scale))
	const delta = next - along

	if (Math.abs(delta) < GROWTH_TOLERANCE * scale) return undefined

	// The growth's direction in the shape's own frame: down for horizontal text, away from the page's top otherwise
	// (a page turned 90° clockwise has its top on the right).
	let dx = turn === 90 ? -1 : turn === 270 ? 1 : 0
	let dy = turn === 0 ? 1 : 0

	if (xfrm.flipH) dx = -dx
	if (xfrm.flipV) dy = -dy

	const angle = (xfrm.rot / 60_000) * (Math.PI / 180)
	const cos = Math.cos(angle)
	const sin = Math.sin(angle)
	// The centre moves half the growth along that direction, rotated; the offset keeps the new extents about it.
	const shiftX = ((dx * cos - dy * sin) * delta) / 2
	const shiftY = ((dx * sin + dy * cos) * delta) / 2
	const cx = turn === 0 ? xfrm.cx : next
	const cy = turn === 0 ? next : xfrm.cy

	return {
		...xfrm,
		x: Math.round(xfrm.x + xfrm.cx / 2 + shiftX - cx / 2),
		y: Math.round(xfrm.y + xfrm.cy / 2 + shiftY - cy / 2),
		cx,
		cy
	}
}
