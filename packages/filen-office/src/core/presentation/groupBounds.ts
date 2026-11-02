import type { ShapeNode, Xfrm } from "./model"

// A group's box: the bounds of its children as they are drawn (rotated boxes by their corners), which is where
// LibreOffice places a group (its snap rectangle).
export function groupBounds(children: readonly ShapeNode[]): Xfrm {
	let left = Infinity
	let top = Infinity
	let right = -Infinity
	let bottom = -Infinity

	for (const child of children) {
		const xfrm = child.xfrm

		if (xfrm === undefined) continue

		const radians = (xfrm.rot / 60_000) * (Math.PI / 180)
		const cos = Math.abs(Math.cos(radians))
		const sin = Math.abs(Math.sin(radians))
		const halfW = (xfrm.cx * cos + xfrm.cy * sin) / 2
		const halfH = (xfrm.cx * sin + xfrm.cy * cos) / 2
		const centerX = xfrm.x + xfrm.cx / 2
		const centerY = xfrm.y + xfrm.cy / 2

		left = Math.min(left, centerX - halfW)
		top = Math.min(top, centerY - halfH)
		right = Math.max(right, centerX + halfW)
		bottom = Math.max(bottom, centerY + halfH)
	}

	if (!Number.isFinite(left)) return { x: 0, y: 0, cx: 0, cy: 0, rot: 0, flipH: false, flipV: false }

	const x = Math.round(left)
	const y = Math.round(top)

	return { x, y, cx: Math.round(right) - x, cy: Math.round(bottom) - y, rot: 0, flipH: false, flipV: false }
}

// Whether a group maps its members' space onto its box unturned and unmirrored (an ODP group as read maps it onto
// itself; one the session moved or resized shifts and scales it): its box then follows its members' bounds.
function straight(xfrm: Xfrm | undefined): xfrm is Xfrm & { chX: number; chY: number; chCx: number; chCy: number } {
	return (
		xfrm !== undefined &&
		xfrm.rot === 0 &&
		!xfrm.flipH &&
		!xfrm.flipV &&
		xfrm.chX !== undefined &&
		xfrm.chY !== undefined &&
		xfrm.chCx !== undefined &&
		xfrm.chCy !== undefined &&
		xfrm.chCx > 0 &&
		xfrm.chCy > 0
	)
}

// Every group of `shapes` holding a shape of `changed` (however deep) whose mapping is straight takes its members'
// bounds again, innermost first, through the same mapping: an ODP group's box is where its members are drawn (the
// reader's reading of the file the writer makes, which places members where the mapping puts them).
export function refitGroups(shapes: readonly ShapeNode[], changed: ReadonlySet<number>): void {
	const visit = (shape: ShapeNode, depth: number): boolean => {
		if (shape.children === undefined || depth > 256) return changed.has(shape.id)

		let holds = false

		for (const child of shape.children) if (visit(child, depth + 1)) holds = true

		const xfrm = shape.xfrm

		if (holds && shape.kind === "grpSp" && straight(xfrm)) {
			const sx = xfrm.cx / xfrm.chCx
			const sy = xfrm.cy / xfrm.chCy
			// Each member as the writer places it: its centre through the mapping, its size scaled, its turn kept; the
			// group's box is their drawn bounds (turned boxes by their corners), as the reader reads the file back.
			const placed = shape.children.map(child => {
				const own = child.xfrm

				if (own === undefined) return child

				const cx = own.cx * sx
				const cy = own.cy * sy
				const centerX = xfrm.x + (own.x + own.cx / 2 - xfrm.chX) * sx
				const centerY = xfrm.y + (own.y + own.cy / 2 - xfrm.chY) * sy

				return { ...child, xfrm: { ...own, x: centerX - cx / 2, y: centerY - cy / 2, cx, cy } }
			})
			const bounds = groupBounds(placed)

			shape.xfrm = {
				...xfrm,
				x: bounds.x,
				y: bounds.y,
				cx: bounds.cx,
				cy: bounds.cy,
				chX: Math.round(xfrm.chX + (bounds.x - xfrm.x) / sx),
				chY: Math.round(xfrm.chY + (bounds.y - xfrm.y) / sy),
				chCx: Math.round(bounds.cx / sx),
				chCy: Math.round(bounds.cy / sy)
			}
		}

		return holds || changed.has(shape.id)
	}

	for (const shape of shapes) visit(shape, 0)
}
