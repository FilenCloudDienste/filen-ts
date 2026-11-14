import type { PDFDocument, PDFGraftMap, PDFObject } from "mupdf"
import type { PdfMatrix } from "../../../core/pdfedit/matrix"
import {
	appearanceMatrix,
	appendPageContent,
	at,
	catalog,
	deref,
	ensureArray,
	explicitDest,
	formatNumber,
	freeXObjectName,
	items,
	MAX_DEPTH,
	nameOf,
	namedDests,
	numbers,
	numOf,
	pageAnnots,
	ref,
	type NamedDests
} from "./objects"

// Copies pages from one document into another through ONE graft map (shared fonts, images and appearance streams are
// copied once). MuPDF's graftPage copies a page's content, resources and boxes but not its annotations, so these are
// copied here, under rules that never let a reference reach a page that is not copied: a grafted reference to another
// page would copy that page, its parent page tree and so every page of the source (excluded pages' content leaking
// into an extract). So:
// - annotations are copied key by key; /P, /Parent, /Popup, /IRT, destinations and actions are rebuilt, never grafted;
// - links and GoTo actions go to the copied page they pointed at, or are dropped;
// - only GoTo, URI and Named actions survive (JavaScript too when `scripts` is "keep"); /AA is rebuilt the same way;
// - form fields are rebuilt as a hierarchy holding only copied widgets, registered in the target's /AcroForm;
// - a signed signature field cannot be copied (its value signs other bytes): its visible appearance is drawn into the
//   page's content and the field is dropped; an unsigned one stays a field;
// - structure (tags) is not copied: copied pages lose /StructParents.

export interface CopyPagesOptions {
	// "strip": pages from another file (scripts and additional actions dropped). "keep": an extract of the user's own
	// document.
	readonly scripts: "strip" | "keep"
	// Copy the outline items that go to copied pages (and the headings above them) as the target's outline. For a new
	// document only: an existing outline is replaced.
	readonly outline?: boolean
}

export interface CopiedPages {
	// The new pages, in order.
	readonly pages: readonly PDFObject[]
	// Signed signature fields drawn into page content and dropped.
	readonly flattenedSignatures: number
	// Source page object number → target page object.
	readonly targets: ReadonlyMap<number, PDFObject>
}

interface Context {
	readonly target: PDFDocument
	readonly source: PDFDocument
	readonly map: PDFGraftMap
	readonly named: NamedDests
	readonly targets: Map<number, PDFObject>
	// Source field object number → its copy.
	readonly fields: Map<number, PDFObject>
	readonly roots: PDFObject[]
	readonly scripts: "strip" | "keep"
	flattened: number
}

// Annotation keys rebuilt rather than grafted.
const ANNOT_REBUILT = new Set(["P", "Parent", "Popup", "IRT", "Dest", "A", "AA", "StructParent", "Kids"])
// Field-level keys of a merged field/widget dictionary or a field node.
const FIELD_REBUILT = new Set(["Parent", "Kids", "A", "AA", "P"])
const KEEP_ACTIONS = new Set(["GoTo", "URI", "Named"])

// Copies `pages` (0-based source indices, in order) to stand before target page `at` (0..count).
export function copyPages(
	target: PDFDocument,
	source: PDFDocument,
	pages: readonly number[],
	at_: number,
	options: CopyPagesOptions
): CopiedPages {
	const context: Context = {
		target,
		source,
		map: target.newGraftMap(),
		named: namedDests(source),
		targets: new Map(),
		fields: new Map(),
		roots: [],
		scripts: options.scripts,
		flattened: 0
	}
	const start = Math.max(0, Math.min(target.countPages(), at_))
	const copied: PDFObject[] = []

	// First every page, so links can go to pages copied after theirs.
	pages.forEach((page, offset) => {
		context.map.graftPage(start + offset, source, page)

		const made = target.findPage(start + offset)
		const dict = deref(made)

		for (const key of ["Annots", "StructParents", "B", "PieceInfo"]) dict.delete(key)

		if (options.scripts === "strip") dict.delete("AA")

		const sourceNum = numOf(source.findPage(page))

		if (sourceNum !== null) context.targets.set(sourceNum, made)

		copied.push(made)
	})

	pages.forEach((page, offset) => {
		const made = copied[offset]

		if (made !== undefined) copyAnnotations(context, source.findPage(page), made)
	})

	registerFields(context)

	if (options.outline === true) copyOutline(context)

	return { pages: copied, flattenedSignatures: context.flattened, targets: context.targets }
}

// The source outline, keeping items that go to copied pages and, without a destination, headings above kept items.
function copyOutline(context: Context): void {
	const source = at(catalog(context.source), "Outlines")

	if (!source.isDictionary()) return

	const outlines = context.target.addObject(context.target.newDictionary())

	outlines.put("Type", context.target.newName("Outlines"))

	const visible = copyOutlineChildren(context, source, outlines, 0, { nodes: 0 })

	if (at(outlines, "First").isNull()) return

	outlines.put("Count", visible)
	catalog(context.target).put("Outlines", outlines)
}

// Copies the children of `source` under `parent`; returns how many of them (with open descendants) are visible.
function copyOutlineChildren(context: Context, source: PDFObject, parent: PDFObject, depth: number, budget: { nodes: number }): number {
	if (depth > MAX_DEPTH) return 0

	const kept: PDFObject[] = []
	const seen = new Set<number>()
	let visible = 0
	let item = ref(source, "First")

	while (!item.isNull() && budget.nodes++ < 1_000_000) {
		const num = numOf(item)

		if (num !== null) {
			if (seen.has(num)) break

			seen.add(num)
		}

		const dict = deref(item)

		if (!dict.isDictionary()) break

		const made = context.target.addObject(context.target.newDictionary())
		const below = copyOutlineChildren(context, dict, made, depth + 1, budget)
		const dest = ref(dict, "Dest")
		const action = ref(dict, "A")
		const remappedDest = dest.isNull() ? null : remapDest(context, dest)
		const remappedAction = action.isNull() || remappedDest !== null ? null : remapAction(context, action)
		const goes = remappedDest !== null || (remappedAction !== null && nameOf(ref(remappedAction, "S")) === "GoTo")

		if (goes || !at(made, "First").isNull()) {
			const title = ref(dict, "Title")
			const count = at(dict, "Count")
			const open = count.isNumber() && count.asNumber() > 0

			made.put("Title", title.isNull() ? context.target.newString("") : graft(context, title))
			made.put("Parent", parent)

			if (remappedDest !== null) made.put("Dest", remappedDest)
			else if (remappedAction !== null) made.put("A", remappedAction)

			for (const key of ["C", "F"]) {
				const value = at(dict, key)

				if (value.isArray() || value.isInteger()) made.put(key, graft(context, value))
			}

			if (below > 0) made.put("Count", open ? below : -below)

			visible += 1 + (open ? below : 0)
			kept.push(made)
		}

		item = ref(dict, "Next")
	}

	kept.forEach((made, index) => {
		const previous = kept[index - 1]
		const next = kept[index + 1]

		if (previous !== undefined) made.put("Prev", previous)
		if (next !== undefined) made.put("Next", next)
	})

	const first = kept[0]
	const last = kept.at(-1)

	if (first !== undefined && last !== undefined) {
		parent.put("First", first)
		parent.put("Last", last)
	}

	return visible
}

function graft(context: Context, value: PDFObject): PDFObject {
	return context.map.graftObject(value)
}

// A destination rebuilt for the target: the copied page it goes to, the rest of the array (view and coordinates)
// copied. Null when that page was not copied.
function remapDest(context: Context, dest: PDFObject): PDFObject | null {
	const explicit = explicitDest(dest, context.named)
	const num = explicit === null ? null : numOf(ref(explicit, 0))
	const page = num === null ? undefined : context.targets.get(num)

	if (explicit === null || page === undefined) return null

	const out = context.target.newArray()

	out.push(page)

	for (let index = 1; index < explicit.length; index++) {
		const item = at(explicit, index)

		out.push(item.isNumber() || item.isName() || item.isNull() ? graft(context, item) : context.target.newNull())
	}

	return out
}

function remapAction(context: Context, action: PDFObject): PDFObject | null {
	const dict = deref(action)
	const kind = nameOf(ref(dict, "S"))

	if (kind === null) return null

	if (kind === "GoTo") {
		const dest = remapDest(context, ref(dict, "D"))

		if (dest === null) return null

		const out = context.target.newDictionary()

		out.put("S", context.target.newName("GoTo"))
		out.put("D", dest)

		return out
	}

	if (!KEEP_ACTIONS.has(kind) && !(kind === "JavaScript" && context.scripts === "keep")) return null

	const copy = context.source.newDictionary()

	dict.forEach((value, key) => {
		if (key !== "Next" && typeof key === "string") copy.put(key, value)
	})

	return graft(context, copy)
}

function remapAdditional(context: Context, actions: PDFObject): PDFObject | null {
	if (context.scripts === "strip") return null

	const dict = deref(actions)

	if (!dict.isDictionary()) return null

	const out = context.target.newDictionary()
	let any = false

	dict.forEach((value, key) => {
		const remapped = typeof key === "string" ? remapAction(context, value) : null

		if (remapped !== null && typeof key === "string") {
			out.put(key, remapped)
			any = true
		}
	})

	return any ? out : null
}

// A field attribute, inherited through /Parent (null object when no node has it).
function inherited(dict: PDFObject, key: string): PDFObject {
	let node = dict
	let value = ref(node, key)

	for (let depth = 0; depth < MAX_DEPTH && value.isNull() && node.isDictionary(); depth++) {
		node = at(node, "Parent")
		value = ref(node, key)
	}

	return value
}

function fieldType(dict: PDFObject): string | null {
	return nameOf(inherited(dict, "FT"))
}

function copyAnnotations(context: Context, sourcePage: PDFObject, targetPage: PDFObject): void {
	const annots = context.target.newArray()
	// Source annotation number → copy, for /Popup and /IRT links between them.
	const copies = new Map<number, PDFObject>()
	const sources: { readonly dict: PDFObject; readonly copy: PDFObject }[] = []
	const flatten: { readonly stream: PDFObject; readonly matrix: PdfMatrix }[] = []

	for (const annot of pageAnnots(sourcePage)) {
		const dict = deref(annot)

		if (!dict.isDictionary()) continue

		const subtype = nameOf(ref(dict, "Subtype"))

		if (subtype === "Widget" && fieldType(dict) === "Sig" && !inherited(dict, "V").isNull()) {
			const drawn = signatureAppearance(context, dict)

			if (drawn !== null) flatten.push(drawn)

			context.flattened++
			continue
		}

		if (subtype === "Link" && !copyableLink(context, dict)) continue

		const copy = copyAnnot(context, dict, targetPage)

		if (copy === null) continue

		if (subtype === "Widget") attachWidget(context, dict, copy)

		const num = numOf(annot)

		if (num !== null) copies.set(num, copy)

		sources.push({ dict, copy })
	}

	for (const { dict, copy } of sources) {
		for (const key of ["Popup", "IRT", "Parent"] as const) {
			if (key === "Parent" && nameOf(ref(dict, "Subtype")) !== "Popup") continue

			const linked = numOf(ref(dict, key))
			const made = linked === null ? undefined : copies.get(linked)

			if (made !== undefined) deref(copy).put(key, made)
		}
	}

	for (const { dict, copy } of sources) {
		// A popup whose annotation was not copied goes too.
		if (nameOf(ref(dict, "Subtype")) === "Popup" && at(copy, "Parent").isNull()) continue

		annots.push(copy)
	}

	if (annots.length > 0) deref(targetPage).put("Annots", annots)

	if (flatten.length > 0) {
		const taken = new Set<string>()
		const xobjects = new Map<string, PDFObject>()
		let content = ""

		for (const { stream, matrix } of flatten) {
			const key = freeXObjectName(targetPage, "FlSig", taken)

			xobjects.set(key, stream)
			content += `q ${matrix.map(formatNumber).join(" ")} cm /${key} Do Q\n`
		}

		appendPageContent(context.target, targetPage, content, xobjects)
	}
}

function copyableLink(context: Context, dict: PDFObject): boolean {
	const dest = ref(dict, "Dest")

	if (!dest.isNull()) return remapDest(context, dest) !== null

	const action = ref(dict, "A")

	return !action.isNull() && remapAction(context, action) !== null
}

// A copy of the annotation as a new object in the target, its links rebuilt; /Parent of a widget and /Popup, /IRT
// are linked afterwards.
function copyAnnot(context: Context, dict: PDFObject, targetPage: PDFObject): PDFObject | null {
	const copy = context.source.newDictionary()
	const widget = nameOf(ref(dict, "Subtype")) === "Widget"
	const merged = widget && at(dict, "Parent").isNull()

	dict.forEach((value, key) => {
		if (typeof key !== "string" || ANNOT_REBUILT.has(key)) return
		// A signed value never travels (it signs other bytes and links the source's catalog).
		if (key === "V" && merged && fieldType(dict) === "Sig") return

		copy.put(key, value)
	})

	const made = context.target.addObject(graft(context, copy))

	made.put("P", targetPage)

	const dest = ref(dict, "Dest")
	const remappedDest = dest.isNull() ? null : remapDest(context, dest)

	if (remappedDest !== null) made.put("Dest", remappedDest)

	const action = ref(dict, "A")
	const remappedAction = action.isNull() ? null : remapAction(context, action)

	if (remappedAction !== null) made.put("A", remappedAction)

	const additional = ref(dict, "AA")
	const remappedAdditional = additional.isNull() ? null : remapAdditional(context, additional)

	if (remappedAdditional !== null) made.put("AA", remappedAdditional)

	return made
}

// Links a copied widget into a copy of its field hierarchy (made once per field, holding only copied widgets).
function attachWidget(context: Context, source: PDFObject, copy: PDFObject): void {
	let child = copy
	let node = at(source, "Parent")
	let nodeRef = ref(source, "Parent")

	if (node.isNull()) {
		// A merged field and widget: a root field itself.
		context.roots.push(copy)

		return
	}

	for (let depth = 0; depth < MAX_DEPTH && node.isDictionary(); depth++) {
		const num = numOf(nodeRef)
		const existing = num === null ? undefined : context.fields.get(num)

		if (existing !== undefined) {
			ensureArray(context.target, existing, "Kids").push(child)
			deref(child).put("Parent", existing)

			return
		}

		const field = copyField(context, node)

		if (num !== null) context.fields.set(num, field)

		ensureArray(context.target, field, "Kids").push(child)
		deref(child).put("Parent", field)
		child = field
		nodeRef = ref(node, "Parent")
		node = at(node, "Parent")
	}

	context.roots.push(child)
}

function copyField(context: Context, node: PDFObject): PDFObject {
	const copy = context.source.newDictionary()
	const signature = nameOf(ref(node, "FT")) === "Sig"

	node.forEach((value, key) => {
		if (typeof key !== "string" || FIELD_REBUILT.has(key)) return
		if (key === "V" && signature) return

		copy.put(key, value)
	})

	const made = context.target.addObject(graft(context, copy))
	const additional = ref(node, "AA")
	const remapped = additional.isNull() ? null : remapAdditional(context, additional)

	if (remapped !== null) made.put("AA", remapped)

	return made
}

// The visible normal appearance of a signed signature widget, grafted, with the matrix that draws it in its Rect;
// null for an invisible or hidden one.
function signatureAppearance(context: Context, dict: PDFObject): { readonly stream: PDFObject; readonly matrix: PdfMatrix } | null {
	const flags = at(dict, "F")
	// Hidden (2) or NoView (32): nothing shows.
	if (flags.isInteger() && (flags.asNumber() & (2 | 32)) !== 0) return null

	let normal = ref(dict, "AP", "N")
	const state = nameOf(ref(dict, "AS"))

	// A stream is one only through its reference (MuPDF keeps the data in the xref entry, not the dictionary).
	if (!normal.isStream() && deref(normal).isDictionary()) normal = ref(normal, state ?? "Off")

	const stream = deref(normal)
	const rect = numbers(ref(dict, "Rect"))

	if (!normal.isStream() || rect?.length !== 4) return null

	const bbox = numbers(ref(stream, "BBox"))
	const own = numbers(ref(stream, "Matrix"))
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = own?.length === 6 ? own : []
	const matrix = appearanceMatrix(bbox ?? [0, 0, 0, 0], [a, b, c, d, e, f], rect)

	return matrix === null ? null : { stream: graft(context, normal), matrix }
}

// Adds the copied root fields to the target's /AcroForm (made when missing), renaming a root whose name is taken, and
// carries the source form's defaults (DA, Q, NeedAppearances) and default resources' fonts.
function registerFields(context: Context): void {
	if (context.roots.length === 0) return

	const root = catalog(context.target)
	let form = at(root, "AcroForm")

	if (!form.isDictionary()) {
		form = context.target.addObject(context.target.newDictionary())
		root.put("AcroForm", form)
	}

	const fields = ensureArray(context.target, form, "Fields")
	const taken = new Set<string>()

	for (const field of items(fields)) {
		const name = at(field, "T")

		if (name.isString()) taken.add(name.asString())
	}

	for (const field of context.roots) {
		const name = at(field, "T")

		if (name.isString() && taken.has(name.asString())) {
			let index = 2

			while (taken.has(`${name.asString()}_${String(index)}`)) index++

			deref(field).put("T", context.target.newString(`${name.asString()}_${String(index)}`))
		}

		const final = at(field, "T")

		if (final.isString()) taken.add(final.asString())

		fields.push(field)
	}

	const sourceForm = at(catalog(context.source), "AcroForm")

	for (const key of ["DA", "Q", "NeedAppearances"]) {
		const value = at(sourceForm, key)

		if (!value.isNull() && at(form, key).isNull()) form.put(key, graft(context, value))
	}

	const sourceFonts = at(sourceForm, "DR", "Font")

	if (sourceFonts.isDictionary()) {
		const resources = at(form, "DR").isDictionary() ? at(form, "DR") : context.target.newDictionary()
		const fonts = at(resources, "Font").isDictionary() ? at(resources, "Font") : context.target.newDictionary()

		sourceFonts.forEach((value, key) => {
			if (typeof key === "string" && at(fonts, key).isNull()) fonts.put(key, graft(context, value))
		})

		resources.put("Font", fonts)
		form.put("DR", resources)
	}

	if (context.roots.some(field => fieldType(deref(field)) === "Sig" || hasSignatureKid(deref(field), 0))) {
		const flags = at(form, "SigFlags")

		form.put("SigFlags", (flags.isInteger() ? flags.asNumber() : 0) | 1)
	}
}

function hasSignatureKid(field: PDFObject, depth: number): boolean {
	if (depth > MAX_DEPTH) return false

	return items(ref(field, "Kids")).some(kid => {
		const dict = deref(kid)

		return nameOf(ref(dict, "FT")) === "Sig" || hasSignatureKid(dict, depth + 1)
	})
}
