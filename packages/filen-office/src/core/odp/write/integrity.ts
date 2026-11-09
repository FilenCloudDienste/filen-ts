import { refused, type Deck, type Refused, type SlideRef } from "../../presentation/model"
import { XmlEditor, escapeAttribute, type XmlDocument } from "../../xml/index"
import { newSettingsAttributes, type SettingsAttribute } from "./emit/presentation"

// The references between pages an ODP save keeps whole (ODF 1.3 Part 3 §9.7 presentation:show, §19.416
// presentation:pages; §10.4.3 and §6.1.8 page links "#name"; §19.914 xml:id, §19.135 draw:id):
//   - every page has a draw:name unique in the document: a duplicated page gets a free one (the source's name with a
//     number), so links and custom shows naming the original still name it;
//   - custom shows list the names of the pages they hold, as the deck now has them (a deleted page leaves them);
//   - the show's start page, when it is gone, is no longer named;
//   - a copied page's xml:id and draw:id values are renamed (an ID is unique in the document) and the references
//     inside the copy to them follow (animation targets and timing, connector ends, caption ids).

// The pages' names after the save: each page's own, a duplicate's made unique.
export function pageNames(
	deck: Deck,
	nameOf: (ref: SlideRef) => string | undefined,
	owns: (ref: SlideRef) => boolean = () => false
): Map<SlideRef, string> {
	const out = new Map<SlideRef, string>()
	const used = new Set<string>()
	const later: SlideRef[] = []

	// A page the file already names so keeps its name first (the jumps to it name it); then the rest keep theirs in
	// order; a name already taken (a duplicate's) is given anew after.
	for (const ref of deck.slides) {
		const name = nameOf(ref)

		if (name === undefined || name === "" || used.has(name) || !owns(ref)) continue

		used.add(name)
		out.set(ref, name)
	}

	for (const ref of deck.slides) {
		if (out.has(ref)) continue

		const name = nameOf(ref)

		if (name === undefined || name === "" || used.has(name)) {
			later.push(ref)

			continue
		}

		used.add(name)
		out.set(ref, name)
	}

	// Where each base's numbering goes on (a number already tried is taken for good: names are only ever added), so
	// many pages sharing a name are numbered in one pass, not each from 2 again; an unnamed page's number starts at its
	// place, found by index.
	const next = new Map<string, number>()
	const place = later.length === 0 ? undefined : new Map(deck.slides.map((ref, at) => [ref, at]))

	for (const ref of later) {
		const base = (nameOf(ref) ?? "").replace(/ \(\d+\)$/u, "")
		const stem = base === "" ? "page" : base
		let count = base === "" ? (place?.get(ref) ?? 0) + 1 : (next.get(base) ?? 2)
		let name = base === "" ? `${stem}${String(count)}` : `${stem} (${String(count)})`

		while (used.has(name)) {
			count++
			name = base === "" ? `${stem}${String(count)}` : `${stem} (${String(count)})`
		}

		if (base !== "") next.set(base, count + 1)

		used.add(name)
		out.set(ref, name)
	}

	return out
}

const ID_ATTRIBUTES: ReadonlySet<string> = new Set(["xml:id", "draw:id", "text:id"])
// Elements whose draw:id is a number local to its shape (§19.135: a glue point's), not a document ID.
const LOCAL_IDS: ReadonlySet<string> = new Set(["draw:glue-point"])
// Attributes holding an ID of the same page (IDREF), by their local names in the namespaces ODF defines them in.
const IDREF_ATTRIBUTES: ReadonlySet<string> = new Set([
	"smil:targetElement",
	"anim:sub-item",
	"draw:start-shape",
	"draw:end-shape",
	"draw:caption-id",
	"presentation:master-element",
	"draw:chain-next-name"
])
// SMIL begin/end lists, whose syncbase and event values name an ID ("id2.click", "pid1.begin+0.5s").
const TIMING_ATTRIBUTES: ReadonlySet<string> = new Set(["smil:begin", "smil:end"])

// A begin/end list with each value naming a renamed ID renamed; undefined when none does. An ID is an NCName and may
// hold '.', so the longest renamed prefix followed by '.' is the ID; other values (clock, next, indefinite) stay.
function renamedTiming(value: string, renamed: ReadonlyMap<string, string>): string | undefined {
	if (!value.includes(".")) return undefined

	const tokens = value.split(";")
	let changed = false

	for (const [index, token] of tokens.entries()) {
		const start = token.length - token.trimStart().length

		for (let dot = token.lastIndexOf("."); dot > start; dot = token.lastIndexOf(".", dot - 1)) {
			const next = renamed.get(token.slice(start, dot))

			if (next === undefined) continue

			tokens[index] = token.slice(0, start) + next + token.slice(dot)
			changed = true

			break
		}
	}

	return changed ? tokens.join(";") : undefined
}

// A copied page's IDs renamed (`taken`: the IDs in use in the document, grown by the new ones) and its references
// to them following. `canonical(document, node, attribute)` gives an attribute's canonical name.
export function renameIds(
	document: XmlDocument,
	root: number,
	taken: Set<string>,
	canonical: (node: number, name: string) => string,
	elementName: (node: number) => string
): XmlEditor | undefined {
	const renamed = new Map<string, string>()
	const visit = (node: number, depth: number, act: (node: number) => void): void => {
		if (depth > 256) return

		act(node)

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
			visit(child, depth + 1, act)
	}

	visit(root, 0, node => {
		if (LOCAL_IDS.has(elementName(node))) return

		for (const attribute of document.attributes(node)) {
			if (!ID_ATTRIBUTES.has(canonical(node, attribute.name))) continue

			const old = attribute.value

			if (renamed.has(old)) continue

			let k = 2
			let name = `${old}_${String(k)}`

			while (taken.has(name)) name = `${old}_${String(++k)}`

			taken.add(name)
			renamed.set(old, name)
		}
	})

	if (renamed.size === 0) return undefined

	const editor = new XmlEditor(document)

	visit(root, 0, node => {
		if (LOCAL_IDS.has(elementName(node))) return

		for (const attribute of document.attributes(node)) {
			const name = canonical(node, attribute.name)

			if (ID_ATTRIBUTES.has(name) || IDREF_ATTRIBUTES.has(name)) {
				const value = attribute.value
				const next = name === "anim:sub-item" ? undefined : renamed.get(value)

				if (next !== undefined) editor.setAttribute(node, attribute.name, next)
			} else if (TIMING_ATTRIBUTES.has(name)) {
				const next = renamedTiming(attribute.value, renamed)

				if (next !== undefined) editor.setAttribute(node, attribute.name, next)
			}
		}
	})

	return editor
}

// presentation:settings rewritten for the deck: each custom show's page list by the pages' names now, the start page
// dropped when its page is gone, and with `show` (an edited Set Up Slide Show) its attributes saying it, written in
// the presentation namespace's `prefix`. `settings` is the element parsed on its own (with its scope's declarations).
export function settingsMarkup(
	document: XmlDocument,
	node: number,
	deck: Deck,
	names: ReadonlyMap<SlideRef, string>,
	canonical: (node: number, name: string) => string,
	nameOf: (node: number) => string,
	show?: { readonly attributes: readonly SettingsAttribute[]; readonly prefix: string }
): Uint8Array | Refused {
	const editor = new XmlEditor(document)
	const shows = new Map(deck.customShows.map(show => [show.name, show]))
	const present = new Set(names.values())
	const written = new Set<string>()
	let changed = false

	for (const attribute of document.attributes(node)) {
		if (canonical(node, attribute.name) === "presentation:start-page" && !present.has(attribute.value)) {
			editor.removeAttribute(node, attribute.name)
			changed = true
		}
	}

	for (const wanted of show?.attributes ?? []) {
		const qualified = `presentation:${wanted.local}`
		const current = document.attributes(node).find(attribute => canonical(node, attribute.name) === qualified)

		if (wanted.holds(current?.value)) continue

		if (wanted.value === undefined) {
			if (current !== undefined) editor.removeAttribute(node, current.name)
		} else {
			editor.setAttribute(node, current?.name ?? `${show?.prefix ?? "presentation"}:${wanted.local}`, wanted.value)
		}

		changed = true
	}

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (nameOf(child) !== "presentation:show") continue

		let showName: string | undefined
		let pagesAttribute: { name: string; value: string } | undefined

		for (const attribute of document.attributes(child)) {
			const name = canonical(child, attribute.name)

			if (name === "presentation:name") showName = attribute.value
			else if (name === "presentation:pages") pagesAttribute = attribute
		}

		const show = showName === undefined ? undefined : shows.get(showName)

		if (show === undefined) {
			// A show the deck no longer has (none is deleted by any op today): kept as written.
			continue
		}

		written.add(show.name)

		const pages = show.slides
			.map(ref => names.get(ref))
			.filter(name => name !== undefined)
			.join(",")

		if (pagesAttribute?.value === pages) continue

		if (pagesAttribute === undefined) editor.setAttribute(child, "presentation:pages", pages)
		else editor.setAttribute(child, pagesAttribute.name, pages)

		changed = true
	}

	for (const show of deck.customShows) {
		if (written.has(show.name)) continue

		return refused("unsupported", `a custom show the file does not have (${show.name})`)
	}

	if (!changed) return document.raw(node)

	const out = editor.serialize()

	return out.subarray(document.start(node), out.length - (document.bytes.length - document.end(node)))
}

// A custom show list and the edited show's attributes as new markup (a deck whose content.xml has no
// presentation:settings), in the presentation namespace's `prefix`.
export function newSettingsMarkup(
	deck: Deck,
	names: ReadonlyMap<SlideRef, string>,
	prefix = "presentation",
	show?: readonly SettingsAttribute[]
): string {
	const attributes = show === undefined ? "" : newSettingsAttributes(show, prefix)

	if (deck.customShows.length === 0 && attributes === "") return ""

	const shows = deck.customShows
		.map(
			show =>
				`<${prefix}:show ${prefix}:name="${escapeAttribute(show.name)}" ${prefix}:pages="${escapeAttribute(
					show.slides
						.map(ref => names.get(ref))
						.filter(name => name !== undefined)
						.join(",")
				)}"/>`
		)
		.join("")

	return `<${prefix}:settings${attributes}>${shows}</${prefix}:settings>`
}
