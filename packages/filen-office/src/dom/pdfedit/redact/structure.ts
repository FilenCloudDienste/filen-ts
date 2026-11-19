import type * as Mupdf from "mupdf"
import type { RedactionPlace } from "../../../core/pdfedit/redactVerify"

// The tagged-PDF side of a redaction: struct elements whose content was redacted lose their text alternatives
// (ActualText, Alt, E), which would otherwise still spell out what the page no longer draws, and so do all their
// ancestors: an ancestor's alternative stands for its whole subtree, the redacted part included.

// The entries of a struct element or marked-content property list that spell out its content in words.
export const TEXT_ALTERNATIVES: readonly string[] = ["ActualText", "Alt", "E"]
const MAX_TREE_DEPTH = 32
const MAX_PARENT_DEPTH = 256

// The value under `key` in a number tree, or null.
export function numberTreeGet(node: Mupdf.PDFObject, key: number, depth = 0): Mupdf.PDFObject | null {
	if (!node.isDictionary() || depth > MAX_TREE_DEPTH) return null

	const nums = node.get("Nums")

	if (nums.isArray()) {
		for (let index = 0; index + 1 < nums.length; index += 2) {
			if (nums.get(index).asNumber() === key) return nums.get(index + 1)
		}
	}

	const kids = node.get("Kids")

	if (!kids.isArray()) return null

	for (let index = 0; index < kids.length; index++) {
		const kid = kids.get(index)
		const limits = kid.get("Limits")

		if (limits.isArray() && (key < limits.get(0).asNumber() || key > limits.get(1).asNumber())) continue

		const found = numberTreeGet(kid, key, depth + 1)

		if (found !== null) return found
	}

	return null
}

function parentTree(document: Mupdf.PDFDocument): Mupdf.PDFObject | null {
	const tree = document.getTrailer().get("Root", "StructTreeRoot", "ParentTree")

	return tree.isDictionary() ? tree : null
}

function stripOne(element: Mupdf.PDFObject): boolean {
	let changed = false

	for (const key of TEXT_ALTERNATIVES) {
		if (!element.get(key).isNull()) {
			element.delete(key)
			changed = true
		}
	}

	return changed
}

// Strips an element's text alternatives and those of each ancestor up its /P chain to the structure tree's root.
function strip(element: Mupdf.PDFObject): boolean {
	const seen = new Set<number>()
	let changed = false
	let current = element

	for (let depth = 0; depth <= MAX_PARENT_DEPTH && current.isDictionary(); depth++) {
		if (current.isIndirect()) {
			if (seen.has(current.asIndirect())) break

			seen.add(current.asIndirect())
		}

		if (current.get("Type").asName() === "StructTreeRoot") break

		changed = stripOne(current) || changed
		current = current.get("P")
	}

	return changed
}

// Strips the text alternatives of the struct elements owning the given MCIDs of a page (or of every MCID on it).
// Returns whether anything changed.
export function stripPageStructText(document: Mupdf.PDFDocument, page: Mupdf.PDFObject, mcids: ReadonlySet<number> | "all"): boolean {
	const tree = parentTree(document)
	const key = page.get("StructParents")

	if (tree === null || !key.isNumber()) return false

	const entry = numberTreeGet(tree, key.asNumber())

	if (entry === null) return false
	if (!entry.isArray()) return strip(entry)

	let changed = false

	for (let index = 0; index < entry.length; index++) {
		if (mcids === "all" || mcids.has(index)) changed = strip(entry.get(index)) || changed
	}

	return changed
}

// Strips the text alternatives of the struct element of an object with a StructParent key (an annotation).
export function stripObjectStructText(document: Mupdf.PDFDocument, object: Mupdf.PDFObject): boolean {
	const tree = parentTree(document)
	const key = object.get("StructParent")

	if (tree === null || !key.isNumber()) return false

	const entry = numberTreeGet(tree, key.asNumber())

	return entry !== null && strip(entry)
}

// ——— Names a person chose ———

// Most PDF names and dictionary keys are the format's own (/Type, /Page, /Parent, /Font, …): cutting a term out of
// them destroys the document. Only these carry names a person chose, and only these are cut by Find and redact and
// searched by the verifier:
// - named destinations: the keys of the catalog's /Dests, a name under /Dest (bookmarks, links) or under /D of a
//   go-to action;
// - form fields: a value (/V, /DV) or a button's appearance state (/AS, and the state keys of /AP except /Off);
// - custom keys of the document information, and name values under them;
// - tags: custom structure types (an element's /S, the /RoleMap keys and the custom types they map to), class names
//   (/ClassMap keys, an element's /C), and attribute names of an owner the format does not define.

const GO_TO = new Set(["GoTo", "GoToR", "GoToE"])
const INFO_KEYS = new Set(["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Trapped"])
const STRUCTURE_TYPES = new Set([
	"Document",
	"DocumentFragment",
	"Part",
	"Art",
	"Sect",
	"Div",
	"BlockQuote",
	"Caption",
	"TOC",
	"TOCI",
	"Index",
	"NonStruct",
	"Private",
	"Aside",
	"Title",
	"FENote",
	"P",
	"H",
	"L",
	"LI",
	"Lbl",
	"LBody",
	"Table",
	"TR",
	"TH",
	"TD",
	"THead",
	"TBody",
	"TFoot",
	"Span",
	"Quote",
	"Note",
	"Reference",
	"BibEntry",
	"Code",
	"Link",
	"Annot",
	"Sub",
	"Em",
	"Strong",
	"Ruby",
	"RB",
	"RT",
	"RP",
	"Warichu",
	"WT",
	"WP",
	"Figure",
	"Formula",
	"Form",
	"Artifact"
])
const HEADING = /^H[1-9]\d*$/
// Attribute owners whose attribute names the format (or a standard it names) defines.
const ATTRIBUTE_OWNERS = new Set([
	"Layout",
	"List",
	"PrintField",
	"Table",
	"Artifact",
	"UserProperties",
	"HTML-3.20",
	"HTML-4.01",
	"OEB-1.00",
	"RTF-1.05",
	"CSS-1.00",
	"CSS-2.00",
	"ARIA-1.1"
])
const MAX_WALK = 1_000_000

// A structure type a person defined.
export function isCustomStructureType(type: string): boolean {
	return !STRUCTURE_TYPES.has(type) && !HEADING.test(type)
}

// The button appearance states the format defines (every button's off state); the others are chosen by a person.
export const STATE_KEYS: ReadonlySet<string> = new Set(["Off"])

// Whether the name `name` stored under `key` of `holder` is one a person chose, whatever dictionary holds it.
export function isUserNameValue(holder: Mupdf.PDFObject, key: string | number, name: string): boolean {
	if (key === "V" || key === "DV" || key === "AS") return !STATE_KEYS.has(name)

	return key === "Dest" || (key === "D" && GO_TO.has(holder.get("S").asName()))
}

// A widget's appearance state dictionaries (the /N, /D and /R entries of its /AP that are not streams).
export function appearanceStates(widget: Mupdf.PDFObject): Mupdf.PDFObject[] {
	const states: Mupdf.PDFObject[] = []

	widget.get("AP").forEach(appearance => {
		if (appearance.isDictionary() && !appearance.isStream()) states.push(appearance)
	})

	return states
}

// A dictionary whose keys a person chose, but for those in `fixed`.
export interface UserNameKeys {
	readonly dict: Mupdf.PDFObject
	readonly fixed: ReadonlySet<string>
	readonly place: RedactionPlace
}

// A name a person chose, stored under `key` of `holder` (a dictionary or an array).
export interface UserNameValue {
	readonly holder: Mupdf.PDFObject
	readonly key: string | number
	readonly place: RedactionPlace
	// What a name cut to nothing becomes; without it, the entry is removed.
	readonly empty?: string
}

export interface UserNames {
	readonly keys: UserNameKeys[]
	// In the order found: entries of one array by rising index.
	readonly values: UserNameValue[]
}

const NO_KEYS: ReadonlySet<string> = new Set()
const OWNER_KEYS: ReadonlySet<string> = new Set(["O", "NS"])

// The names a person chose that the name rules above cannot tell from where they are stored alone: the dictionaries
// whose keys are chosen, and the structure tree's custom types and classes. Name values the rule of isUserNameValue
// covers are left to the caller's walk over every object. Reached from the catalog, so only what the file uses.
export function userNames(document: Mupdf.PDFDocument): UserNames {
	const keys: UserNameKeys[] = []
	const values: UserNameValue[] = []
	const seen = new Set<number>()
	let budget = MAX_WALK
	const first = (object: Mupdf.PDFObject): boolean => {
		if (--budget < 0) return false
		if (!object.isIndirect()) return true

		const number = object.asIndirect()

		if (seen.has(number)) return false

		seen.add(number)

		return true
	}
	const trailer = document.getTrailer()
	const root = trailer.get("Root")
	const info = trailer.get("Info")

	if (info.isDictionary()) {
		keys.push({ dict: info, fixed: INFO_KEYS, place: "metadata" })
		info.forEach((value, key) => {
			if (typeof key === "string" && !INFO_KEYS.has(key) && value.isName()) values.push({ holder: info, key, place: "metadata" })
		})
	}

	const dests = root.get("Dests")

	if (dests.isDictionary()) keys.push({ dict: dests, fixed: NO_KEYS, place: "file" })

	// Button states: every widget is on a page, or in the form's field tree.
	const widget = (object: Mupdf.PDFObject): void => {
		for (const states of appearanceStates(object)) keys.push({ dict: states, fixed: STATE_KEYS, place: "field" })
	}
	const fields: Mupdf.PDFObject[] = []

	for (let index = 0; index < document.countPages(); index++) {
		document
			.findPage(index)
			.get("Annots")
			.forEach(annotation => {
				if (annotation.get("Subtype").asName() === "Widget" && first(annotation)) widget(annotation)
			})
	}

	root.get("AcroForm", "Fields").forEach(field => fields.push(field))

	for (let field = fields.pop(); field !== undefined; field = fields.pop()) {
		if (!field.isDictionary() || !first(field)) continue

		widget(field)
		field.get("Kids").forEach(kid => fields.push(kid))
	}

	// Tags.
	const tree = root.get("StructTreeRoot")
	const attributes = (object: Mupdf.PDFObject): void => {
		const visit = (dict: Mupdf.PDFObject): void => {
			if (dict.isDictionary() && !ATTRIBUTE_OWNERS.has(dict.get("O").asName())) keys.push({ dict, fixed: OWNER_KEYS, place: "tags" })
		}

		if (object.isArray()) object.forEach(visit)
		else visit(object)
	}

	if (!tree.isDictionary()) return { keys, values }

	const roles = tree.get("RoleMap")
	const classes = tree.get("ClassMap")

	if (roles.isDictionary()) {
		keys.push({ dict: roles, fixed: NO_KEYS, place: "tags" })
		roles.forEach((value, key) => {
			if (value.isName() && isCustomStructureType(value.asName())) values.push({ holder: roles, key, place: "tags" })
		})
	}

	if (classes.isDictionary()) {
		keys.push({ dict: classes, fixed: NO_KEYS, place: "tags" })
		classes.forEach(attributes)
	}

	const elements: Mupdf.PDFObject[] = [tree.get("K")]

	for (let element = elements.pop(); element !== undefined; element = elements.pop()) {
		if (element.isArray()) {
			if (first(element)) element.forEach(kid => elements.push(kid))

			continue
		}

		if (!element.isDictionary() || !first(element)) continue

		const type = element.get("S")

		// Marked-content and object references have no /S.
		if (!type.isName()) continue
		if (isCustomStructureType(type.asName())) values.push({ holder: element, key: "S", place: "tags", empty: "NonStruct" })

		const classNames = element.get("C")

		if (classNames.isName()) values.push({ holder: element, key: "C", place: "tags" })
		else if (classNames.isArray()) {
			classNames.forEach((name, index) => {
				if (name.isName()) values.push({ holder: classNames, key: index, place: "tags" })
			})
		}

		attributes(element.get("A"))
		elements.push(element.get("K"))
	}

	return { keys, values }
}
