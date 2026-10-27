import type { Box, LayoutContext, LayoutNode } from "../interp"
import { originalShape, ownValue, param, reshape } from "./shared"

// The pyramid algorithm (ECMA-376 L.4.15.6.1.1 pyra): the children are the levels of a pyramid, stacked in equal
// heights and widening towards its base (linDir fromB: the base at the bottom; fromT: at the top, an inverted
// pyramid), so their slanted sides line up into one triangle. Each child holds a level node (pyraLvlNode) and, when
// the level has accent text, an accent background (pyraAcctBkgdNode) and accent text node (pyraAcctTxNode) beside it
// (pyraAcctPos bef: on the left, aft: on the right) in a strip pyraAcctRatio of the width wide. PowerPoint's
// caches: a level is a trapezoid as high as the pyramid over the level count, its adjustment making the inset of
// each side half the pyramid's width over the count (75000 at a 3 : 2 frame), the apex a triangle.
//
// The level, accent background and accent text boxes are the pyramid's to give; the composite each child is laid
// out with takes them from here (pyraSlots) and lays the child's other nodes from their constraints on them.

export interface PyraSlot {
	// Absolute boxes of the child's named nodes.
	readonly boxes: ReadonlyMap<string, Box>
}

const slots = new WeakMap<LayoutNode, PyraSlot>()

// The boxes a pyramid gave the nodes of `node`, one of its levels.
export function pyraSlot(node: LayoutNode): PyraSlot | undefined {
	return slots.get(node)
}

function hasNamed(node: LayoutNode, name: string): LayoutNode | undefined {
	return name === "" ? undefined : node.children.find(child => child.name === name)
}

export function pyraLayout(node: LayoutNode, _context: LayoutContext): void {
	const box = node.box
	const levels = node.children
	const n = levels.length

	if (n === 0) return

	const inverted = param(node, "linDir", "fromB") === "fromT"
	const before = param(node, "pyraAcctPos", "bef") === "bef"
	const stepped = param(node, "pyraAcctTxMar", "stack") === "step"
	const levelName = param(node, "pyraLvlNode", "")
	const bkgdName = param(node, "pyraAcctBkgdNode", "")
	const txName = param(node, "pyraAcctTxNode", "")
	const accented = levels.some(level => hasNamed(level, bkgdName) !== undefined || hasNamed(level, txName) !== undefined)
	const ratio = ownValue(node, "pyraAcctRatio")
	const accent = accented && ratio !== undefined && Number.isFinite(ratio) ? Math.min(0.9, Math.max(0, ratio)) : 0
	const pyramidW = box.w * (1 - accent)
	const pyramidX = before ? box.x + box.w - pyramidW : box.x
	const h = box.h / n
	const inset = pyramidW / (2 * n)

	levels.forEach((level, i) => {
		// Level i from the top widens to the base: i + 1 of n steps of the base, or n − i inverted.
		const stepsWide = inverted ? n - i : i + 1
		const w = (pyramidW * stepsWide) / n
		const y = box.y + i * h
		const levelBox: Box = { x: pyramidX + (pyramidW - w) / 2, y, w, h }
		const boxes = new Map<string, Box>()

		// A level is a node holding the level shape and its accents, or the level shape itself.
		const shapeNode = level.name === levelName || levelName === "" ? level : hasNamed(level, levelName)

		level.box = shapeNode === level ? levelBox : { x: box.x, y, w: box.w, h }

		if (shapeNode !== undefined) {
			if (shapeNode !== level) boxes.set(shapeNode.name, levelBox)

			const shape = originalShape(shapeNode)

			if (shape !== undefined && (shape.type === "trapezoid" || shape.type === "triangle")) {
				const side = Math.min(w, h)

				reshape(shapeNode, {
					adj: side > 0 ? [{ idx: 1, val: inset / side }] : shape.adj,
					// An inverted pyramid's levels narrow downwards: the trapezoid upside down.
					rot: (shape.rot + (inverted ? 180 : 0)) % 360
				})
			}
		}

		if (accent > 0) {
			// The accent strip runs from the level's slanted side to the edge of the box; its text keeps off the
			// slant (step: by the level's inset at its own height, stack: by the widest level's).
			const near = before ? box.x : levelBox.x + levelBox.w - inset
			const far = before ? levelBox.x + inset : box.x + box.w
			const bkgd: Box = { x: Math.min(near, far), y, w: Math.abs(far - near), h }
			const textInset = stepped ? inset : pyramidX + pyramidW - (levelBox.x + levelBox.w) + inset
			const tx: Box = before
				? { x: bkgd.x, y, w: Math.max(0, bkgd.w - textInset), h }
				: { x: bkgd.x + textInset, y, w: Math.max(0, bkgd.w - textInset), h }
			const bkgdNode = hasNamed(level, bkgdName)

			if (bkgdNode !== undefined) {
				boxes.set(bkgdNode.name, bkgd)

				const shape = originalShape(bkgdNode)

				if (shape?.type === "nonIsoscelesTrapezoid" && bkgd.w > 0) {
					const side = Math.min(bkgd.w, h)
					const slant = side > 0 ? inset / side : 0

					reshape(bkgdNode, {
						adj: before
							? [
									{ idx: 1, val: 0 },
									{ idx: 2, val: slant }
								]
							: [
									{ idx: 1, val: slant },
									{ idx: 2, val: 0 }
								]
					})
				}
			}

			const txNode = hasNamed(level, txName)

			if (txNode !== undefined) boxes.set(txNode.name, tx)
		}

		slots.set(level, { boxes })
	})
}
