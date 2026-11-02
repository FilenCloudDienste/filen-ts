import { evaluateGuides, presetProgram, textRect } from "../../drawingml/index"
import { EMU_PER_PX } from "../../drawingml/reader"
import { adjustGuideValue } from "../adjust"
import { matchesType } from "../constraints"
import { pointText } from "../data"
import type { LayoutContext, LayoutNode } from "../interp"
import { measureText } from "../measure"
import { sizeOf } from "./shared"

const EMU_PER_PT = 12700
const FIT_STEPS = 24

// The text algorithm (L.4.15.6.1.1 tx): the node's own text set inside its box less its margins. The
// font size starts at the primFontSz constraint (secFontSz for the children's text) and the
// primFontSz rule lowers it, bounded by the rule's value, until the text fits; with a custom text size (custT)
// the runs keep their own sizes and the node sets none. Children, if any, share the box.
export function txLayout(node: LayoutNode, context: LayoutContext): void {
	for (const child of node.children) {
		const size = sizeOf(child, node)

		child.box = { x: node.box.x, y: node.box.y, w: size.w, h: size.h }
	}

	const start = startSize(node)
	const text = node.text.map(pointText).join("\n")

	node.overflow = false

	if (start === undefined || text.trim() === "") return

	// A custom text size (custT) is the user's: the text keeps the sizes its runs carry, and margins set from the font
	// size follow the first run's (the Pie deck's 0.1 × primFontSz insets are 12700 EMU at its 10 pt runs).
	if (node.text.some(point => point.props.custT === true)) {
		node.fontPt = undefined

		const custom = customSize(node)

		if (custom !== undefined) {
			for (const name of fontRelativeMargins(node)) {
				const value = node.values.get(name)

				if (value !== undefined) node.values.set(name, (value * custom) / start)
			}
		}

		return
	}

	node.fontPt = start

	let floor = start

	for (const rule of node.rules) {
		if (rule.type === "primFontSz" && rule.forName === "" && Number.isFinite(rule.val)) floor = Math.min(floor, rule.val)
	}

	// A side no constraint gives a margin takes 0.56 of the font size, as every PowerPoint drawing of a layout that
	// leaves margins out carries (hList1's parent text, bProcess3, pList2 and the venns in the corpus caches).
	const defaulted = new Set<string>()

	for (const name of MARGINS) {
		if (node.values.has(name)) continue

		node.values.set(name, DEFAULT_MARGIN * start * EMU_PER_PT)
		defaulted.add(name)
	}

	DEFAULTED.set(node, defaulted)

	// Margins set from the font size follow the size the text settles on (PowerPoint's cached insets are the
	// factor times the final size).
	const relative = fontRelativeMargins(node)
	const margin = (name: string, pt: number): number => {
		const value = node.values.get(name) ?? 0

		return relative.has(name) ? (value * pt) / start : value
	}
	const inset = geometryInset(node)
	const measurer = context.measurer
	const rich =
		measurer.measureText === undefined ? undefined : measureText(node.text, node.vars.get("bulletEnabled") === "1", node.textBase)
	const secondary = node.values.get("secFontSz")
	const longest = longestWords(text)
	const fits = (pt: number): boolean => {
		const width = Math.max(0, inset.w - margin("lMarg", pt) - margin("rMarg", pt))
		const height = Math.max(0, inset.h - margin("tMarg", pt) - margin("bMarg", pt))
		// The children's text is set at the secondary size where one is given, never above the node's own.
		const childPt = secondary !== undefined && Number.isFinite(secondary) && secondary > 0 ? Math.min(secondary, pt) : pt
		const measured =
			rich === undefined || measurer.measureText === undefined
				? measurer.measure(text, pt, width)
				: measurer.measureText(rich, pt, childPt, width)

		if (!(measured.height <= height + EMU_PER_PT * 0.01 && measured.width <= width + EMU_PER_PT * 0.01)) return false

		// A word is never broken to fit: the size comes down until the longest words fit a line (bList2's "Child" in
		// its narrow box).
		for (const word of longest) if (measurer.measure(word, pt, ONE_LINE).width > width + EMU_PER_PT * 0.01) return false

		return true
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

	const final = node.fontPt

	for (const name of relative) {
		const value = node.values.get(name)

		if (value !== undefined) node.values.set(name, (value * final) / start)
	}
}

// The height `node`'s text takes set at its starting size in `width` EMU (its margins included); undefined without
// text. A text node whose own rule lets its height grow without bound (h INF) is as high as this in a line
// (list1's child text under its parent bar).
export function textHeight(node: LayoutNode, width: number, context: LayoutContext): number | undefined {
	const start = startSize(node)
	const text = node.text.map(pointText).join("\n")

	if (start === undefined || text.trim() === "" || node.text.some(point => point.props.custT === true)) return undefined

	const margin = (name: string): number => node.values.get(name) ?? DEFAULT_MARGIN * start * EMU_PER_PT
	const measurer = context.measurer
	const secondary = node.values.get("secFontSz")
	const childPt = secondary !== undefined && Number.isFinite(secondary) && secondary > 0 ? Math.min(secondary, start) : start
	const inner = Math.max(0, width - margin("lMarg") - margin("rMarg"))
	const measured =
		measurer.measureText === undefined
			? measurer.measure(text, start, inner)
			: measurer.measureText(measureText(node.text, node.vars.get("bulletEnabled") === "1", node.textBase), start, childPt, inner)

	return measured.height + margin("tMarg") + margin("bMarg")
}

// A width no word reaches: a word measured on one line.
const ONE_LINE = 1e10

// The few longest words of a text, by characters (the widest of them is among them for any sane face).
function longestWords(text: string): string[] {
	const words = [...new Set(text.split(/\s+/u).filter(word => word !== ""))]

	words.sort((a, b) => b.length - a.length)

	return words.slice(0, 3)
}

const MARGINS = ["lMarg", "rMarg", "tMarg", "bMarg"]
const DEFAULT_MARGIN = 0.56
// The margins a node took by default at its last fit (they follow its size like font-relative ones).
const DEFAULTED = new WeakMap<LayoutNode, ReadonlySet<string>>()

// Sets a fitted node's font size to `pt` (a size shared with other nodes), with the margins its constraints derive
// from the size.
export function settleFontSize(node: LayoutNode, pt: number): void {
	const was = node.fontPt

	if (was === undefined || was === pt || !(was > 0)) return

	for (const name of fontRelativeMargins(node)) {
		const value = node.values.get(name)

		if (value !== undefined) node.values.set(name, (value * pt) / was)
	}

	node.fontPt = pt
}

// The extent of the text rectangle of the node's preset geometry (ECMA-376 §20.1.9.22 rect, with the layout's
// adjustments) in its box: text fits inside it, less the margins, as PowerPoint's cached dsp:txXfrm shows (a rounded
// rectangle's text sits 0.29 of its corner radius in from each side). A quarter turn swaps the sides it is
// evaluated on.
function geometryInset(node: LayoutNode): { readonly w: number; readonly h: number } {
	const box = node.box
	const shape = node.shape
	const program = shape === undefined || shape.hideGeom ? undefined : presetProgram(shape.type)

	if (program === undefined || program.rect === null || !(box.w > 0 && box.h > 0)) return { w: box.w, h: box.h }

	const quarter = Math.abs(Math.round((shape?.rot ?? 0) / 90)) % 2 === 1
	const w = quarter ? box.h : box.w
	const h = quarter ? box.w : box.h
	const names = program.adjustNames
	const adjust = new Map<string, number>()

	for (const adj of shape?.adj ?? []) {
		const name = names[adj.idx - 1]

		if (name !== undefined && Number.isFinite(adj.val)) adjust.set(name, adjustGuideValue(shape?.type ?? "", name, adj.val))
	}

	const [l, t, r, b] = textRect(
		program,
		evaluateGuides(program, w, h, name => adjust.get(name)),
		w,
		h
	)
	const tw = Math.max(0, (r - l) * EMU_PER_PX)
	const th = Math.max(0, (b - t) * EMU_PER_PX)

	return quarter ? { w: th, h: tw } : { w: tw, h: th }
}

// The margins a node's own constraints derive from its font size.
function fontRelativeMargins(node: LayoutNode): Set<string> {
	const out = new Set<string>(DEFAULTED.get(node))

	for (const constraint of node.constraints) {
		if (
			constraint.for === "self" &&
			MARGINS.includes(constraint.type) &&
			(constraint.refType === "primFontSz" || constraint.refType === "secFontSz")
		)
			out.add(constraint.type)
	}

	return out
}

// The size in points of the first run that sets one, in the node's text.
function customSize(node: LayoutNode): number | undefined {
	for (const point of node.text)
		for (const paragraph of point.rich ?? [])
			for (const run of paragraph.runs) if (run.sz !== undefined && run.sz > 0) return run.sz / 100

	return undefined
}

// The size text starts from: the primFontSz constraint, unless an ancestor's grouping constraint (op equ, no value)
// left it 0, when the node's own literal size counts.
function startSize(node: LayoutNode): number | undefined {
	const set = node.values.get("primFontSz")

	if (set !== undefined && set > 0) return set

	for (const constraint of node.constraints) {
		if (constraint.for !== "self" || constraint.type !== "primFontSz" || constraint.forName !== "") continue
		if (constraint.refType === "none" && constraint.val > 0 && Number.isFinite(constraint.val)) return constraint.val
	}

	// A text node outside any iteration stands for the document point, yet presents nodes: an ancestor's size for
	// its node children or descendants reaches it through the points it presents (vProcess5's texts take the
	// root's 65 pt and fit down from there, as PowerPoint's caches show).
	const presented = node.text[0]

	if (presented === undefined || set !== undefined) return undefined

	for (let owner = node.parent, depth = 1; owner !== undefined; owner = owner.parent, depth++) {
		for (const constraint of owner.constraints) {
			if (
				constraint.type !== "primFontSz" ||
				constraint.refType !== "none" ||
				!(constraint.val > 0) ||
				!Number.isFinite(constraint.val)
			)
				continue
			if (constraint.for === "self" || (constraint.for === "ch" && depth > 1)) continue
			if (constraint.forName !== "" && constraint.forName !== node.name) continue
			if (!matchesType(presented, constraint.ptType)) continue

			return constraint.val
		}
	}

	return undefined
}
