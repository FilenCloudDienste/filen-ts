import { pointText } from "../data"
import type { LayoutContext, LayoutNode } from "../interp"
import { sizeOf } from "./shared"

const EMU_PER_PT = 12700
const FIT_STEPS = 24

// The text algorithm (L.4.15.6.1.1 tx): the node's own text set inside its box less its margins. The
// font size starts at the primFontSz constraint (secFontSz for the children's text) and the
// primFontSz rule lowers it, bounded by the rule's value, until the text fits; a custom text size
// (custT) is the user's and is kept. Children, if any, share the box.
export function txLayout(node: LayoutNode, context: LayoutContext): void {
	for (const child of node.children) {
		const size = sizeOf(child, node)

		child.box = { x: node.box.x, y: node.box.y, w: size.w, h: size.h }
	}

	const start = node.values.get("primFontSz")
	const text = node.text.map(pointText).join("\n")

	node.overflow = false

	if (start === undefined || text.trim() === "") return

	node.fontPt = start

	if (node.text.some(point => point.props.custT === true)) return

	let floor = start

	for (const rule of node.rules) {
		if (rule.type === "primFontSz" && rule.forName === "" && Number.isFinite(rule.val)) floor = Math.min(floor, rule.val)
	}

	const margin = (name: string): number => node.values.get(name) ?? 0
	const width = Math.max(0, node.box.w - margin("lMarg") - margin("rMarg"))
	const height = Math.max(0, node.box.h - margin("tMarg") - margin("bMarg"))
	const fits = (pt: number): boolean => {
		const measured = context.measurer.measure(text, pt, width)

		return measured.height <= height + EMU_PER_PT * 0.01 && measured.width <= width + EMU_PER_PT * 0.01
	}

	if (fits(start)) return

	if (floor >= start) {
		node.overflow = true

		return
	}

	let low = floor
	let high = start

	// Office steps font sizes in half points; a bounded bisection lands on the largest that fits.
	for (let step = 0; step < Math.min(FIT_STEPS, context.budgets.maxRuleSteps) && high - low > 0.5; step++) {
		const mid = Math.round(low + high) / 2

		if (fits(mid)) low = mid
		else high = mid
	}

	node.fontPt = Math.floor(low * 2) / 2
	node.overflow = !fits(node.fontPt)
}
