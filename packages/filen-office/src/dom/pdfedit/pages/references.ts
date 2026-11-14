import type { PDFDocument, PDFObject } from "mupdf"
import {
	at,
	catalog,
	deref,
	destPageNum,
	items,
	MAX_DEPTH,
	MAX_NODES,
	nameOf,
	namedDests,
	numOf,
	pageAnnots,
	ref,
	targetDest,
	type NamedDests
} from "./objects"

// What deleting pages leaves pointing at them, removed: outline items (an item with surviving children stays as a
// heading without a destination), link annotations and GoTo actions on the remaining pages, named destinations, an
// OpenAction, form fields whose widgets were on those pages, and the structure tree's elements, ParentTree and IDTree
// entries for them. MuPDF's deletePage leaves all of these dangling; rearrangePages handles some but rewrites the
// catalog outside the journal (it drops AcroForm, StructTreeRoot, PageLabels…), so it is never used on a live document.

// What a deletion takes, read before the pages go: their object numbers, their annotations' object numbers and the
// ParentTree keys their content and annotations use.
export interface RemovedPages {
	readonly pages: ReadonlySet<number>
	readonly annots: ReadonlySet<number>
	readonly structKeys: ReadonlySet<number>
}

export function collectRemoved(doc: PDFDocument, indices: readonly number[]): RemovedPages {
	const pages = new Set<number>()
	const annots = new Set<number>()
	const structKeys = new Set<number>()

	for (const index of indices) {
		const page = doc.findPage(index)
		const num = numOf(page)

		if (num !== null) pages.add(num)

		const key = at(page, "StructParents")

		if (key.isInteger()) structKeys.add(key.asNumber())

		for (const annot of pageAnnots(page)) {
			const annotNum = numOf(annot)
			const annotKey = at(annot, "StructParent")

			if (annotNum !== null) annots.add(annotNum)
			if (annotKey.isInteger()) structKeys.add(annotKey.asNumber())
		}
	}

	return { pages, annots, structKeys }
}

// Removes every reference to the removed pages (call after deleting them, inside the same operation).
export function pruneReferences(doc: PDFDocument, removed: RemovedPages): void {
	if (removed.pages.size === 0) return

	const named = namedDests(doc)
	const dead = (holder: PDFObject): boolean => {
		const dest = targetDest(holder)
		const page = dest === null ? null : destPageNum(dest, named)

		return page !== null && removed.pages.has(page)
	}

	pruneOutline(doc, dead)
	pruneLinks(doc, dead)
	pruneNamedDests(doc, removed, named)

	const root = catalog(doc)
	const open = ref(root, "OpenAction")

	if (!open.isNull() && dead(open)) root.delete("OpenAction")

	pruneFields(doc, removed)
	pruneStructure(doc, removed)
}

function pruneOutline(doc: PDFDocument, dead: (holder: PDFObject) => boolean): void {
	const root = at(catalog(doc), "Outlines")

	if (!root.isDictionary()) return

	const budget = { nodes: 0 }

	pruneOutlineChildren(root, dead, 0, budget)
	recountOutline(root, true, 0)
}

function pruneOutlineChildren(parent: PDFObject, dead: (holder: PDFObject) => boolean, depth: number, budget: { nodes: number }): void {
	if (depth > MAX_DEPTH) return

	const kept: PDFObject[] = []
	const seen = new Set<number>()
	let item = ref(parent, "First")

	while (!item.isNull() && budget.nodes++ < MAX_NODES) {
		const num = numOf(item)

		if (num !== null) {
			if (seen.has(num)) break

			seen.add(num)
		}

		const dict = deref(item)

		if (!dict.isDictionary()) break

		const next = ref(dict, "Next")

		pruneOutlineChildren(dict, dead, depth + 1, budget)

		if (dead(dict)) {
			if (!at(dict, "First").isNull()) {
				// A heading over surviving items: kept, going nowhere.
				dict.delete("Dest")
				dict.delete("A")
				kept.push(item)
			}
		} else kept.push(item)

		item = next
	}

	relink(parent, kept)
}

function relink(parent: PDFObject, kept: readonly PDFObject[]): void {
	const first = kept[0]
	const last = kept.at(-1)

	if (first === undefined || last === undefined) {
		parent.delete("First")
		parent.delete("Last")

		return
	}

	parent.put("First", first)
	parent.put("Last", last)
	kept.forEach((item, index) => {
		const dict = deref(item)
		const previous = kept[index - 1]
		const next = kept[index + 1]

		if (previous === undefined) dict.delete("Prev")
		else dict.put("Prev", previous)

		if (next === undefined) dict.delete("Next")
		else dict.put("Next", next)
	})
}

// Rewrites /Count from the children: open items count their visible descendants, closed ones the same negated; the
// root counts what is visible. Returns what the node adds to its parent's visible count.
function recountOutline(node: PDFObject, isRoot: boolean, depth: number): number {
	let visible = 0
	let item = ref(node, "First")
	const seen = new Set<number>()

	while (!item.isNull() && depth <= MAX_DEPTH) {
		const num = numOf(item)

		if (num !== null) {
			if (seen.has(num)) break

			seen.add(num)
		}

		const dict = deref(item)

		if (!dict.isDictionary()) break

		visible += 1 + recountOutline(dict, false, depth + 1)
		item = ref(dict, "Next")
	}

	const count = at(node, "Count")
	const open = isRoot || (count.isNumber() && count.asNumber() > 0)

	if (visible === 0) {
		if (isRoot) node.put("Count", 0)
		else node.delete("Count")

		return 0
	}

	node.put("Count", open ? visible : -visible)

	return open ? visible : 0
}

// Links to removed pages go; other annotations lose a GoTo action to one.
function pruneLinks(doc: PDFDocument, dead: (holder: PDFObject) => boolean): void {
	const count = doc.countPages()

	for (let index = 0; index < count; index++) {
		const page = doc.findPage(index)
		const annots = at(page, "Annots")

		if (!annots.isArray()) continue

		for (let slot = annots.length - 1; slot >= 0; slot--) {
			const annot = deref(annots.get(slot))

			if (!annot.isDictionary() || !dead(annot)) continue

			if (nameOf(ref(annot, "Subtype")) === "Link") annots.delete(slot)
			else {
				annot.delete("Dest")
				annot.delete("A")
			}
		}
	}
}

function pruneNamedDests(doc: PDFDocument, removed: RemovedPages, named: NamedDests): void {
	const root = catalog(doc)
	const old = at(root, "Dests")
	const deadDest = (value: PDFObject): boolean => {
		const page = destPageNum(value, named)

		return page !== null && removed.pages.has(page)
	}

	if (old.isDictionary()) {
		const keys: string[] = []

		old.forEach((value, key) => {
			if (typeof key === "string" && deadDest(value)) keys.push(key)
		})

		for (const key of keys) old.delete(key)
	}

	const tree = at(root, "Names", "Dests")

	if (tree.isDictionary()) filterTree(tree, "Names", value => !deadDest(value), true, 0)
}

// Filters a name or number tree in place, keeping entries `keep` accepts, emptied kids removed and /Limits rewritten
// from the entries left. Returns the node's first and last key objects, or null when it is empty.
export function filterTree(
	node: PDFObject,
	kind: "Names" | "Nums",
	keep: (value: PDFObject, key: PDFObject) => boolean,
	isRoot: boolean,
	depth: number
): readonly [PDFObject, PDFObject] | null {
	if (depth > MAX_DEPTH) return null

	let first: PDFObject | null = null
	let last: PDFObject | null = null
	const kids = at(node, "Kids")

	if (kids.isArray()) {
		for (let index = kids.length - 1; index >= 0; index--) {
			const kid = deref(kids.get(index))
			const limits = kid.isDictionary() ? filterTree(kid, kind, keep, false, depth + 1) : null

			if (limits === null) kids.delete(index)
			else {
				last ??= limits[1]
				first = limits[0]
			}
		}
	}

	const entries = at(node, kind)

	if (entries.isArray()) {
		for (let index = entries.length - 2; index >= 0; index -= 2) {
			if (!keep(entries.get(index + 1), deref(entries.get(index)))) {
				entries.delete(index + 1)
				entries.delete(index)
			}
		}

		if (entries.length >= 2) {
			first = deref(entries.get(0))
			last = deref(entries.get(entries.length - 2))
		}
	}

	if (first === null || last === null) {
		if (!isRoot) node.delete("Limits")

		return null
	}

	if (!isRoot) {
		const limits = at(node, "Limits")

		if (limits.isArray() && limits.length === 2) {
			limits.put(0, first)
			limits.put(1, last)
		}
	}

	return [first, last]
}

// Widgets on removed pages leave their fields; fields left without any widget leave the form.
function pruneFields(doc: PDFDocument, removed: RemovedPages): void {
	const form = at(catalog(doc), "AcroForm")
	const fields = at(form, "Fields")

	if (!fields.isArray()) return

	const gone = new Set<number>()
	const budget = { nodes: 0 }
	const keepNode = (node: PDFObject, depth: number): boolean => {
		const dict = deref(node)

		if (!dict.isDictionary() || depth > MAX_DEPTH || budget.nodes++ > MAX_NODES) return true

		const kids = at(dict, "Kids")
		let keep = true

		if (kids.isArray() && kids.length > 0) {
			for (let index = kids.length - 1; index >= 0; index--) {
				if (!keepNode(kids.get(index), depth + 1)) kids.delete(index)
			}

			keep = kids.length > 0
		} else if (nameOf(ref(dict, "Subtype")) === "Widget") {
			const num = numOf(node)
			const page = numOf(ref(dict, "P"))

			keep = !((num !== null && removed.annots.has(num)) || (page !== null && removed.pages.has(page)))
		}

		const num = numOf(node)

		if (!keep && num !== null) gone.add(num)

		return keep
	}

	for (let index = fields.length - 1; index >= 0; index--) {
		if (!keepNode(fields.get(index), 0)) fields.delete(index)
	}

	const order = at(form, "CO")

	if (order.isArray()) {
		for (let index = order.length - 1; index >= 0; index--) {
			const num = numOf(order.get(index))

			if (num !== null && gone.has(num)) order.delete(index)
		}
	}
}

// Structure elements whose marked content, annotations or page were on removed pages: content items dropped, elements
// left empty dropped, and their ParentTree and IDTree entries with them.
function pruneStructure(doc: PDFDocument, removed: RemovedPages): void {
	const root = at(catalog(doc), "StructTreeRoot")

	if (!root.isDictionary()) return

	const dropped = new Set<number>()
	const budget = { nodes: 0 }
	const onRemoved = (page: number | null): boolean => page !== null && removed.pages.has(page)
	// True when the kid stays.
	const keepKid = (kid: PDFObject, page: number | null, depth: number): boolean => {
		const resolved = deref(kid)

		if (resolved.isInteger()) return !onRemoved(page)
		if (!resolved.isDictionary()) return true

		const type = nameOf(ref(resolved, "Type"))
		const own = numOf(ref(resolved, "Pg")) ?? page

		if (type === "MCR") return !onRemoved(own)

		if (type === "OBJR") {
			const object = numOf(ref(resolved, "Obj"))

			return !onRemoved(own) && !(object !== null && removed.annots.has(object))
		}

		return keepElement(kid, page, depth + 1)
	}
	const keepElement = (element: PDFObject, inherited: number | null, depth: number): boolean => {
		const dict = deref(element)

		if (!dict.isDictionary() || depth > MAX_DEPTH || budget.nodes++ > MAX_NODES) return true

		const ownPage = numOf(ref(dict, "Pg"))
		const page = ownPage ?? inherited
		const kids = ref(dict, "K")
		const list = deref(kids).isArray() ? items(kids) : kids.isNull() ? [] : [kids]
		const kept = list.filter(kid => keepKid(kid, page, depth))
		const changed = kept.length !== list.length

		if (changed) {
			if (kept.length === 0) dict.delete("K")
			else if (kept.length === 1 && !deref(kids).isArray()) dict.put("K", kept[0])
			else {
				const array = doc.newArray()

				for (const kid of kept) array.push(kid)

				dict.put("K", array)
			}
		}

		const drop = (onRemoved(ownPage) || changed) && kept.length === 0

		if (drop) {
			const num = numOf(element)

			if (num !== null) dropped.add(num)

			return false
		}

		if (onRemoved(ownPage)) dict.delete("Pg")

		return true
	}

	keepElement(root, null, 0)

	const parentTree = at(root, "ParentTree")

	if (parentTree.isDictionary()) {
		filterTree(parentTree, "Nums", (_value, key) => !(key.isInteger() && removed.structKeys.has(key.asNumber())), true, 0)
	}

	const idTree = at(root, "IDTree")

	if (idTree.isDictionary() && dropped.size > 0) {
		filterTree(
			idTree,
			"Names",
			value => {
				const num = numOf(value)

				return num === null || !dropped.has(num)
			},
			true,
			0
		)
	}
}
