import { appendAll } from "../arrays"
import { NodeKind, Namespaces, encodeUtf8, escapeAttribute, escapeText, parseXml, type XmlDocument } from "../xml/index"

// Tracked changes inside equations, as Word records them (ISO/IEC 29500-1 §17.13.5, §22.1.2.23): math runs and
// other math objects wrapped in w:ins / w:del (CT_RunTrackChange holds m:EG_OMathMathElements), and the insertion
// or deletion of an object's own characters (a fraction bar, an operator, fences) as w:ins / w:del in the object's
// m:ctrlPr (CT_MathCtrlIns, CT_MathCtrlDel; Microsoft Learn: InsertedMathControl, DeletedMathControl). An equation
// is worked on as a small element tree with its names normalised to the m: and w: prefixes (other namespaces keep
// theirs, declared on the equation): its changes listed, accepted or rejected, the whole of it deleted or inserted,
// and an edit recorded as the difference between the equation and the new one.

const MATH_URIS: ReadonlySet<string> = new Set([
	"http://schemas.openxmlformats.org/officeDocument/2006/math",
	"http://purl.oclc.org/ooxml/officeDocument/math"
])
const WORD_URIS: ReadonlySet<string> = new Set([
	"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
	"http://purl.oclc.org/ooxml/wordprocessingml/main"
])
const MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math"
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

// Math objects (m:EG_OMathMathElements besides m:r).
const OBJECTS: ReadonlySet<string> = new Set([
	"m:acc",
	"m:bar",
	"m:box",
	"m:borderBox",
	"m:d",
	"m:eqArr",
	"m:f",
	"m:func",
	"m:groupChr",
	"m:limLow",
	"m:limUpp",
	"m:m",
	"m:nary",
	"m:phant",
	"m:rad",
	"m:sPre",
	"m:sSub",
	"m:sSubSup",
	"m:sSup"
])
// Revision wrappers: what they record.
const WRAPPERS: Readonly<Record<string, "ins" | "del">> = { "w:ins": "ins", "w:moveTo": "ins", "w:del": "del", "w:moveFrom": "del" }
// Elements whose text is content (everything else between elements is layout whitespace).
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(["m:t", "w:t", "w:delText", "w:instrText", "w:delInstrText"])

export interface XElement {
	readonly name: string
	readonly attrs: readonly (readonly [string, string])[]
	readonly children: readonly XChild[]
}

export type XChild = XElement | string

export interface OmmlStamp {
	readonly author: string
	readonly date: string
}

export interface OmmlRevision extends OmmlStamp {
	readonly kind: "ins" | "del"
	readonly id: string
}

// One change of an equation: its revisions of one kind, author and date (Word records one per run and object);
// named by the id of its first.
export type OmmlChange = OmmlRevision

function element(name: string, attrs: readonly (readonly [string, string])[], children: readonly XChild[]): XElement {
	return { name, attrs, children }
}

function isElement(child: XChild | undefined): child is XElement {
	return typeof child === "object"
}

function attr(node: XElement, name: string): string | undefined {
	return node.attrs.find(([key]) => key === name)?.[1]
}

// ---- reading and writing ----------------------------------------------------------------------------------

function qualified(uri: string | undefined, local: string, prefix: string, declared: Map<string, string>): string {
	if (uri !== undefined && MATH_URIS.has(uri)) return `m:${local}`
	if (uri !== undefined && WORD_URIS.has(uri)) return `w:${local}`
	if (prefix === "xml") return `xml:${local}`
	if (prefix === "" || uri === undefined) return local

	declared.set(prefix, uri)

	return `${prefix}:${local}`
}

function convert(document: XmlDocument, namespaces: Namespaces, node: number, declared: Map<string, string>): XElement {
	const local = document.localName(node)
	const name = qualified(namespaces.elementUri(node), local, document.prefix(node), declared)
	const attrs: [string, string][] = []

	for (const attribute of document.attributes(node)) {
		const colon = attribute.name.indexOf(":")

		if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) continue
		if (colon < 0) {
			attrs.push([attribute.name, attribute.value])
		} else {
			const prefix = attribute.name.slice(0, colon)

			attrs.push([qualified(namespaces.uri(node, prefix), attribute.name.slice(colon + 1), prefix, declared), attribute.value])
		}
	}

	const children: XChild[] = []
	const text = TEXT_ELEMENTS.has(name)

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		const kind = document.kinds[child]

		if (kind === NodeKind.Element) {
			children.push(convert(document, namespaces, child, declared))
		} else if (text && (kind === NodeKind.Text || kind === NodeKind.CData)) {
			try {
				children.push(document.text(child))
			} catch {
				// An unreadable character reference: left out.
			}
		}
	}

	return element(name, attrs, children)
}

const namespaceCache = new WeakMap<XmlDocument, Namespaces>()

// Element `node` (an m:oMath or m:oMathPara) of `document` as a tree; namespaces other than math and
// WordprocessingML declared on it.
export function ommlTree(document: XmlDocument, node: number, namespaces?: Namespaces): XElement {
	let scoped = namespaces?.document === document ? namespaces : namespaceCache.get(document)

	if (scoped === undefined) {
		scoped = new Namespaces(document, { lenient: true })
		namespaceCache.set(document, scoped)
	}

	const declared = new Map<string, string>()
	const root = convert(document, scoped, node, declared)

	return declared.size === 0
		? root
		: element(
				root.name,
				[...[...declared].map(([prefix, uri]): [string, string] => [`xmlns:${prefix}`, uri]), ...root.attrs],
				root.children
			)
}

// An equation's XML as the editor keeps it (m: and w: prefixed, undeclared) as a tree.
export function ommlStringTree(omml: string): XElement | undefined {
	try {
		const document = parseXml(encodeUtf8(`<math xmlns:m="${MATH}" xmlns:w="${WORD}">${omml}</math>`))
		const node = document.firstChildElement(document.documentElement())

		return node < 0 ? undefined : ommlTree(document, node)
	} catch {
		return undefined
	}
}

// The tree as XML (m: and w: prefixed, as the editor keeps an equation's XML).
export function treeXml(node: XElement): string {
	let out = `<${node.name}`

	for (const [name, value] of node.attrs) out += ` ${name}="${escapeAttribute(value)}"`

	if (node.children.length === 0) return `${out}/>`

	out += ">"

	for (const child of node.children) out += isElement(child) ? treeXml(child) : escapeText(child)

	return `${out}</${node.name}>`
}

// ---- revisions ----------------------------------------------------------------------------------------------

function revisionOf(node: XElement): OmmlRevision | undefined {
	const kind = WRAPPERS[node.name]

	return kind === undefined
		? undefined
		: { kind, id: attr(node, "w:id") ?? "", author: attr(node, "w:author") ?? "", date: attr(node, "w:date") ?? "" }
}

function propertiesOf(object: XElement): XElement | undefined {
	const name = `${object.name}Pr`

	return object.children.find((child): child is XElement => isElement(child) && child.name === name)
}

function controlOf(object: XElement): XElement | undefined {
	const control = propertiesOf(object)?.children.find((child): child is XElement => isElement(child) && child.name === "m:ctrlPr")

	return control?.children.find((child): child is XElement => isElement(child) && (child.name === "w:ins" || child.name === "w:del"))
}

// The revision of an object's characters (a deletion recorded after the author's insertion of it wins).
function controlRevisions(object: XElement): OmmlRevision[] {
	const control = controlOf(object)

	if (control === undefined) return []

	const own = revisionOf(control)
	const inner = control.children.find((child): child is XElement => isElement(child) && child.name === "w:del")
	const later = inner === undefined ? undefined : revisionOf(inner)

	return [own, later].filter((revision): revision is OmmlRevision => revision !== undefined)
}

// Each revision with the element recording it (a wrapper, or the mark in an object's m:ctrlPr), in document order.
function eachRevision(node: XElement, visit: (revision: OmmlRevision, mark: XElement) => void): void {
	const stack: XElement[] = [node]

	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		const wrapper = revisionOf(next)

		if (wrapper !== undefined) visit(wrapper, next)

		if (OBJECTS.has(next.name)) {
			const control = controlOf(next)
			const own = control === undefined ? undefined : revisionOf(control)

			if (control !== undefined && own !== undefined) {
				visit(own, control)

				const later = control.children.find((child): child is XElement => isElement(child) && child.name === "w:del")
				const after = later === undefined ? undefined : revisionOf(later)

				if (later !== undefined && after !== undefined) visit(after, later)
			}
		}

		for (let k = next.children.length - 1; k >= 0; k--) {
			const child = next.children[k]

			if (isElement(child)) stack.push(child)
		}
	}
}

function groupKey(revision: OmmlRevision): string {
	return `${revision.kind}\u0000${revision.author}\u0000${revision.date}`
}

interface ChangeGroup {
	readonly change: OmmlChange
	readonly marks: Set<XElement>
}

const groupsOf = new WeakMap<XElement, readonly ChangeGroup[]>()

// The equation's changes as Word tells them apart: revisions of one kind, author and date with no unchanged run
// or object character between them are one change (another author's deletion nested in an insertion, and so
// interleaved with it, parts neither), named by its first revision's id (made unique in the equation).
function changeGroups(root: XElement): readonly ChangeGroup[] {
	const known = groupsOf.get(root)

	if (known !== undefined) return known

	const groups: ChangeGroup[] = []
	const ids = new Set<string>()
	// The change of each key open since the last unchanged content.
	const open = new Map<string, ChangeGroup>()
	const join = (revision: OmmlRevision, mark: XElement): void => {
		const key = groupKey(revision)
		const current = open.get(key)

		if (current !== undefined) {
			current.marks.add(mark)

			return
		}

		let id = revision.id

		for (let n = 2; ids.has(id); n++) id = `${revision.id}.${String(n)}`

		ids.add(id)

		const group: ChangeGroup = { change: { ...revision, id }, marks: new Set([mark]) }

		open.set(key, group)
		groups.push(group)
	}
	// Elements in document order, with whether a revision wrapper holds them.
	const stack: [XElement, boolean][] = [[root, false]]

	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		const [node, inside] = next
		const wrapper = revisionOf(node)
		let held = inside

		if (wrapper !== undefined) {
			join(wrapper, node)
			held = true
		} else if (node.name === "m:r" && !inside && holdsMath(node)) {
			// Unchanged content between revisions parts them.
			open.clear()
		} else if (OBJECTS.has(node.name)) {
			const control = controlOf(node)
			const own = control === undefined ? undefined : revisionOf(control)

			if (control !== undefined && own !== undefined) {
				join(own, control)

				const later = control.children.find((child): child is XElement => isElement(child) && child.name === "w:del")
				const after = later === undefined ? undefined : revisionOf(later)

				if (later !== undefined && after !== undefined) join(after, later)
			} else if (!inside) {
				open.clear()
			}
		}

		for (let k = node.children.length - 1; k >= 0; k--) {
			const child = node.children[k]

			if (isElement(child)) stack.push([child, held])
		}
	}

	groupsOf.set(root, groups)

	return groups
}

// The equation's changes in document order.
export function treeChanges(root: XElement): OmmlChange[] {
	return changeGroups(root).map(group => group.change)
}

// Whether a revision inside `node` (itself included) is another author's.
function othersInside(node: XElement, author: string): boolean {
	let found = false

	eachRevision(node, revision => {
		if (revision.author !== author) found = true
	})

	return found
}

// Whether a tree holds math: a run with text or an object.
function holdsMath(node: XElement): boolean {
	if (OBJECTS.has(node.name)) return true
	if (node.name === "m:t") return node.children.some(child => typeof child === "string" && child !== "")

	return node.children.some(child => isElement(child) && holdsMath(child))
}

// The equation without what is left of nothing (an m:oMath of a display with no math), null when no math is left.
function settled(root: XElement): XElement | null {
	if (root.name === "m:oMathPara") {
		const lines = root.children.filter(child => !isElement(child) || child.name !== "m:oMath" || holdsMath(child))

		return lines.some(child => isElement(child) && child.name === "m:oMath") ? element(root.name, root.attrs, lines) : null
	}

	return holdsMath(root) ? root : null
}

// An object with its characters' revision replaced by `next` (none: the run properties they had).
function withControl(object: XElement, next: XElement | undefined): XElement {
	const control = controlOf(object)
	const properties = propertiesOf(object)
	const rPr = control?.children.find((child): child is XElement => isElement(child) && child.name === "w:rPr")
	const inner = next === undefined ? (rPr === undefined ? [] : [rPr]) : [next]
	const ctrlPr = element("m:ctrlPr", [], inner)

	if (properties === undefined) {
		return inner.length === 0
			? object
			: element(object.name, object.attrs, [element(`${object.name}Pr`, [], [ctrlPr]), ...object.children])
	}

	const kept = properties.children.filter(child => !isElement(child) || child.name !== "m:ctrlPr")
	const updated = element(properties.name, properties.attrs, inner.length === 0 ? kept : [...kept, ctrlPr])

	return element(
		object.name,
		object.attrs,
		object.children.map(child => (child === properties ? updated : child))
	)
}

function stampAttrs(id: string, stamp: OmmlStamp): (readonly [string, string])[] {
	return [["w:id", id], ["w:author", stamp.author], ...(stamp.date === "" ? [] : [["w:date", stamp.date] as const])]
}

// The run properties an object's characters have (in m:ctrlPr, or in its revision mark), for a mark around them.
function controlProperties(object: XElement): XElement[] {
	const ctrlPr = propertiesOf(object)?.children.find((child): child is XElement => isElement(child) && child.name === "m:ctrlPr")
	const holder = controlOf(object) ?? ctrlPr

	return (holder?.children ?? []).filter((child): child is XElement => isElement(child) && child.name === "w:rPr")
}

function markControl(object: XElement, kind: "ins" | "del", id: string, stamp: OmmlStamp): XElement {
	const current = controlOf(object)

	// Deleted after another author's insertion of it: the deletion inside the insertion (CT_MathCtrlIns).
	if (kind === "del" && current?.name === "w:ins") {
		const rPr = current.children.filter((child): child is XElement => isElement(child) && child.name === "w:rPr")
		const later = element("w:del", stampAttrs(id, stamp), [
			element(
				"w:rPr",
				[],
				rPr.flatMap(node => node.children)
			)
		])

		return withControl(object, element("w:ins", current.attrs, [later]))
	}

	// With its run properties (Word writes them; an empty mark would be a revision holding nothing).
	const properties = controlProperties(object)

	return withControl(object, element(`w:${kind}`, stampAttrs(id, stamp), properties.length > 0 ? properties : [element("w:rPr", [], [])]))
}

// ---- accepting and rejecting -------------------------------------------------------------------------------

function resolveChildren(children: readonly XChild[], select: (mark: XElement) => boolean, accept: boolean): XChild[] {
	const out: XChild[] = []

	for (const child of children) {
		if (!isElement(child)) {
			out.push(child)
			continue
		}

		const wrapper = revisionOf(child)

		if (wrapper !== undefined) {
			const inner = resolveChildren(child.children, select, accept)

			if (!select(child)) {
				if (inner.length > 0) out.push(element(child.name, child.attrs, inner))
			} else if ((wrapper.kind === "ins") === accept) {
				appendAll(out, inner)
			}

			continue
		}

		const resolved = OBJECTS.has(child.name) ? resolveObject(child, select, accept) : child

		if (resolved !== null) out.push(element(resolved.name, resolved.attrs, resolveChildren(resolved.children, select, accept)))
	}

	return out
}

// An object with its characters' revisions resolved; null when it goes.
function resolveObject(object: XElement, select: (mark: XElement) => boolean, accept: boolean): XElement | null {
	const control = controlOf(object)
	const own = control === undefined ? undefined : revisionOf(control)

	if (control === undefined || own === undefined) return object

	const later = control.children.find((child): child is XElement => isElement(child) && child.name === "w:del")
	const after = later === undefined ? undefined : revisionOf(later)
	const rPr = (node: XElement): XElement[] =>
		node.children.filter((child): child is XElement => isElement(child) && child.name === "w:rPr")

	if (own.kind === "del") {
		if (!select(control)) return object

		return accept ? null : withControl(object, undefined)
	}

	const deletedLater = later !== undefined && after !== undefined && select(later)

	// Inserted (and maybe deleted since).
	if (select(control) && !accept) return null
	if (deletedLater && later !== undefined) {
		if (accept) return null

		// The deletion rejected: inserted (or, accepted too, plain) with the properties it had.
		return select(control) ? withControl(object, undefined) : withControl(object, element("w:ins", control.attrs, rPr(later)))
	}

	if (!select(control)) return object

	return after === undefined || later === undefined
		? withControl(object, undefined)
		: withControl(object, element("w:del", later.attrs, rPr(later)))
}

function runTextOf(run: XElement): string {
	let text = ""

	for (const child of run.children)
		if (isElement(child) && child.name === "m:t") for (const part of child.children) if (typeof part === "string") text += part

	return text
}

// Runs side by side with the same properties as one (and their text as one m:t, xml:space only where needed):
// what a resolution or an edit left split, as the equation reads.
export function normalizedTree(node: XElement): XElement {
	const out: XChild[] = []
	let last: { run: XElement; key: string; text: string } | undefined
	const flush = (): void => {
		if (last !== undefined) out.push(runWith(last.run, last.text))

		last = undefined
	}

	for (const child of node.children) {
		if (!isElement(child)) {
			flush()
			out.push(child)
			continue
		}

		const simple =
			child.name === "m:r" && child.children.every(part => isElement(part) && (part.name === "m:t" || part.name.endsWith("rPr")))

		if (!simple) {
			flush()
			out.push(normalizedTree(child))
			continue
		}

		const key = `${treeXml(
			element(
				"m:r",
				child.attrs,
				child.children.filter(part => isElement(part) && part.name !== "m:t")
			)
		)}`

		if (last !== undefined && last.key === key) {
			last.text += runTextOf(child)
		} else {
			flush()
			last = { run: child, key, text: runTextOf(child) }
		}
	}

	flush()

	return element(node.name, node.attrs, out)
}

// The equation with the revisions `select` takes (by the element recording each) accepted or rejected, null when
// nothing of it is left.
export function resolveTree(root: XElement, select: (mark: XElement) => boolean, accept: boolean): XElement | null {
	const resolved = settled(element(root.name, root.attrs, resolveChildren(root.children, select, accept)))

	return resolved === null ? null : normalizedTree(resolved)
}

// The revisions of the change named `id` (all of them without one); undefined when the equation has no such change.
export function changeSelector(root: XElement, id: string | undefined): ((mark: XElement) => boolean) | undefined {
	if (id === undefined) return () => true

	const group = changeGroups(root).find(candidate => candidate.change.id === id)

	return group === undefined ? undefined : mark => group.marks.has(mark)
}

// ---- recording ------------------------------------------------------------------------------------------------

// Argument elements of an object (what holds math); property elements are the rest.
function isArgument(node: XChild): node is XElement {
	return isElement(node) && !node.name.endsWith("Pr") && node.name.startsWith("m:")
}

// Runs and objects of `children` (inside wrappers too) all marked `kind`: runs wrapped (consecutive ones in one
// wrapper), objects' characters marked and their arguments marked the same way. Content deleted already stays;
// what the author inserted and now deletes goes.
function markAll(children: readonly XChild[], kind: "ins" | "del", id: string, stamp: OmmlStamp): XChild[] {
	const out: XChild[] = []
	let pending: XChild[] = []
	const flush = (): void => {
		if (pending.length > 0) out.push(element(`w:${kind}`, stampAttrs(id, stamp), pending))

		pending = []
	}

	for (const child of children) {
		if (!isElement(child)) {
			out.push(child)
			continue
		}

		const wrapper = revisionOf(child)

		if (wrapper !== undefined) {
			flush()

			if (kind === "del" && wrapper.kind === "del") out.push(child)
			else if (
				kind === "del" &&
				wrapper.author === stamp.author &&
				wrapper.kind === "ins" &&
				!othersInside(element("m:e", [], child.children), stamp.author)
			)
				continue
			else out.push(element(child.name, child.attrs, markAll(child.children, kind, id, stamp)))

			continue
		}

		if (child.name === "m:r") {
			pending.push(child)
			continue
		}

		flush()

		if (OBJECTS.has(child.name)) {
			const revisions = controlRevisions(child)

			if (kind === "del" && revisions.some(revision => revision.kind === "del")) {
				out.push(child)
				continue
			}

			// The author's own insertion goes, unless another author changed something inside it since.
			if (
				kind === "del" &&
				revisions[0]?.kind === "ins" &&
				revisions[0].author === stamp.author &&
				!othersInside(child, stamp.author)
			)
				continue

			const marked = markControl(child, kind, id, stamp)

			out.push(
				element(
					marked.name,
					marked.attrs,
					marked.children.map(arg => (isArgument(arg) ? element(arg.name, arg.attrs, markArgument(arg, kind, id, stamp)) : arg))
				)
			)
			continue
		}

		out.push(child)
	}

	flush()

	return out
}

// An argument's content marked (a matrix row's cells, each).
function markArgument(arg: XElement, kind: "ins" | "del", id: string, stamp: OmmlStamp): XChild[] {
	if (arg.name === "m:mr")
		return arg.children.map(cell => (isArgument(cell) ? element(cell.name, cell.attrs, markAll(cell.children, kind, id, stamp)) : cell))

	return markAll(arg.children, kind, id, stamp)
}

function lines(root: XElement): XElement[] {
	return root.name === "m:oMathPara"
		? root.children.filter((child): child is XElement => isElement(child) && child.name === "m:oMath")
		: [root]
}

function eachLine(root: XElement, change: (line: XElement) => XElement): XElement {
	if (root.name !== "m:oMathPara") return change(root)

	return element(
		root.name,
		root.attrs,
		root.children.map(child => (isElement(child) && child.name === "m:oMath" ? change(child) : child))
	)
}

// A new equation inserted while changes are tracked: every run and object of it.
export function insertedTree(root: XElement, id: string, stamp: OmmlStamp): XElement {
	return eachLine(root, line => element(line.name, line.attrs, markAll(line.children, "ins", id, stamp)))
}

// The equation deleted while changes are tracked; null when it was all the author's own insertion (it goes).
export function deletedTree(root: XElement, id: string, stamp: OmmlStamp): XElement | null {
	return settled(eachLine(root, line => element(line.name, line.attrs, markAll(line.children, "del", id, stamp))))
}

// Whether every run and object of the equation is deleted (nothing of it shows in the final document).
export function treeDeleted(root: XElement): boolean {
	const visible = (children: readonly XChild[]): boolean =>
		children.some(child => {
			if (!isElement(child)) return false

			const wrapper = revisionOf(child)

			if (wrapper !== undefined) return wrapper.kind === "ins" && visible(child.children)
			if (child.name === "m:r") return holdsMath(child)
			if (OBJECTS.has(child.name)) return !controlRevisions(child).some(revision => revision.kind === "del")

			return visible(child.children)
		})

	return !lines(root).some(line => visible(line.children))
}

// ---- recording an edit ----------------------------------------------------------------------------------

type Chain = readonly XElement[]

// One character or object of an equation's argument, with the wrappers around it.
interface Unit {
	readonly kind: "char" | "object" | "fixed"
	readonly text: string
	readonly key: string
	readonly node: XElement
	readonly chain: Chain
	// Shows in the final document (no deletion of it).
	readonly live: boolean
	// The author's own pending insertion: deleting it removes it.
	readonly own: boolean
	// The object (one an untracked edit takes out) the unit is inside.
	readonly parent?: Unit
}

const NEW_INSERTION: XElement = element("w:ins", [], [])
const NEW_DELETION: XElement = element("w:del", [], [])

// The math style of a run (what LaTeX says of it): its m:rPr.
function runKey(run: XElement): string {
	const properties = run.children.find((child): child is XElement => isElement(child) && child.name === "m:rPr")

	if (properties === undefined) return ""

	return properties.children
		.filter(isElement)
		.map(child => `${child.name}=${attr(child, "m:val") ?? ""}`)
		.sort()
		.join(",")
}

function runText(run: XElement): string {
	let text = ""

	for (const child of run.children)
		if (isElement(child) && child.name === "m:t") for (const part of child.children) if (typeof part === "string") text += part

	return text
}

// Properties LaTeX says of an object (defaults as written out), and its arguments' shape: two objects with the
// same signature are the same object with other content.
const SIGNED: ReadonlySet<string> = new Set([
	"m:chr",
	"m:limLoc",
	"m:subHide",
	"m:supHide",
	"m:begChr",
	"m:endChr",
	"m:sepChr",
	"m:type",
	"m:degHide",
	"m:pos"
])
const DEFAULTS: Readonly<Record<string, string>> = {
	"m:d/m:begChr": "(",
	"m:d/m:endChr": ")",
	"m:d/m:sepChr": "|",
	"m:acc/m:chr": "̂",
	"m:groupChr/m:chr": "⏟",
	"m:groupChr/m:pos": "bot",
	"m:bar/m:pos": "bot",
	"m:nary/m:chr": "∫",
	"m:f/m:type": "bar"
}
const FLAGS: ReadonlySet<string> = new Set(["m:subHide", "m:supHide", "m:degHide"])

function signature(object: XElement): string {
	const values: string[] = []

	for (const property of propertiesOf(object)?.children ?? []) {
		if (!isElement(property) || !SIGNED.has(property.name)) continue

		let value = attr(property, "m:val") ?? ""

		if (FLAGS.has(property.name)) value = value === "" || value === "1" || value === "on" || value === "true" ? "1" : "0"
		if (value === DEFAULTS[`${object.name}/${property.name}`] || (FLAGS.has(property.name) && value === "0")) continue

		values.push(`${property.name}=${value}`)
	}

	const shape = object.children
		.filter(isArgument)
		.map(arg => (arg.name === "m:mr" ? `mr${String(arg.children.filter(isArgument).length)}` : arg.name))
		.join(",")

	return `${object.name}|${values.sort().join(",")}|${shape}`
}

function collectUnits(children: readonly XChild[], chain: Chain, dead: boolean, own: boolean, author: string, out: Unit[]): void {
	for (const child of children) {
		if (!isElement(child)) continue

		const wrapper = revisionOf(child)

		if (wrapper !== undefined) {
			collectUnits(
				child.children,
				[...chain, child],
				dead || wrapper.kind === "del",
				own || (wrapper.kind === "ins" && wrapper.author === author),
				author,
				out
			)
		} else if (
			child.name === "m:r" &&
			child.children.every(part => !isElement(part) || part.name === "m:t" || part.name.endsWith("rPr"))
		) {
			const key = runKey(child)

			for (const character of runText(child)) out.push({ kind: "char", text: character, key, node: child, chain, live: !dead, own })
		} else if (OBJECTS.has(child.name)) {
			const revisions = controlRevisions(child)
			const inserted = revisions[0]?.kind === "ins" && revisions[0].author === author && !othersInside(child, author)

			out.push({
				kind: "object",
				text: "",
				key: signature(child),
				node: child,
				chain,
				live: !dead && !revisions.some(revision => revision.kind === "del"),
				own: (own && !othersInside(child, author)) || inserted
			})
		} else {
			out.push({ kind: "fixed", text: "", key: "", node: child, chain, live: false, own: false })
		}
	}
}

function same(a: Unit, b: Unit): boolean {
	return a.kind === b.kind && a.key === b.key && a.text === b.text
}

// Middles of two sequences compared in full no larger than this (cells): past it, a rewrite of a long
// equation is all deleted and inserted rather than compared (time stays bounded).
const MAX_COMPARED = 1 << 22

// The longest common subsequence of `a` and `b` (index pairs, in order): the common start and end taken off
// first, the middle by Hirschberg's method (memory linear in the lengths).
function common(a: readonly Unit[], b: readonly Unit[]): [number, number][] {
	let start = 0

	while (start < a.length && start < b.length && same(a[start] as Unit, b[start] as Unit)) start++

	let endA = a.length
	let endB = b.length

	while (endA > start && endB > start && same(a[endA - 1] as Unit, b[endB - 1] as Unit)) {
		endA--
		endB--
	}

	const out: [number, number][] = []

	for (let k = 0; k < start; k++) out.push([k, k])

	if ((endA - start) * (endB - start) <= MAX_COMPARED) middle(a, start, endA, b, start, endB, out)

	for (let k = 0; endA + k < a.length; k++) out.push([endA + k, endB + k])

	return out
}

// LCS lengths of a[from, to) against each prefix (forward) or suffix (backward) of b[b0, b1).
function lengths(a: readonly Unit[], from: number, to: number, b: readonly Unit[], b0: number, b1: number, forward: boolean): Uint32Array {
	const width = b1 - b0
	let previous = new Uint32Array(width + 1)
	let current = new Uint32Array(width + 1)

	for (let step = 0; step < to - from; step++) {
		const unit = a[forward ? from + step : to - 1 - step] as Unit

		current[forward ? 0 : width] = 0

		if (forward) {
			for (let j = 1; j <= width; j++)
				current[j] = same(unit, b[b0 + j - 1] as Unit)
					? (previous[j - 1] ?? 0) + 1
					: Math.max(previous[j] ?? 0, current[j - 1] ?? 0)
		} else {
			for (let j = width - 1; j >= 0; j--)
				current[j] = same(unit, b[b0 + j] as Unit) ? (previous[j + 1] ?? 0) + 1 : Math.max(previous[j] ?? 0, current[j + 1] ?? 0)
		}

		const swap = previous

		previous = current
		current = swap
	}

	return previous
}

function middle(a: readonly Unit[], a0: number, a1: number, b: readonly Unit[], b0: number, b1: number, out: [number, number][]): void {
	if (a1 <= a0 || b1 <= b0) return

	if (a1 - a0 === 1) {
		for (let j = b0; j < b1; j++) {
			if (same(a[a0] as Unit, b[j] as Unit)) {
				out.push([a0, j])

				return
			}
		}

		return
	}

	const half = (a0 + a1) >> 1
	const before = lengths(a, a0, half, b, b0, b1, true)
	const after = lengths(a, half, a1, b, b0, b1, false)
	let split = 0
	let best = -1

	for (let k = 0; k <= b1 - b0; k++) {
		const total = (before[k] ?? 0) + (after[k] ?? 0)

		if (total > best) {
			best = total
			split = k
		}
	}

	middle(a, a0, half, b, b0, b0 + split, out)
	middle(a, half, a1, b, b0 + split, b1, out)
}

// A piece of an argument's new content: a character of a run, or an element, and the wrappers around it.
interface Piece {
	readonly text?: string
	readonly run?: XElement
	readonly node?: XElement
	readonly chain: Chain
}

interface Recording {
	// Recorded as tracked changes (false: an edit changes the equation, changes it had stay as they are).
	readonly track: boolean
	readonly author: string
	readonly stamp: OmmlStamp
	readonly insertion: string
	readonly deletion: string
}

function wrapperFor(template: XElement, recording: Recording): XElement {
	if (template === NEW_INSERTION) return element("w:ins", stampAttrs(recording.insertion, recording.stamp), [])
	if (template === NEW_DELETION) return element("w:del", stampAttrs(recording.deletion, recording.stamp), [])

	return template
}

function runWith(run: XElement, text: string): XElement {
	const properties = run.children.filter((child): child is XElement => isElement(child) && child.name !== "m:t")
	const spaced = /^\s|\s$/.test(text)

	return element(run.name, run.attrs, [...properties, element("m:t", spaced ? [["xml:space", "preserve"]] : [], [text])])
}

// Pieces as elements: consecutive pieces under the same wrapper in one wrapper, consecutive characters of one
// run in one run.
function build(pieces: readonly Piece[], depth: number, recording: Recording): XChild[] {
	const out: XChild[] = []
	let at = 0

	while (at < pieces.length) {
		const piece = pieces[at] as Piece
		const wrapper = piece.chain[depth]

		if (wrapper !== undefined) {
			let end = at

			while (end < pieces.length && pieces[end]?.chain[depth] === wrapper) end++

			const made = wrapperFor(wrapper, recording)

			out.push(element(made.name, made.attrs, build(pieces.slice(at, end), depth + 1, recording)))
			at = end
			continue
		}

		if (piece.run !== undefined) {
			let text = ""
			let end = at

			while (end < pieces.length && pieces[end]?.run === piece.run && pieces[end]?.chain.length === depth)
				text += pieces[end++]?.text ?? ""

			out.push(runWith(piece.run, text))
			at = end
			continue
		}

		if (piece.node !== undefined) out.push(piece.node)

		at++
	}

	return out
}

// The new content of an argument: `before`'s, changed into `after`'s with what changed recorded.
function diffArgument(before: readonly XChild[], after: readonly XChild[], recording: Recording): XChild[] {
	const old: Unit[] = []
	const next: Unit[] = []

	collectUnits(before, [], false, false, recording.author, old)
	collectUnits(after, [], false, false, recording.author, next)

	const live = old.filter(unit => unit.live)
	const fresh = next.filter(unit => unit.kind !== "fixed")
	const pairs = common(live, fresh)
	const pieces: Piece[] = []
	const partner = new Map(pairs)
	// Untracked, content the edit moves (wrapped in a new object, or out of one it takes away) keeps its changes.
	const carry = recording.track ? undefined : carrying(live, fresh, pairs, recording)
	const deleted = (unit: Unit): void => {
		if (carry !== undefined) {
			// Deleted content inside an object taken out stays deleted where it was.
			if (unit.kind === "object") appendAll(pieces, carry.dead(unit))

			return
		}

		if (unit.own) return

		if (unit.kind === "char") pieces.push({ text: unit.text, run: unit.node, chain: [...unit.chain, NEW_DELETION] })
		else pieces.push({ node: deletedObject(unit.node, recording), chain: unit.chain })
	}
	const inserted = (unit: Unit): void => {
		const carried = carry?.pieces.get(unit)

		if (carried !== undefined) pieces.push(carried)
		else if (unit.kind === "char") pieces.push({ text: unit.text, run: unit.node, chain: recording.track ? [NEW_INSERTION] : [] })
		else pieces.push({ node: recording.track ? insertedObject(unit.node, recording) : unit.node, chain: [] })
	}
	let liveAt = 0
	let freshAt = 0
	const emitOld = (unit: Unit): void => {
		if (unit.kind === "char") pieces.push({ text: unit.text, run: unit.node, chain: unit.chain })
		else pieces.push({ node: unit.node, chain: unit.chain })
	}

	for (const unit of old) {
		if (!unit.live) {
			emitOld(unit)
			continue
		}

		const match = partner.get(liveAt)

		if (match === undefined) {
			deleted(unit)
		} else {
			// What is new before the match goes before it.
			while (freshAt < match) inserted(fresh[freshAt++] as Unit)

			freshAt++

			if (unit.kind === "object")
				pieces.push({ node: diffObject(unit.node, fresh[match]?.node ?? unit.node, recording), chain: unit.chain })
			else emitOld(unit)
		}

		liveAt++
	}

	while (freshAt < fresh.length) inserted(fresh[freshAt++] as Unit)

	return build(pieces, 0, recording)
}

// The content of an object's arguments (a matrix's cells), as children.
function argumentBodies(object: XElement): XChild[][] {
	const bodies: XChild[][] = []

	for (const arg of object.children) {
		if (!isArgument(arg)) continue

		for (const cell of arg.name === "m:mr" ? arg.children.filter(isArgument) : [arg])
			bodies.push(cell.children.filter(child => !isElement(child) || (child.name !== "m:argPr" && child.name !== "m:ctrlPr")))
	}

	return bodies
}

// Units of what an object holds, inside its wrappers (`chain`), each knowing the object.
function unitsInside(object: Unit, author: string): Unit[] {
	const out: Unit[] = []

	for (const body of argumentBodies(object.node)) {
		const inner: Unit[] = []

		collectUnits(body, object.chain, false, false, author, inner)

		for (const unit of inner) {
			if (!unit.live) continue

			const placed: Unit = { ...unit, parent: object }

			out.push(placed)

			if (placed.kind === "object") appendAll(out, unitsInside(placed, author))
		}
	}

	return out
}

// Deleted content (pending deletions) inside an object, as pieces; objects in `moved` went elsewhere whole.
function deadInside(object: XElement, chain: Chain, author: string, moved: ReadonlySet<XElement>): Piece[] {
	const pieces: Piece[] = []

	for (const body of argumentBodies(object)) {
		const inner: Unit[] = []

		collectUnits(body, chain, false, false, author, inner)

		for (const unit of inner) {
			if (unit.live) {
				if (unit.kind === "object" && !moved.has(unit.node)) appendAll(pieces, deadInside(unit.node, unit.chain, author, moved))
			} else if (unit.kind === "char") {
				pieces.push({ text: unit.text, run: unit.node, chain: unit.chain })
			} else if (unit.kind === "object") {
				pieces.push({ node: unit.node, chain: unit.chain })
			}
		}
	}

	return pieces
}

// What an untracked edit makes of new content: each unit of it standing for one of the content it took out (the
// characters and objects it moved, with the wrappers they had), the rest plain.
function carrying(
	live: readonly Unit[],
	fresh: readonly Unit[],
	pairs: readonly (readonly [number, number])[],
	recording: Recording
): { readonly pieces: ReadonlyMap<Unit, Piece>; dead(unit: Unit): Piece[] } {
	const kept = new Set(pairs.map(([at]) => at))
	const placed = new Set(pairs.map(([, at]) => at))
	const pool: Unit[] = []

	live.forEach((unit, at) => {
		if (kept.has(at)) return

		pool.push(unit)

		if (unit.kind === "object") appendAll(pool, unitsInside(unit, recording.author))
	})

	// Units of the pool taken, and objects of it something inside was taken from (not taken whole).
	const used = new Set<Unit>()
	const moved = new Set<XElement>()
	const touched = new Set<Unit>()
	const free = (unit: Unit): boolean => {
		if (used.has(unit) || (unit.kind === "object" && touched.has(unit))) return false

		for (let up = unit.parent; up !== undefined; up = up.parent) if (used.has(up)) return false

		return true
	}
	const take = (unit: Unit): void => {
		used.add(unit)

		if (unit.kind === "object") moved.add(unit.node)

		for (let up = unit.parent; up !== undefined; up = up.parent) touched.add(up)
	}
	// New units matched to free units of the pool, in order (the longest common subsequence).
	const matched = (units: readonly Unit[]): Map<Unit, Unit> => {
		const available = pool.filter(free)
		const out = new Map<Unit, Unit>()

		if (available.length === 0) return out

		for (const [a, b] of common(available, units)) {
			const from = available[a] as Unit

			// Taken in order, a unit inside one taken before is not free any more.
			if (!free(from)) continue

			take(from)
			out.set(units[b] as Unit, from)
		}

		return out
	}
	const unmatched = fresh.filter((_, at) => !placed.has(at))
	const first = matched(unmatched)
	const piece = (unit: Unit, sources: ReadonlyMap<Unit, Unit>): Piece => {
		const source = sources.get(unit)

		if (source !== undefined) {
			if (unit.kind === "char") return { text: unit.text, run: source.node, chain: source.chain }

			return { node: diffObject(source.node, unit.node, recording), chain: source.chain }
		}

		if (unit.kind === "char") return { text: unit.text, run: unit.node, chain: [] }

		return { node: carriedObject(unit.node), chain: [] }
	}
	// A new object, its arguments' content matched to what is left of the pool.
	const carriedObject = (object: XElement): XElement => {
		const body = (cell: XElement): XElement => {
			const head = cell.children.filter(child => isElement(child) && child.name === "m:argPr")
			const tail = cell.children.filter(child => isElement(child) && child.name === "m:ctrlPr")
			const inner: Unit[] = []

			collectUnits(
				cell.children.filter(child => !isElement(child) || (child.name !== "m:argPr" && child.name !== "m:ctrlPr")),
				[],
				false,
				false,
				recording.author,
				inner
			)

			const units = inner.filter(unit => unit.kind !== "fixed")
			const sources = matched(units)

			return element(cell.name, cell.attrs, [
				...head,
				...build(
					units.map(unit => piece(unit, sources)),
					0,
					recording
				),
				...tail
			])
		}

		return element(
			object.name,
			object.attrs,
			object.children.map(arg => {
				if (!isArgument(arg)) return arg
				if (arg.name !== "m:mr") return body(arg)

				return element(
					arg.name,
					arg.attrs,
					arg.children.map(cell => (isArgument(cell) ? body(cell) : cell))
				)
			})
		)
	}

	// Made at once, in order: what each new unit takes is decided before what is left of the pool is known.
	const pieces = new Map(unmatched.map(unit => [unit, piece(unit, first)] as const))

	return {
		pieces,
		dead: unit => (moved.has(unit.node) ? [] : deadInside(unit.node, unit.chain, recording.author, moved))
	}
}

function deletedObject(object: XElement, recording: Recording): XElement {
	const [marked] = markAll([object], "del", recording.deletion, recording.stamp)

	return isElement(marked) ? marked : object
}

function insertedObject(object: XElement, recording: Recording): XElement {
	const [marked] = markAll([object], "ins", recording.insertion, recording.stamp)

	return isElement(marked) ? marked : object
}

// The same object with each argument's content diffed (a matrix's cells, each).
function diffObject(before: XElement, after: XElement, recording: Recording): XElement {
	const afterArgs = after.children.filter(isArgument)
	let k = 0

	return element(
		before.name,
		before.attrs,
		before.children.map(child => {
			if (!isArgument(child)) return child

			const other = afterArgs[k++]

			if (other === undefined) return child

			if (child.name === "m:mr") {
				const cells = other.children.filter(isArgument)
				let c = 0

				return element(
					child.name,
					child.attrs,
					child.children.map(cell => (isArgument(cell) ? diffArg(cell, cells[c++], recording) : cell))
				)
			}

			return diffArg(child, other, recording)
		})
	)
}

function diffArg(before: XElement, after: XElement | undefined, recording: Recording): XElement {
	if (after === undefined) return before

	const head = before.children.filter(child => isElement(child) && child.name === "m:argPr")
	const tail = before.children.filter(child => isElement(child) && child.name === "m:ctrlPr")
	const body = before.children.filter(child => !isElement(child) || (child.name !== "m:argPr" && child.name !== "m:ctrlPr"))
	const fresh = after.children.filter(child => !isElement(child) || (child.name !== "m:argPr" && child.name !== "m:ctrlPr"))

	return element(before.name, before.attrs, [...head, ...diffArgument(body, fresh, recording), ...tail])
}

// The equation `before` changed into `after` (the new equation), the change recorded (`track`) as Word records an
// edit of an equation with changes tracked: characters retyped as deleted and inserted runs, objects that changed shape
// deleted and inserted whole (their characters marked in m:ctrlPr). Untracked, what goes goes and what is new is
// plain. Either way the formatting and the changes `before` had stay.
// `insertion`, `deletion`: the ids of the two changes.
export function diffTrees(
	before: XElement,
	after: XElement,
	stamp: OmmlStamp,
	insertion: string,
	deletion: string,
	track = true
): XElement {
	const recording: Recording = { track, author: stamp.author, stamp, insertion, deletion }
	const old = lines(before)
	const fresh = lines(after)
	const changed: XElement[] = []

	for (let k = 0; k < Math.max(old.length, fresh.length); k++) {
		const line = old[k]
		const other = fresh[k]

		if (line === undefined && other !== undefined) changed.push(track ? insertedTree(other, insertion, stamp) : other)
		else if (line !== undefined) changed.push(diffArg(line, other ?? element("m:oMath", [], []), recording))
	}

	if (before.name !== "m:oMathPara") return changed[0] ?? before

	const kept = before.children.filter(child => !isElement(child) || child.name !== "m:oMath")

	return element(before.name, before.attrs, [...kept, ...changed])
}

// ---- run properties ----------------------------------------------------------------------------------------

// The w:rPr of an equation's first run that has one.
export function firstRunProperties(root: XElement): XElement | undefined {
	const stack: XElement[] = [root]

	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		if (next.name === "m:r") {
			const rPr = next.children.find((child): child is XElement => isElement(child) && child.name === "w:rPr")

			if (rPr !== undefined) return rPr
		}

		for (let k = next.children.length - 1; k >= 0; k--) {
			const child = next.children[k]

			if (isElement(child)) stack.push(child)
		}
	}

	return undefined
}

// The equation with `rPr` as the run properties of every run and object character (m:r's w:rPr, m:ctrlPr), as
// Word gives a new equation the formatting where it is typed.
export function withRunProperties(node: XElement, rPr: XElement): XElement {
	if (node.name === "m:r") {
		const kept = node.children.filter(child => !isElement(child) || child.name !== "w:rPr")
		const at = kept.findIndex(child => isElement(child) && child.name === "m:rPr") + 1

		return element(node.name, node.attrs, [...kept.slice(0, at), rPr, ...kept.slice(at)])
	}

	const children = node.children.map(child => (isElement(child) ? withRunProperties(child, rPr) : child))
	const changed = element(node.name, node.attrs, children)

	return OBJECTS.has(node.name) && controlOf(changed) === undefined ? withControl(changed, rPr) : changed
}
