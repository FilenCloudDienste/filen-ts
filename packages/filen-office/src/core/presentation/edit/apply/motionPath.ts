import { appendAll } from "../../../arrays"
import { motionPathSyntax } from "./motionPathSyntax"
import type { Behavior, TimeNode } from "../../../anim/model"
import { parseMotionPath } from "../../../anim/motion"
import { motionBehaviors, translatePathText, withPath } from "../../../anim/motionEdit"
import { DEFAULT_PRESENTATION_BUDGETS } from "../../budget"
import { PresentationError, refused, type Refused, type SlideNode } from "../../model"
import type { ApplyFamily, ApplyResult } from "../apply"
import type { MotionPathOp } from "../ops"
import { applyTiming } from "./timing"

// Applies the motionPath ops: setPath gives one animMotion behaviour (by its ctn id) a new path (ECMA-376 §19.5.4,
// slide-relative), its point types, and optionally its origin, path edit mode (Lock / Unlock: "fixed" / "relative")
// and relative angle. The path is checked before anything changes: only the §19.5.4 commands and numbers, and no more
// flattened segments than the timing budget lets the player compile. The behaviour is then set through the timing
// family's setBehavior, so the inverse puts the slide's timing back as it was (its source bytes after a save), and
// the writer rewrites only that behaviour's attributes (every other node of p:timing stays its source span).

function behaviorOf(node: TimeNode, id: number): Behavior | undefined {
	const stack: TimeNode[] = [node]

	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		if (next.ctn.id === id) return next.kind === "behavior" ? next.behavior : undefined

		appendAll(stack, next.ctn.children)
		appendAll(stack, next.ctn.subTnLst ?? [])
	}

	return undefined
}

function checkPath(path: string): Refused | undefined {
	if (!motionPathSyntax(path) || !/[Mm]/u.test(path)) return refused("malformed", "motion path syntax")

	try {
		parseMotionPath(path, 1, DEFAULT_PRESENTATION_BUDGETS.timing.motionSegments)
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)

		throw error
	}

	return undefined
}

export const applyMotionPath: ApplyFamily<MotionPathOp> = {
	apply: (deck, op, context): ApplyResult<MotionPathOp> => {
		if (deck.gate.length > 0) return refused("viewOnly", deck.gate.join(","))

		const bad =
			checkPath(op.path) ??
			(op.ptsTypes !== undefined && !/^[AFTSafts]*$/u.test(op.ptsTypes) ? refused("malformed", "ptsTypes") : undefined)

		if (bad !== undefined) return bad

		const slide = deck.nodes.get(op.slide)

		if (slide === undefined) return refused("notFound", `slide ${String(op.slide)}`)

		const prior = slide.timing === undefined ? undefined : behaviorOf(slide.timing.root, op.node)
		const behavior =
			prior === undefined
				? undefined
				: withPath(prior, {
						path: op.path,
						...(op.ptsTypes === undefined ? {} : { ptsTypes: op.ptsTypes }),
						...(op.origin === undefined ? {} : { origin: op.origin }),
						...(op.pathEditMode === undefined ? {} : { pathEditMode: op.pathEditMode }),
						...(op.rAng === undefined ? {} : { rAng: op.rAng })
					})

		if (behavior === undefined) return refused("notFound", `motion behaviour ${String(op.node)}`)

		const result = applyTiming.apply(deck, { family: "timing", kind: "setBehavior", slide: op.slide, node: op.node, behavior }, context)

		return "reason" in result ? result : { kind: "applied", inverse: result.inverse, op }
	},
	touches: op => [{ kind: "slide", slide: op.slide, dirt: { kind: "slidePart", part: "timing" } }]
}

// The setPath ops that keep `slide`'s locked paths (pathEditMode "fixed", §19.7.26: the path does not move with its
// shape) where they are on the slide when shapes move: each such path of a moved shape shifted back by the move, in
// fractions of the slide. `moves` are EMU; `size` the slide's.
export function lockedPathOps(
	slide: SlideNode,
	moves: readonly { readonly id: number; readonly dx: number; readonly dy: number }[],
	size: { readonly cx: number; readonly cy: number }
): MotionPathOp[] {
	const out: MotionPathOp[] = []

	if (slide.timing === undefined || size.cx <= 0 || size.cy <= 0) return out

	const byShape = new Map(moves.filter(move => move.dx !== 0 || move.dy !== 0).map(move => [move.id, move] as const))

	if (byShape.size === 0) return out

	for (const motion of motionBehaviors(slide.timing)) {
		const move = byShape.get(motion.shape)

		if (move === undefined || motion.pathEditMode !== "fixed") continue

		out.push({
			family: "motionPath",
			kind: "setPath",
			slide: slide.ref,
			node: motion.node,
			path: translatePathText(motion.path, -move.dx / size.cx, -move.dy / size.cy),
			...(motion.ptsTypes === undefined ? {} : { ptsTypes: motion.ptsTypes })
		})
	}

	return out
}
