import type { Mark, Node } from "prosemirror-model"
import { relationshipKind, type DocxPackage } from "../package"
import type { StoryPart } from "../model/index"
import type { DocxEditContext } from "../edit/context"
import { corePropertiesPart } from "../../opc/coreProperties"
import { Namespaces, type XmlDocument } from "../../xml/index"
import { controlKey, controlOf, simpleBinding, sourceControl, storeId, type ControlInfo, type SimpleBinding } from "./controls"
import { formatControlDate, parseControlDate, storedDate } from "./dates"

// Content controls bound to custom XML (ECMA-376 Part 1 §17.5.2.6 w:dataBinding): Word replaces a bound
// control's content with the bound node's text when it opens the file, so an edit is only kept when the
// node is updated with it. The editor updates nodes an absolute path of element steps finds
// ("/ns0:a[1]/ns0:b[1]", prefixes from w:prefixMappings); a control bound any other way (a predicate other
// than a position, an axis, a function, a rich text binding) is read-only ("bound"). A path that finds no node
// leaves the control unbound (§17.5.2.6), so its content is kept as edited.

// Store items Word maps to package parts rather than custom XML parts.
export const CORE_PROPERTIES_STORE = "6C3C8BC8-F283-45AE-878A-BAB7291924A1"
export const EXTENDED_PROPERTIES_STORE = "6668398D-A668-4E3E-A5EB-62B293D839F1"
// Word binds cover page fields to this id whatever w:itemID its cover page properties item has: the item
// whose root is in the cover page properties namespace.
export const COVER_PAGE_STORE = "55AF091B-3C7A-41E3-B477-F2FDAA23CFDA"
const COVER_PAGE_NAMESPACE = "http://schemas.microsoft.com/office/2006/coverPageProps"

// The node `binding` finds in `document`, or -1.
export function boundNode(document: XmlDocument, namespaces: Namespaces, binding: SimpleBinding): number {
	let node = -1

	for (const [k, step] of binding.steps.entries()) {
		let seen = 0
		let found = -1
		const matches = (candidate: number): boolean =>
			document.localName(candidate) === step.local && (namespaces.elementUri(candidate) ?? "") === step.uri

		if (k === 0) {
			const root = document.documentElement()

			if (root >= 0 && matches(root) && step.index === 1) found = root
		} else {
			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				if (matches(child) && ++seen === step.index) {
					found = child

					break
				}
			}
		}

		if (found < 0) return -1

		node = found
	}

	return node
}

// The text a control stores in its bound node: a checkbox "true"/"false", a list the value of the entry it shows
// (text typed into a combo box that is no entry's: the text), the date it shows as w:storeMappedDataAs says (text
// that is no date: the text), anything else its text.
export function boundValue(info: ControlInfo, text: string): string {
	if (info.checkbox !== null) return info.checkbox.checked ? "true" : "false"
	if (info.type === "dropDownList" || info.type === "comboBox") {
		const item = info.lastValue === null ? undefined : info.items.find(entry => entry.value === info.lastValue)

		return item !== undefined && item.text === text ? item.value : text
	}

	if (info.date !== null) {
		// w:fullDate is the last date the control held; what it shows may be text typed since.
		const date = info.date
		const iso =
			date.iso !== null && formatControlDate(date.iso, date.format, date.lid, date.calendar) === text
				? date.iso
				: parseControlDate(text, date.format, date.lid, date.calendar)

		return iso === null ? text : storedDate(iso, date.storeAs, text)
	}

	return text
}

// Finds the part of each store item: core and extended properties by their package relationships, custom
// XML items by the w:itemID of their properties part (customXml/itemPropsN.xml, ECMA-376 Part 1 §22.5).
export class BindingStores {
	private readonly pkg: DocxPackage
	private items: Promise<Map<string, string>> | undefined

	constructor(pkg: DocxPackage) {
		this.pkg = pkg
	}

	async part(store: string): Promise<string | undefined> {
		if (store === CORE_PROPERTIES_STORE) return corePropertiesPart(this.pkg.opc)

		if (store === EXTENDED_PROPERTIES_STORE) {
			const relationships = await this.pkg.relationships("")
			const app = relationships.all.find(
				relationship =>
					!relationship.external &&
					relationshipKind(relationship.type) === "extended-properties" &&
					relationship.partName !== undefined
			)

			return app?.partName !== undefined && this.pkg.has(app.partName) ? app.partName : undefined
		}

		this.items ??= this.readItems()

		const items = await this.items

		return items.get(store) ?? (store === COVER_PAGE_STORE ? items.get(COVER_PAGE_NAMESPACE) : undefined)
	}

	private async readItems(): Promise<Map<string, string>> {
		const out = new Map<string, string>()

		for (const item of this.pkg.parts("customXml")) {
			const relationships = await this.pkg.relationships(item)
			const props = relationships.all.find(
				relationship =>
					!relationship.external &&
					relationshipKind(relationship.type) === "customXmlProps" &&
					relationship.partName !== undefined
			)

			if (props?.partName === undefined || !this.pkg.has(props.partName)) continue

			const document = await this.pkg.xml(props.partName)
			const root = document.documentElement()
			const namespaces = new Namespaces(document, { lenient: true })
			const id = root < 0 ? undefined : namespaces.attribute(root, CUSTOM_XML, "itemID")

			if (id !== undefined && !out.has(storeId(id))) out.set(storeId(id), item)

			const data = await this.pkg.xml(item)
			const dataRoot = data.documentElement()

			if (
				dataRoot >= 0 &&
				!out.has(COVER_PAGE_NAMESPACE) &&
				new Namespaces(data, { lenient: true }).elementUri(dataRoot) === COVER_PAGE_NAMESPACE
			)
				out.set(COVER_PAGE_NAMESPACE, item)
		}

		return out
	}
}

const CUSTOM_XML = "http://schemas.openxmlformats.org/officeDocument/2006/customXml"

// ---- bound controls of a document -----------------------------------------------------------------------

export interface BoundControl {
	readonly binding: SimpleBinding
	// What the control stores in its node.
	readonly value: string
}

const DELETED = new Set(["deletion", "move_from"])

// The text of inline content as a binding stores it: deleted text left out, tabs and breaks as characters.
export function inlineText(node: Node): string {
	if (node.marks.some(mark => DELETED.has(mark.type.name))) return ""
	if (node.isText) return node.text ?? ""

	switch (node.type.name) {
		case "tab":
			return "\t"
		case "break":
			return "\n"
		default:
			return ""
	}
}

export function blockText(node: Node): string {
	const lines: string[] = []

	node.descendants(child => {
		if (!child.inlineContent) return !child.isInline

		let line = ""

		child.forEach(inline => {
			line += inlineText(inline)
		})
		lines.push(line)

		return false
	})

	return lines.join("\n")
}

const boundOf = new WeakMap<Node, ReadonlyMap<string, BoundControl>>()

// The controls of `doc` (a story of `part`) bound by a path the editor updates, by control (controlKey), with
// what each stores; a control showing its placeholder stores nothing. Kept per document.
export function boundControls(part: StoryPart, doc: Node): ReadonlyMap<string, BoundControl> {
	const known = boundOf.get(doc)

	if (known !== undefined) return known

	const out = new Map<string, BoundControl>()
	// A control split over paragraphs counts once, as its first piece (mirroring keeps the pieces alike).
	const add = (holder: Node | Mark, text: () => string): void => {
		const key = controlKey(holder)

		if (out.has(key)) return

		const info = controlOf(part, holder)
		const binding = info?.binding === null || info === undefined || info.richBinding ? undefined : simpleBinding(info.binding)

		if (info === undefined || binding === undefined) return

		out.set(key, { binding, value: info.showingPlaceholder ? "" : boundValue(info, text()) })
	}

	doc.descendants(node => {
		if (node.type.name === "sdt") add(node, () => blockText(node))

		if (!node.inlineContent) return !node.isInline

		// Each control's first run of content in the paragraph (a later piece is a control of its own).
		const spans: { mark: Mark; text: string; open: boolean }[] = []

		node.forEach(child => {
			const here = new Set<string>()

			for (const mark of child.marks) {
				if (mark.type.name !== "content_control") continue

				const key = controlKey(mark)
				const span = spans.find(entry => controlKey(entry.mark) === key)

				here.add(key)

				if (span === undefined) spans.push({ mark, text: inlineText(child), open: true })
				else if (span.open) span.text += inlineText(child)
			}

			for (const span of spans) if (!here.has(controlKey(span.mark))) span.open = false
		})

		for (const span of spans) add(span.mark, () => span.text)

		return false
	})

	boundOf.set(doc, out)

	return out
}

// Whether a part holds controls bound by a path the editor updates (asked once per part).
const partsBound = new WeakMap<StoryPart, boolean>()

export function partHasBindings(part: StoryPart): boolean {
	let found = partsBound.get(part)

	if (found === undefined) {
		found = false

		for (let row = 0; row < part.sdts.count && !found; row++) {
			const info = sourceControl(part, part.sdts.item[row] ?? -1)

			found = info.binding !== null && !info.richBinding && simpleBinding(info.binding) !== undefined
		}

		partsBound.set(part, found)
	}

	return found
}

// Binding keys several controls of a part share (Word keeps each such control showing its node's value).
const sharedOf = new WeakMap<StoryPart, ReadonlySet<string>>()

export function sharedBindings(part: StoryPart): ReadonlySet<string> {
	let found = sharedOf.get(part)

	if (found === undefined) {
		const seen = new Set<string>()
		const shared = new Set<string>()

		for (let row = 0; row < part.sdts.count; row++) {
			const info = sourceControl(part, part.sdts.item[row] ?? -1)
			const binding = info.binding === null || info.richBinding ? undefined : simpleBinding(info.binding)

			if (binding === undefined) continue
			if (seen.has(binding.key)) shared.add(binding.key)

			seen.add(binding.key)
		}

		found = shared
		sharedOf.set(part, found)
	}

	return found
}

// The value the latest edit of a document gave each bound node (by binding key): what a save stores when the
// node's controls still disagree (one cannot show it), as Word re-maps every control from the node on open.
const edited = new WeakMap<object, Map<string, string>>()

export function noteBoundEdit(context: object, key: string, value: string): void {
	let values = edited.get(context)

	if (values === undefined) {
		values = new Map()
		edited.set(context, values)
	}

	values.set(key, value)
}

export function editedValue(context: object, key: string): string | undefined {
	return edited.get(context)?.get(key)
}

// Binding keys of a document whose path finds no node, or one with child elements: Word maps no control to them
// (§17.5.2.6; "Content controls in Word": leaf nodes or attributes only), so the controls are not kept alike. Read
// once per document, in the background from the first ask (empty until known).
const unmapped = new WeakMap<DocxEditContext, { keys: Set<string>; done: Promise<void> }>()

export function unmappedKeys(context: DocxEditContext): ReadonlySet<string> {
	return unmappedEntry(context).keys
}

// Settles once the document's unmapped keys are known.
export function bindingsKnown(context: DocxEditContext): Promise<void> {
	return unmappedEntry(context).done
}

function unmappedEntry(context: DocxEditContext): { keys: Set<string>; done: Promise<void> } {
	let entry = unmapped.get(context)

	if (entry === undefined) {
		const keys = new Set<string>()

		entry = { keys, done: findUnmapped(context, keys).catch(() => undefined) }
		unmapped.set(context, entry)
	}

	return entry
}

async function findUnmapped(context: DocxEditContext, out: Set<string>): Promise<void> {
	const pkg = context.model.package
	const stores = new BindingStores(pkg)
	const seen = new Set<string>()

	for (const part of context.model.parts) {
		if (!partHasBindings(part)) continue

		for (let row = 0; row < part.sdts.count; row++) {
			const info = sourceControl(part, part.sdts.item[row] ?? -1)
			const binding = info.binding === null || info.richBinding ? undefined : simpleBinding(info.binding)

			if (binding === undefined || seen.has(binding.key)) continue

			seen.add(binding.key)

			const name = await stores.part(binding.store)
			const document = name === undefined ? undefined : await pkg.xml(name)
			const node = document === undefined ? -1 : boundNode(document, new Namespaces(document, { lenient: true }), binding)

			if (document === undefined || node < 0 || document.firstChildElement(node) >= 0) out.add(binding.key)
		}
	}
}

// Bound controls whose value changed from `original` (the story as built) to `doc`, by bound node.
export function changedBindings(part: StoryPart, original: Node, doc: Node): Map<string, BoundControl[]> {
	const out = new Map<string, BoundControl[]>()

	// A story whose part binds nothing may hold bound copies of another part's controls: looked at whole.
	if (original === doc) return out

	const before = boundControls(part, original)

	for (const [key, control] of boundControls(part, doc)) {
		if (before.get(key)?.value === control.value) continue

		const list = out.get(control.binding.key)

		if (list === undefined) out.set(control.binding.key, [control])
		else list.push(control)
	}

	return out
}
