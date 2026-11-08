import type { Node } from "prosemirror-model"
import { NodeSelection } from "prosemirror-state"
import { ommlToMathTree, type MathElement } from "../../math/index"
import { MAX_LATEX_LENGTH, latexToOmml, type LatexError } from "../../math/latex"
import { MAX_OMML_DEPTH, OMML_NAMESPACE } from "../../math/ommlWriter"
import { ommlToLatex, type OmmlLatex } from "../../math/toLatex"
import {
	changeSelector,
	deletedTree,
	diffTrees,
	insertedTree,
	firstRunProperties,
	normalizedTree,
	ommlStringTree,
	ommlTree,
	resolveTree,
	treeChanges,
	treeDeleted,
	treeXml,
	type OmmlChange,
	type OmmlStamp,
	withRunProperties,
	type XChild,
	type XElement
} from "../../math/ommlTrack"
import type { OmmlRevisionView } from "../../math/omml"
import { equationTracked } from "../layout/objects"
import { Item } from "../model/kinds"
import { partReader } from "../model/reader"
import { equationMarkupFault, equationNamespaces } from "../write/checks/math"
import { encodeUtf8, parseXml, type XmlDocument } from "../../xml/index"
import { NO_SOURCE, docxSchema } from "../edit/schema"
import type { DocxEditorSession } from "../edit/session"
import type { StoryPart } from "../model/index"

// Equations as an editor shows them for editing: the preview of typed LaTeX (read the way a saved equation is
// read back, so what the preview shows is what the page paints and the file holds) and an equation's LaTeX.

const nodes = docxSchema.nodes
const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

export interface DocxLatexPreview {
	// Null while there is nothing to show.
	readonly tree: MathElement | null
	readonly error: LatexError | null
}

interface ParsedOmml {
	readonly document: XmlDocument
	readonly node: number
}

// The OMML writeOmml made (m: prefixed, undeclared) as an element of its own document.
function parseOmml(omml: string): ParsedOmml | undefined {
	try {
		const document = parseXml(encodeUtf8(`<math xmlns:m="${OMML_NAMESPACE}" xmlns:w="${WORD_NAMESPACE}">${omml}</math>`))
		const node = document.firstChildElement(document.documentElement())

		return node < 0 ? undefined : { document, node }
	} catch {
		return undefined
	}
}

function treeOf(parsed: ParsedOmml | undefined): MathElement | null {
	if (parsed === undefined) return null

	try {
		return ommlToMathTree(parsed.document, parsed.node) ?? null
	} catch {
		return null
	}
}

// `latex` as it would paint once inserted (inline, or on its own line when `display`). Nothing to show and no
// error for empty input.
export function latexPreview(latex: string, display: boolean): DocxLatexPreview {
	const written = latexToOmml(latex, display)

	if (!written.ok) return { tree: null, error: written.error.code === "empty" ? null : written.error }

	return { tree: treeOf(parseOmml(written.omml)), error: null }
}

export interface DocxEquationLatex {
	readonly latex: string
	// Editing it as LaTeX loses what the equation has beyond the subset.
	readonly lossy: boolean
	readonly display: boolean
}

// Per math node (nodes are immutable): its LaTeX, computed once.
const latexes = new WeakMap<Node, DocxEquationLatex>()

// The OMML a math node stands for: its new XML, else its source element in `part`.
function sourceOf(node: Node, part: StoryPart): ParsedOmml | undefined {
	const omml = node.attrs["omml"] as string | null

	if (omml !== null) return parseOmml(omml)

	const src = node.attrs["src"] as number

	return src === NO_SOURCE ? undefined : { document: part.document, node: part.node(src) }
}

// Math node `node` of a document of `part`'s story as LaTeX.
export function mathNodeLatex(node: Node, part: StoryPart): DocxEquationLatex {
	const cached = latexes.get(node)

	if (cached !== undefined) return cached

	const source = sourceOf(node, part)
	let read: OmmlLatex = { latex: "", lossy: true }

	try {
		if (source !== undefined)
			read = ommlToLatex(
				source.document,
				source.node,
				source.document === part.document ? { namespaces: part.reader.namespaces } : {}
			)
	} catch {
		read = { latex: "", lossy: true }
	}

	// LaTeX longer than an edit may give is no LaTeX to edit it as (an edit makes the equation anew, lossy).
	if (read.latex.length > MAX_LATEX_LENGTH) read = { latex: "", lossy: true }

	const value: DocxEquationLatex = Object.freeze({ latex: read.latex, lossy: read.lossy, display: node.attrs["display"] === true })

	latexes.set(node, value)

	return value
}

const viewTrees = new WeakMap<Node, Map<string, MathElement | null>>()

// The MathML tree of math node `node` (new or from the source), as the pages paint it in revision view `view`
// (its tracked changes shown as there; without, as the final document has them); null when it has none.
export function equationTree(node: Node, part: StoryPart, view?: OmmlRevisionView): MathElement | null {
	const key = view === undefined ? "" : view.view
	let known = viewTrees.get(node)

	if (known === undefined) {
		known = new Map()
		viewTrees.set(node, known)
	}

	const cached = known.get(key)

	if (cached !== undefined) return cached

	const source = sourceOf(node, part)
	let tree: MathElement | null = null

	try {
		tree =
			source === undefined
				? null
				: (ommlToMathTree(source.document, source.node, {
						...(source.document === part.document ? { namespaces: part.reader.namespaces } : {}),
						...(view === undefined ? {} : { revisions: view })
					}) ?? null)
	} catch {
		tree = null
	}

	known.set(key, tree)

	return tree
}

// ---- what can be written ------------------------------------------------------------------------------------

// Why an equation's new XML could not be saved in `part` (gate 2's rule, checks/math.ts), undefined when it can:
// asked before a command gives an equation new XML, so the command is refused rather than the save.
export function equationFault(omml: string, part: StoryPart): string | undefined {
	const declared = equationNamespaces(part)

	try {
		const document = parseXml(encodeUtf8(`<math xmlns:m="${OMML_NAMESPACE}" xmlns:w="${WORD_NAMESPACE}">${omml}</math>`))

		return equationMarkupFault(document, partReader(document), OMML_NAMESPACE, declared, false)
	} catch {
		return "is not well-formed"
	}
}

// ---- tracked changes -----------------------------------------------------------------------------------------

const roots = new WeakMap<Node, XElement | null>()

// Whether element `node` of `part` nests deeper than MAX_OMML_DEPTH elements (read iteratively).
function tooDeep(part: StoryPart, node: number): boolean {
	const document = part.document
	const stack: [number, number][] = [[node, 0]]

	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		const [at, depth] = next

		if (depth > MAX_OMML_DEPTH) return true

		for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child))
			stack.push([child, depth + 1])
	}

	return false
}

// The equation of math node `node` as a tree (ommlTrack.ts); a source equation needs its story's part.
function equationRoot(node: Node, part: StoryPart | undefined): XElement | null {
	const cached = roots.get(node)

	if (cached !== undefined) return cached

	const omml = node.attrs["omml"] as string | null
	const src = node.attrs["src"] as number
	let root: XElement | null = null

	try {
		if (omml !== null) root = ommlStringTree(omml) ?? null
		// One nested deeper than equations are read and written cannot be changed here.
		else if (part !== undefined && src !== NO_SOURCE && !tooDeep(part, part.node(src)))
			root = ommlTree(part.document, part.node(src), part.reader.namespaces)
	} catch {
		root = null
	}

	if (omml !== null || part !== undefined) roots.set(node, root)

	return root
}

const changes = new WeakMap<Node, readonly OmmlChange[]>()
const NO_CHANGES: readonly OmmlChange[] = Object.freeze([])

// The tracked changes inside an equation (its revisions by kind, author and date). A source equation's are read
// with its story's part only; without, a source equation reads as having none.
export function equationChanges(node: Node, part: StoryPart | undefined): readonly OmmlChange[] {
	const cached = changes.get(node)

	if (cached !== undefined) return cached

	const omml = node.attrs["omml"] as string | null

	// Most equations hold none: their XML says so without a tree.
	const src = node.attrs["src"] as number

	if (
		omml !== null
			? !/<w:(ins|del|moveFrom|moveTo)\b/.test(omml)
			: part === undefined || src === NO_SOURCE || !equationTracked(part, src)
	) {
		if (omml !== null || part !== undefined) changes.set(node, NO_CHANGES)

		return NO_CHANGES
	}

	const root = equationRoot(node, part)
	const found = root === null ? NO_CHANGES : Object.freeze(treeChanges(root))

	changes.set(node, found)

	return found
}

// The change `id` inside an equation (its kind, author and date), for what a balloon shows of it.
export function equationChangeOf(node: Node, part: StoryPart | undefined, id: string): OmmlChange | undefined {
	return equationChanges(node, part).find(change => change.id === id)
}

// Whether a source part holds an equation with tracked changes (read once per part).
const trackedParts = new WeakMap<StoryPart, boolean>()

export function partHasTrackedEquations(part: StoryPart): boolean {
	let found = trackedParts.get(part)

	if (found === undefined) {
		found = false

		for (let item = 0; item < part.kinds.length && !found; item++) {
			const kind = part.kinds[item]

			if ((kind === Item.Math || kind === Item.MathParagraph) && equationTracked(part, item)) found = true
		}

		trackedParts.set(part, found)
	}

	return found
}

// Whether story `item` of `part` (a header, a note...) holds an equation with tracked changes.
export function storyHasTrackedEquations(part: StoryPart, item: number): boolean {
	if (!partHasTrackedEquations(part)) return false

	const end = part.end(item)

	for (let at = item + 1; at < end; at++) {
		const kind = part.kinds[at]

		if ((kind === Item.Math || kind === Item.MathParagraph) && equationTracked(part, at)) return true
	}

	return false
}

// What resolvedEquation gives for an equation of the file that is again what the file has (it is written as its
// bytes again).
export const SOURCE = "\u0000source"

const sourceXml = new WeakMap<StoryPart, Map<number, string | null>>()

// The source equation `src` of `part` as the editor writes its XML (runs as one where they read as one).
function sourceEquationXml(part: StoryPart, src: number): string | null {
	let known = sourceXml.get(part)

	if (known === undefined) {
		known = new Map()
		sourceXml.set(part, known)
	}

	let xml = known.get(src)

	if (xml === undefined) {
		try {
			xml = treeXml(normalizedTree(ommlTree(part.document, part.node(src), part.reader.namespaces)))
		} catch {
			xml = null
		}

		known.set(src, xml)
	}

	return xml
}

// The equation with the change `id` (every change without one) accepted or rejected: its new XML, SOURCE when it
// is the file's own again, null when nothing of it is left (the node goes), undefined when it holds no such change.
export function resolvedEquation(
	node: Node,
	part: StoryPart | undefined,
	id: string | undefined,
	accept: boolean
): string | null | undefined {
	if (equationChanges(node, part).length === 0) return undefined

	const root = equationRoot(node, part)
	const select = root === null ? undefined : changeSelector(root, id)

	if (root === null || select === undefined) return undefined

	const resolved = resolveTree(root, select, accept)

	if (resolved === null) return null

	const xml = treeXml(resolved)
	const src = node.attrs["src"] as number

	return part !== undefined && src !== NO_SOURCE && sourceEquationXml(part, src) === xml ? SOURCE : xml
}

// Run properties of an equation's runs and object characters: the formatting where it goes in (the caret's run
// properties: `base` is that run base) in Word's math font, as Word writes a new equation (w:rFonts Cambria Math).
export function equationRunProperties(base: { readonly document: XmlDocument; readonly node: number } | undefined): XElement {
	const fonts: XElement = {
		name: "w:rFonts",
		attrs: [
			["w:ascii", "Cambria Math"],
			["w:hAnsi", "Cambria Math"]
		],
		children: []
	}
	let children: XElement[] = []
	// The declarations of the namespaces the properties use besides math and WordprocessingML (w14:glow...),
	// which the tree puts on its root: kept on the new w:rPr, or those children lose their namespace.
	let declarations: (readonly [string, string])[] = []

	if (base !== undefined && base.node >= 0) {
		try {
			const tree = ommlTree(base.document, base.node)

			children = tree.children.filter(
				(child): child is XElement => typeof child === "object" && !DROPPED_RUN_PROPERTIES.has(child.name)
			)
			declarations = tree.attrs.filter(([name]) => name.startsWith("xmlns:"))
		} catch {
			children = []
		}
	}

	// w:rFonts after w:rStyle, before the rest (CT_RPr's order).
	const styled = children[0]?.name === "w:rStyle" ? 1 : 0

	return { name: "w:rPr", attrs: declarations, children: [...children.slice(0, styled), fonts, ...children.slice(styled)] }
}

// The character styles the runs of an equation's XML (as the editor keeps it, w: prefixed) name, added to `out`:
// a style a command added stays defined while only an equation names it.
export function equationRunStyles(omml: string, out: Set<unknown>): void {
	for (const match of omml.matchAll(RUN_STYLE)) out.add(match[1])
}

// An equation's XML (as the editor keeps it) without the character styles `dropped` says on its runs; undefined
// when it has none of them. The formatting before a tracked change (w:rPrChange) stays.
export function withoutRunStyles(omml: string, dropped: (id: string) => boolean): string | undefined {
	if (!omml.includes("w:rStyle")) return undefined

	const root = ommlStringTree(omml)

	if (root === undefined) return undefined

	const out = treeXml(withoutStyles(root, dropped))

	return out === omml ? undefined : out
}

function withoutStyles(node: XElement, dropped: (id: string) => boolean): XElement {
	if (node.name === "w:rPrChange") return node

	const children: XChild[] = []

	for (const child of node.children) {
		if (typeof child === "string") {
			children.push(child)
		} else if (
			node.name !== "w:rPr" ||
			child.name !== "w:rStyle" ||
			!dropped(child.attrs.find(([name]) => name === "w:val")?.[1] ?? "")
		) {
			children.push(withoutStyles(child, dropped))
		}
	}

	return { name: node.name, attrs: node.attrs, children }
}

const RUN_STYLE = /<w:rStyle\b[^>]*?\sw:val="([^"]*)"/g

// What a run's properties give no equation: fonts (the math font's), and revision records.
const DROPPED_RUN_PROPERTIES: ReadonlySet<string> = new Set(["w:rFonts", "w:rPrChange", "w:ins", "w:del", "w:moveFrom", "w:moveTo"])

// New XML for a new equation: `omml` with `rPr` on its runs and characters, and, while changes are tracked
// (`tracked`), every run and object of it inserted.
export function newEquation(omml: string, rPr: XElement, tracked: { readonly id: number; readonly stamp: OmmlStamp } | undefined): string {
	const root = ommlStringTree(omml)

	if (root === undefined) return omml

	const formatted = withRunProperties(root, rPr)

	return treeXml(tracked === undefined ? formatted : insertedTree(formatted, String(tracked.id), tracked.stamp))
}

// Kept for callers making a tracked equation from its XML alone (the fuzz's raw nodes).
export function trackedInsertion(omml: string, id: number, stamp: OmmlStamp): string {
	return newEquation(omml, equationRunProperties(undefined), { id, stamp })
}

// New XML for an edited equation: `omml` (the new equation) applied to it, what is new formatted as its first run
// is. Tracked (`ids`), the change is recorded as Word records it; untracked, the changes it had stay as they are.
// Undefined when it cannot be read.
export function editedEquation(
	node: Node,
	part: StoryPart,
	omml: string,
	stamp: OmmlStamp,
	ids: { readonly insertion: number; readonly deletion: number } | undefined
): string | undefined {
	const before = equationRoot(node, part)
	const after = ommlStringTree(omml)

	if (before === null || after === undefined) return undefined

	const formatted = withRunProperties(after, firstRunProperties(before) ?? equationRunProperties(undefined))
	const changed = diffTrees(before, formatted, stamp, String(ids?.insertion ?? -1), String(ids?.deletion ?? -1), ids !== undefined)

	return treeXml(normalizedTree(changed))
}

// New XML for an equation deleted while changes are tracked; null when it was all the author's own insertion
// (it goes), undefined when it cannot be read.
export function trackedDeletion(node: Node, part: StoryPart, id: number, stamp: OmmlStamp): string | null | undefined {
	const root = equationRoot(node, part)

	if (root === null) return undefined

	const deleted = deletedTree(root, String(id), stamp)

	return deleted === null ? null : treeXml(deleted)
}

// Whether the final document has nothing of the equation (every run and object of it deleted).
export function equationDeleted(node: Node, part: StoryPart | undefined): boolean {
	if (equationChanges(node, part).length === 0) return false

	const root = equationRoot(node, part)

	return root !== null && treeDeleted(root)
}

// The equation (math node) at `pos` of the session's document as LaTeX, or null when there is none.
export function equationLatex(session: DocxEditorSession, pos: number): DocxEquationLatex | null {
	const doc = session.state.doc
	const node = pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null

	return node?.type === nodes.math ? mathNodeLatex(node, session.story.part) : null
}

// Selects the equation at `pos` (before an edit of it); false when there is none.
export function selectEquation(session: DocxEditorSession, pos: number): boolean {
	const state = session.state
	const node = pos >= 0 && pos < state.doc.content.size ? state.doc.nodeAt(pos) : null

	if (node?.type !== nodes.math) return false

	const selection = state.selection

	if (selection instanceof NodeSelection && selection.from === pos) return true

	return session.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)))
}
