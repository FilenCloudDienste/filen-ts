// Ported from pdf.js web/struct_tree_layer_builder.js (StructTreeLayerBuilder).
// Copyright 2021 Mozilla Foundation. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0); modified: ids carry a per-document prefix and are resolved inside the
// page's text layer, annotation nodes are dropped, MathML goes through a sanitizer the host supplies, and a tree past
// a node cap is not built.

// A tagged PDF page's structure tree (pdf.js getStructTree) as an accessible DOM tree for screen readers: headings,
// lists, tables, figures with their alternate text, the page's text owned (aria-owns) from the text layer's marked
// content spans. It lives inside the page's canvas (fallback content: read, never drawn).

// The most nodes one page's tree may have: past that the page keeps its plain text layer.
export const STRUCT_TREE_MAX_NODES = 5000

const PDF_ROLE_TO_HTML_ROLE: Readonly<Record<string, string | null>> = {
	Document: null,
	DocumentFragment: null,
	Part: "group",
	Art: "article",
	Sect: "group",
	Div: "group",
	BlockQuote: "blockquote",
	Aside: "note",
	NonStruct: "none",
	P: "paragraph",
	H: "heading",
	Title: null,
	FENote: "note",
	Sub: "group",
	Lbl: null,
	Span: null,
	Em: "emphasis",
	Strong: "strong",
	Note: "note",
	Code: "code",
	Link: "link",
	Annot: "note",
	Form: "form",
	Ruby: null,
	RB: null,
	RT: null,
	RP: null,
	Warichu: null,
	WT: null,
	WP: null,
	L: "list",
	LI: "listitem",
	LBody: null,
	Table: "table",
	TR: "row",
	TH: "columnheader",
	TD: "cell",
	THead: "rowgroup",
	TBody: "rowgroup",
	TFoot: "rowgroup",
	Caption: "caption",
	Figure: "figure",
	Formula: null,
	Artifact: null
}

const ROLES_WITH_PROHIBITED_NAMES = new Set(["caption", "code", "emphasis", "generic", "none", "paragraph", "strong"])
const MATHML_ELEMENTS = new Set([
	"math",
	"merror",
	"mfrac",
	"mi",
	"mmultiscripts",
	"mn",
	"mo",
	"mover",
	"mpadded",
	"mprescripts",
	"mroot",
	"mrow",
	"ms",
	"mspace",
	"msqrt",
	"mstyle",
	"msub",
	"msubsup",
	"msup",
	"mtable",
	"mtd",
	"mtext",
	"mtr",
	"munder",
	"munderover",
	"semantics"
])
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML"
const HEADING = /^H(\d+)$/

// pdf.js's tree node, as far as it is read here: a structure element (`role`) or a leaf (`type` content, object or
// annotation, with the marked content's or object's id).
interface StructNode {
	readonly role?: string
	readonly type?: string
	readonly id?: string
	readonly children?: readonly StructNode[]
	readonly alt?: string | undefined
	readonly lang?: string
	readonly bbox?: readonly number[]
	readonly mathML?: string
	readonly structId?: string
	readonly headers?: readonly string[]
	readonly scope?: string
	readonly short?: string
	readonly summary?: string
	readonly rowSpan?: number
	readonly colSpan?: number
}

// The page's unscaled extent (pdf.js viewport.rawDims).
export interface StructTreeDims {
	readonly pageHeight: number
	readonly pageX: number
	readonly pageY: number
}

export interface StructTreeOptions {
	readonly rawDims: StructTreeDims | null
	// Unique per document in the DOM: every id the tree and the text layer use starts with it.
	readonly idPrefix: string
	// A formula's MathML, sanitized to MathML elements only (a dedicated sanitizer, never a general HTML one); without
	// it a formula reads as the text it covers.
	readonly sanitizeMathML?: (markup: string) => Node | null
	readonly maxNodes?: number
}

export interface StructTree {
	readonly root: HTMLElement
	// After the text layer rendered: prefixes its marked content ids and adds figures' labels, hides what a formula's
	// MathML replaces and moves a MathML element's text into it.
	applyToTextLayer(container: HTMLElement): void
}

// pdf.js removeNullCharacters.
function clean(text: string): string {
	return text.replaceAll("\0", "")
}

function isNode(value: unknown): value is StructNode {
	return typeof value === "object" && value !== null
}

function countNodes(node: StructNode, limit: number): number {
	let count = 1

	for (const child of node.children ?? []) {
		count += countNodes(child, limit - count)

		if (count > limit) return count
	}

	return count
}

class Builder {
	private readonly doc: Document
	private readonly options: StructTreeOptions
	private readonly structElements = new Map<string, StructNode>()
	private readonly structIds = new Map<string, string>()
	private readonly add = new Map<string, HTMLElement>()
	private readonly hide: string[] = []
	private readonly steal: (readonly [Element, readonly string[]])[] = []

	constructor(doc: Document, options: StructTreeOptions) {
		this.doc = doc
		this.options = options
	}

	private contentId(id: string): string {
		return `${this.options.idPrefix}${id}`
	}

	private structId(structId: string): string {
		let id = this.structIds.get(structId)

		if (id === undefined) {
			id = `${this.options.idPrefix}s${String(this.structIds.size)}`
			this.structIds.set(structId, id)
		}

		return id
	}

	collect(node: StructNode): void {
		if (node.structId !== undefined && !this.structElements.has(node.structId)) this.structElements.set(node.structId, node)

		for (const child of node.children ?? []) this.collect(child)
	}

	private headerIds(headers: readonly string[]): string[] {
		const result: string[] = []
		const visited = new Set<string>()
		const pending = headers.toReversed()

		while (pending.length > 0) {
			const structId = pending.pop()

			if (structId === undefined || visited.has(structId)) continue

			visited.add(structId)

			const header = this.structElements.get(structId)

			if (header?.role !== "TH") continue

			result.push(this.structId(structId))

			for (const next of (header.headers ?? []).toReversed()) pending.push(next)
		}

		return result
	}

	private setAttributes(node: StructNode, element: Element): void {
		const { alt, colSpan, headers, id, lang, rowSpan, short, structId, summary } = node

		if (alt !== undefined) {
			const role = element.getAttribute("role") ?? (element.localName === "span" ? "generic" : null)

			if (role !== "none")
				element.setAttribute(role !== null && ROLES_WITH_PROHIBITED_NAMES.has(role) ? "aria-description" : "aria-label", clean(alt))
		}

		if (id !== undefined) element.setAttribute("aria-owns", this.contentId(id))

		if (structId !== undefined && this.structElements.get(structId) === node) {
			const elementId = this.structId(structId)

			if (short !== undefined) {
				const abbreviation = this.doc.createElement("span")

				abbreviation.id = elementId
				abbreviation.setAttribute("aria-hidden", "true")
				abbreviation.textContent = clean(short)
				element.append(abbreviation)
			} else element.id = elementId
		}

		if (lang !== undefined) element.setAttribute("lang", clean(lang).trim())
		if (rowSpan !== undefined) element.setAttribute("aria-rowspan", String(rowSpan))
		if (colSpan !== undefined) element.setAttribute("aria-colspan", String(colSpan))

		if (headers !== undefined && headers.length > 0) {
			const ids = this.headerIds(headers)

			if (ids.length > 0) element.setAttribute("aria-describedby", ids.join(" "))
		}

		if (summary !== undefined) element.setAttribute("aria-description", clean(summary))
	}

	private addImage(node: StructNode, element: Element): boolean {
		const { alt, bbox, children } = node
		const child = children?.[0]
		const dims = this.options.rawDims

		if (dims === null || alt === undefined || alt.length === 0 || bbox === undefined || child?.type !== "content" || !child.id)
			return false

		const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = bbox
		const id = this.contentId(child.id)
		const image = this.doc.createElement("span")
		const calc = "calc(var(--total-scale-factor) * "

		element.setAttribute("aria-owns", id)
		image.setAttribute("role", "img")
		image.setAttribute("aria-label", clean(alt))
		image.style.width = `${calc}${String(x1 - x0)}px)`
		image.style.height = `${calc}${String(y1 - y0)}px)`
		image.style.left = `${calc}${String(x0 - dims.pageX)}px)`
		image.style.top = `${calc}${String(dims.pageHeight - y1 + dims.pageY)}px)`
		this.add.set(id, image)

		return true
	}

	private collectIds(node: StructNode, ids: string[]): void {
		if (node.id !== undefined) ids.push(this.contentId(node.id))

		for (const child of node.children ?? []) this.collectIds(child, ids)
	}

	walk(node: StructNode, parents: StructNode[]): Element | null {
		// The app's link layer draws no annotation elements: nothing to own.
		if (node.type === "annotation") return null

		let element: Element | null = null
		let visitChildren = true
		const { role } = node

		if (role !== undefined) {
			if (MATHML_ELEMENTS.has(role)) {
				element = this.doc.createElementNS(MATHML_NAMESPACE, role)

				const ids: string[] = []

				for (const child of node.children ?? []) if (child.type === "content" && child.id) ids.push(this.contentId(child.id))

				this.steal.push([element, ids])
			} else element = this.doc.createElement("span")

			const heading = HEADING.exec(role)

			if (heading !== null) {
				element.setAttribute("role", "heading")
				element.setAttribute("aria-level", heading[1] ?? "1")
			} else {
				let htmlRole = Object.hasOwn(PDF_ROLE_TO_HTML_ROLE, role) ? (PDF_ROLE_TO_HTML_ROLE[role] ?? null) : null

				if (role === "TH") {
					if (node.scope === "Row") htmlRole = "rowheader"
					else if (node.scope === "Column") htmlRole = "columnheader"
					else if (parents.at(-1)?.role === "TR" && parents.at(-2)?.role === "TBody") htmlRole = "rowheader"
				} else if (role === "Caption") {
					const parent = parents.at(-1)?.role

					if (parent !== "Table" && parent !== "Figure") htmlRole = null
				}

				if (htmlRole !== null) element.setAttribute("role", htmlRole)
			}

			if (role === "Figure" && this.addImage(node, element)) return element

			if (role === "Formula") {
				const sanitize = this.options.sanitizeMathML
				const math = node.mathML === undefined || sanitize === undefined ? null : sanitize(node.mathML)

				if (math !== null) {
					visitChildren = false
					element.append(math)
					this.collectIds(node, this.hide)
				} else if (node.children?.length === 1 && node.children[0]?.role !== "math") {
					element = this.doc.createElementNS(MATHML_NAMESPACE, "math")
				}

				node = { ...node, alt: undefined }
			}
		}

		element ??= this.doc.createElement("span")
		this.setAttributes(node, element)

		const children = (node.children ?? []).filter(child => child.type !== "annotation")
		const only = children.length === 1 ? children[0] : undefined

		if (only !== undefined && only.role === undefined && only.id !== undefined && element.getAttribute("role") !== "none")
			this.setAttributes(only, element)
		else if (visitChildren) {
			parents.push(node)

			for (const child of children) {
				const built = this.walk(child, parents)

				if (built !== null) element.append(built)
			}

			parents.pop()
		}

		return element
	}

	apply(container: HTMLElement): void {
		const byId = new Map<string, Element>()

		for (const span of container.querySelectorAll(".markedContent[id]")) {
			span.id = this.contentId(span.id)
			byId.set(span.id, span)
		}

		for (const [id, image] of this.add) byId.get(id)?.append(image)

		for (const id of this.hide) byId.get(id)?.setAttribute("aria-hidden", "true")

		for (const [element, ids] of this.steal) {
			let text = ""

			for (const id of ids) {
				const span = byId.get(id)

				if (span === undefined) continue

				text += span.textContent.trim()
				span.setAttribute("aria-hidden", "true")
			}

			if (text.length > 0) element.textContent = text
		}
	}
}

// The accessible tree of a page's structure tree; null for none, or one past the node cap.
export function buildStructTree(doc: Document, tree: unknown, options: StructTreeOptions): StructTree | null {
	if (!isNode(tree)) return null

	const max = options.maxNodes ?? STRUCT_TREE_MAX_NODES

	if (countNodes(tree, max) > max) return null

	const builder = new Builder(doc, options)

	builder.collect(tree)

	const built = builder.walk(tree, [])

	if (built === null) return null

	const root = doc.createElement("span")

	root.className = "structTree"
	root.append(built)

	return { root, applyToTextLayer: container => builder.apply(container) }
}
