import { D, drawingReader, type DrawingReader } from "../drawingml/reader"
import { escapeAttribute, escapeText } from "../xml/entities"
import { NodeKind, type XmlDocument } from "../xml/index"

// How a diagram's shapes are styled (ECMA-376 §21.4.4 colour definitions, §21.4.5 style definitions): each shape's
// style label (the layout node's styleLbl, else its presentation point's presStyleLbl) picks one styleLbl of each.
// The colour definition gives the shape's fill, line, effect and text colours as lists, of which the shape takes the
// one for its place among the shapes of its label (§21.4.7.16 ST_ClrAppMethod: span, cycle, repeat; pickColor);
// the style definition gives its theme references (lnRef, fillRef, effectRef, fontRef), 3-D scene and text
// properties. This is what PowerPoint's caches hold per shape: explicit fill and line colours in spPr, the
// references in dsp:style with the text colour on fontRef. The text colour of a cached drawing is read the same
// way (render/smartartText.ts) so cached and relaid diagrams agree.

// A colour of a colour list, or a style reference, as DrawingML markup (prefix a:).
export type Markup = string

export interface ShapeStyle {
	// a:solidFill (a:noFill for a list written empty) for spPr, from fillClrLst; undefined when the definition
	// has no list for the label.
	readonly fill: Markup | undefined
	// The line's paint inside a:ln, from linClrLst, likewise.
	readonly line: Markup | undefined
	// The text colour (a colour element), from txFillClrLst.
	readonly text: Markup | undefined
	// a:lnRef, a:fillRef, a:effectRef, a:fontRef with their idx; the fontRef carries the text colour.
	readonly lnRef: string
	readonly fillRef: string
	readonly effectRef: string
	readonly fontRef: "major" | "minor" | "none"
	// The style label's 3-D scene and shape (a:scene3d, a:sp3d), copied.
	readonly scene3d: Markup | undefined
	readonly sp3d: Markup | undefined
}

// The references Office uses where a definition gives none (the default style definition's node label).
const DEFAULT_REFS = { lnRef: "2", fillRef: "1", effectRef: "0", fontRef: "minor" as const }

// Which of `count` listed colours the `index`th of `total` styled shapes takes (§21.4.7.16 ST_ClrAppMethod): "repeat"
// runs through the list and starts over, "cycle" runs there and back, "span" (the default) spreads the list over the
// shapes; its interpolation between listed colours is drawn as the nearest one.
export function pickColor(method: string | undefined, index: number, total: number, count: number): number {
	const at = Math.max(0, Math.floor(index))

	if (count <= 1) return 0
	if (method === "repeat") return at % count

	if (method === "cycle") {
		const turn = at % (2 * (count - 1))

		return turn < count ? turn : 2 * (count - 1) - turn
	}

	return total <= 1 ? 0 : Math.min(count - 1, Math.round((Math.min(at, total - 1) / (total - 1)) * (count - 1)))
}

const MAX_MARKUP_DEPTH = 32

// A DrawingML subtree written again with the a: prefix (definitions may bind the namespace to any prefix); foreign
// elements and extension lists are left out, and so are prefixed attributes; with `relationships`, the
// relationship references (r:embed, r:link, r:id) are kept with the r: prefix, for markup that binds it.
export function drawingMarkup(reader: DrawingReader, node: number, depth = 0, relationships = false): Markup {
	const document = reader.document
	const name = document.localName(node)

	if (depth > MAX_MARKUP_DEPTH || reader.group(node) !== D.A || name === "extLst") return ""

	let out = `<a:${name}`

	for (const attribute of document.attributes(node)) {
		if (attribute.name === "xmlns") continue

		const colon = attribute.name.indexOf(":")

		if (colon < 0) {
			out += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`
		} else if (relationships) {
			const local = attribute.name.slice(colon + 1)

			if (reader.attrNs(node, D.R, local) === attribute.value) out += ` r:${local}="${escapeAttribute(attribute.value)}"`
		}
	}

	let inner = ""

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		if (document.kind(child) === NodeKind.Element) inner += drawingMarkup(reader, child, depth + 1, relationships)
		else if (name === "t") inner += escapeText(document.text(child))
	}

	return inner === "" ? `${out}/>` : `${out}>${inner}</a:${name}>`
}

const COLOR_ELEMENTS: ReadonlySet<string> = new Set(["scrgbClr", "srgbClr", "hslClr", "sysClr", "schemeClr", "prstClr"])

function colors(reader: DrawingReader, list: number): number[] {
	const out: number[] = []

	if (list < 0) return out

	for (let child = reader.document.firstChildElement(list); child >= 0; child = reader.document.nextSiblingElement(child)) {
		if (reader.group(child) === D.A && COLOR_ELEMENTS.has(reader.document.localName(child))) out.push(child)
	}

	return out
}

interface LabelSet {
	readonly reader: DrawingReader
	readonly byName: Map<string, number>
}

function labels(document: XmlDocument | undefined, root: string): LabelSet | undefined {
	if (document === undefined) return undefined

	const reader = drawingReader(document)
	const element = document.documentElement()

	if (!reader.is(element, D.Dgm, root)) return undefined

	const byName = new Map<string, number>()

	for (const label of reader.children(element, D.Dgm, "styleLbl")) {
		const name = reader.attr(label, "name")

		if (name !== undefined && !byName.has(name)) byName.set(name, label)
	}

	return { reader, byName }
}

// The style and colour definitions of one diagram, read once and asked per shape.
export class DiagramStyles {
	private readonly colorsDef: LabelSet | undefined
	private readonly styleDef: LabelSet | undefined
	private readonly cache = new Map<string, ShapeStyle>()

	constructor(styleDef: XmlDocument | undefined, colorsDef: XmlDocument | undefined) {
		this.styleDef = labels(styleDef, "styleDef")
		this.colorsDef = labels(colorsDef, "colorsDef")
	}

	// A colour of the label's list; null when the list is written empty (nothing of that kind is drawn).
	private pick(label: number, list: string, index: number, total: number): Markup | null | undefined {
		const set = this.colorsDef

		if (set === undefined) return undefined

		const node = set.reader.child(label, D.Dgm, list)
		const entries = colors(set.reader, node)

		if (entries.length === 0) return node < 0 ? undefined : null

		return drawingMarkup(set.reader, entries[pickColor(set.reader.attr(node, "meth"), index, total, entries.length)] as number)
	}

	// The style of the `index`th of `total` shapes labelled `label` (undefined: the definitions' defaults).
	shape(label: string | undefined, index: number, total: number): ShapeStyle {
		const key = `${label ?? ""}\u0000${index}\u0000${total}`
		const known = this.cache.get(key)

		if (known !== undefined) return known

		const colorsLabel = label === undefined ? undefined : this.colorsDef?.byName.get(label)
		const fill = colorsLabel === undefined ? undefined : this.pick(colorsLabel, "fillClrLst", index, total)
		const line = colorsLabel === undefined ? undefined : this.pick(colorsLabel, "linClrLst", index, total)
		const text = colorsLabel === undefined ? undefined : this.pick(colorsLabel, "txFillClrLst", index, total)
		const set = this.styleDef
		const styleLabel = label === undefined ? undefined : set?.byName.get(label)
		const style = styleLabel === undefined || set === undefined ? -1 : set.reader.child(styleLabel, D.Dgm, "style")
		const ref = (name: string, fallback: string): string => {
			const node = style < 0 || set === undefined ? -1 : set.reader.child(style, D.A, name)

			return (node < 0 || set === undefined ? undefined : set.reader.attr(node, "idx")) ?? fallback
		}
		const font = ref("fontRef", DEFAULT_REFS.fontRef)
		const copy = (name: string): Markup | undefined => {
			const node = styleLabel === undefined || set === undefined ? -1 : set.reader.child(styleLabel, D.Dgm, name)

			if (node < 0 || set === undefined) return undefined

			// dgm:scene3d / dgm:sp3d hold the DrawingML a:scene3d / a:sp3d content.
			let inner = ""

			for (let child = set.reader.document.firstChildElement(node); child >= 0; child = set.reader.document.nextSiblingElement(child))
				inner += drawingMarkup(set.reader, child)

			return inner === "" ? undefined : `<a:${name}>${inner}</a:${name}>`
		}
		// Without a text colour from the colour definition, the style definition's fontRef colour (§21.4.4.13: the
		// colour definition overrides the style's references; an empty list leaves the style's).
		const fontNode = style < 0 || set === undefined ? -1 : set.reader.child(style, D.A, "fontRef")
		const fontColor = fontNode < 0 || set === undefined ? [] : colors(set.reader, fontNode)
		const styleText = fontColor.length === 0 || set === undefined ? undefined : drawingMarkup(set.reader, fontColor[0] as number)
		const out: ShapeStyle = {
			fill: fill === undefined ? undefined : fill === null ? "<a:noFill/>" : `<a:solidFill>${fill}</a:solidFill>`,
			line: line === undefined ? undefined : line === null ? "<a:noFill/>" : `<a:solidFill>${line}</a:solidFill>`,
			text: text ?? styleText,
			lnRef: ref("lnRef", DEFAULT_REFS.lnRef),
			fillRef: ref("fillRef", DEFAULT_REFS.fillRef),
			effectRef: ref("effectRef", DEFAULT_REFS.effectRef),
			fontRef: font === "major" || font === "none" ? font : "minor",
			scene3d: copy("scene3d"),
			sp3d: copy("sp3d")
		}

		this.cache.set(key, out)

		return out
	}
}
