import type { TimingTree } from "../../../../core/anim/model"
import { CUSTOM_PATH_ID, motionBehaviors, readEditablePath, type MotionBehavior } from "../../../../core/anim/motionEdit"
import type { Xfrm } from "../../../../core/presentation/model"
import type { MotionPathView } from "./MotionPathLayer"

// The slide's motion paths as the canvas shows them: each animMotion with a path, placed at its shape's centre. The
// centre comes from the shape's box in the render in view (what the canvas shows now, a drop included) and, for a
// shape inside a group, from the boxes the worker resolved with the timing (id, x, y, cx, cy per shape, EMU).

const viewsOf = new WeakMap<TimingTree, { readonly key: string; readonly views: readonly MotionPathView[] }>()

export function motionPathViews(
	timing: TimingTree | undefined,
	geometry: Float64Array | undefined,
	boxes: readonly { readonly id: number; readonly xfrm: Xfrm }[]
): readonly MotionPathView[] {
	if (timing === undefined) return []

	const key = boxes
		.map(box => `${String(box.id)}:${String(box.xfrm.x)}:${String(box.xfrm.y)}:${String(box.xfrm.cx)}:${String(box.xfrm.cy)}`)
		.join(",")
	const known = viewsOf.get(timing)

	if (known !== undefined && known.key === key) return known.views

	const centres = new Map<number, { x: number; y: number }>()

	if (geometry !== undefined)
		for (let i = 0; i + 4 < geometry.length; i += 5)
			centres.set(geometry[i] ?? 0, {
				x: (geometry[i + 1] ?? 0) + (geometry[i + 3] ?? 0) / 2,
				y: (geometry[i + 2] ?? 0) + (geometry[i + 4] ?? 0) / 2
			})

	for (const box of boxes) centres.set(box.id, { x: box.xfrm.x + box.xfrm.cx / 2, y: box.xfrm.y + box.xfrm.cy / 2 })

	const views: MotionPathView[] = []

	for (const motion of motionBehaviors(timing)) {
		const center = centres.get(motion.shape)

		if (center === undefined) continue

		views.push({
			node: motion.node,
			effect: motion.effect,
			shape: motion.shape,
			path: motion.path,
			...(motion.ptsTypes === undefined ? {} : { ptsTypes: motion.ptsTypes }),
			...(motion.pathEditMode === undefined ? {} : { pathEditMode: motion.pathEditMode }),
			center
		})
	}

	viewsOf.set(timing, { key, views })

	return views
}

// Whether Edit Points can edit a path (one subpath of §19.5.4 commands); others stay as the file wrote them.
export function editablePath(motion: Pick<MotionBehavior, "path" | "ptsTypes">): boolean {
	return !("reason" in readEditablePath(motion.path, motion.ptsTypes))
}

// A path the user drew (presetID 0, or none in an ODF file's path class), as opposed to one of the preset paths.
export function isCustomPath(presetClass: string | undefined, presetID: number | undefined): boolean {
	return presetClass === "path" && (presetID === undefined || presetID === CUSTOM_PATH_ID)
}
