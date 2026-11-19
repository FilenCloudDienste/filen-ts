import type { SheetRange } from "../../sheet/protocol"
import { decodeUtf8, encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../xml/index"
import { encodeXstring } from "../edit/document"
import { newGuid } from "../edit/sheetCopy"
import { decodeXstring } from "../model/strings"
import { intersects } from "../refs/moveRefs"
import { parseRangeRef, rangeRef } from "../write/text"

// A sheet's hyperlinks section (ECMA-376 Part 1 §18.3.1.47, §18.3.1.48): each link a range, an external target
// through a relationship (r:id) and/or a location in the workbook, with an optional tooltip and display string.
// Edited by rebuilding the section from its links: those not edited keep their markup as written, one cut by an edit
// is written once per piece left (each piece its own uid).

export interface LinkEntry {
	readonly range: SheetRange
	readonly relationshipId: string | null
	readonly location: string | null
	readonly tooltip: string | null
	readonly display: string | null
	// The element as written.
	readonly markup: string
}

export interface LinksSection {
	// The section's start tag (with its declarations) and end tag, from the first occurrence.
	readonly open: string
	readonly close: string
	readonly prefix: string
	// The prefix the links' relationship ids carry ("r" as Excel writes them) where the section or the root declares
	// it, null when no link's is (a link added then declares the prefix on itself).
	readonly relationshipPrefix: string | null
	readonly links: readonly LinkEntry[]
}

function attribute(document: XmlDocument, node: number, local: string): { name: string; value: string } | null {
	for (const found of document.attributes(node)) {
		const colon = found.name.indexOf(":")

		if ((colon < 0 ? found.name : found.name.slice(colon + 1)) === local && (local !== "id" || colon > 0)) return found
	}

	return null
}

const cache = new WeakMap<readonly string[], LinksSection | null>()

// The links of a section's occurrences (one, as written; more are read in order). Links whose ref does not read are
// kept as written but take no cells.
export function readLinks(occurrences: readonly string[]): LinksSection | null {
	if (cache.has(occurrences)) return cache.get(occurrences) ?? null

	let section: LinksSection | null = null

	// An occurrence an edit emptied (a structure edit that dropped every link) holds nothing.
	const written = occurrences.filter(markup => markup.trim() !== "")

	if (written.length > 0) {
		const links: LinkEntry[] = []
		let open = ""
		let close = ""
		let prefix = ""
		let relationshipPrefix: string | null = null

		written.forEach((markup, index) => {
			const document = parseXml(encodeUtf8(markup))
			const root = document.documentElement()
			const name = document.name(root)

			if (index === 0) {
				const colon = name.indexOf(":")

				prefix = colon < 0 ? "" : name.slice(0, colon + 1)
				open = decodeUtf8(document.bytes.subarray(document.start(root), document.openEnd(root)))
				close = `</${name}>`

				if (document.isSelfClosing(root)) open = `${open.slice(0, -2).trimEnd()}>`
			}

			for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
				if (document.localName(node) !== "hyperlink") continue

				const id = attribute(document, node, "id")
				const range = parseRangeRef(document.attribute(node, "ref") ?? "")

				// A prefix the link declares itself is not in scope for its siblings (Namespaces in XML 1.0 §6.1).
				if (id !== null && relationshipPrefix === null) {
					const own = id.name.slice(0, id.name.indexOf(":"))

					if (document.attribute(node, `xmlns:${own}`) === undefined) relationshipPrefix = own
				}

				const text = (local: string): string | null => {
					const value = document.attribute(node, local)

					return value === undefined ? null : decodeXstring(value)
				}

				links.push({
					range: range ?? { startRow: -1, startCol: -1, endRow: -1, endCol: -1 },
					relationshipId: id?.value ?? null,
					location: text("location"),
					tooltip: text("tooltip"),
					display: text("display"),
					markup: decodeUtf8(document.raw(node))
				})
			}
		})

		section = { open, close, prefix, relationshipPrefix, links }
	}

	cache.set(occurrences, section)

	return section
}

export function linkAt(section: LinksSection | null, row: number, col: number): LinkEntry | null {
	for (const link of section?.links ?? [])
		if (row >= link.range.startRow && row <= link.range.endRow && col >= link.range.startCol && col <= link.range.endCol) return link

	return null
}

// What is left of `range` once `cut` is taken out: up to four ranges (the rows above and below, then the columns
// either side).
export function subtract(range: SheetRange, cut: SheetRange): SheetRange[] {
	if (!intersects(range, cut)) return [range]

	const out: SheetRange[] = []
	const top = Math.max(range.startRow, cut.startRow)
	const bottom = Math.min(range.endRow, cut.endRow)

	if (range.startRow < cut.startRow) out.push({ ...range, endRow: cut.startRow - 1 })
	if (range.endRow > cut.endRow) out.push({ ...range, startRow: cut.endRow + 1 })
	if (range.startCol < cut.startCol) out.push({ startRow: top, endRow: bottom, startCol: range.startCol, endCol: cut.startCol - 1 })
	if (range.endCol > cut.endCol) out.push({ startRow: top, endRow: bottom, startCol: cut.endCol + 1, endCol: range.endCol })

	return out
}

// A link's element for another range: its ref replaced, a uid of the revision namespace made new.
function moved(link: LinkEntry, range: SheetRange, fresh: boolean): string {
	let markup = link.markup.replace(/(\sref\s*=\s*)(["'])[^"']*\2/, `$1"${rangeRef(range)}"`)

	if (fresh) markup = markup.replace(/(\s[A-Za-z_][\w.-]*:uid\s*=\s*)(["'])[^"']*\2/, (_, head: string) => `${head}"${newGuid()}"`)

	return markup
}

export interface NewLink {
	readonly range: SheetRange
	readonly relationshipId: string | null
	readonly location: string | null
	readonly tooltip: string | null
	readonly display: string | null
}

export interface LinksEdit {
	// The section's occurrences after the edit ([] when no link is left).
	readonly occurrences: readonly string[]
	// Relationship ids no link refers to any more.
	readonly released: readonly string[]
	// Whether anything changed.
	readonly changed: boolean
}

export interface LinksCut {
	// The markup of the links left, those cut by the ranges as their pieces.
	readonly kept: readonly string[]
	readonly before: ReadonlySet<string>
	readonly after: ReadonlySet<string>
	readonly changed: boolean
}

// The links over `ranges` taken out (those reaching past them keep the rest).
export function cutLinks(section: LinksSection | null, ranges: readonly SheetRange[]): LinksCut {
	const kept: string[] = []
	const before = new Set<string>()
	const after = new Set<string>()
	let changed = false

	for (const link of section?.links ?? []) {
		if (link.relationshipId !== null) before.add(link.relationshipId)

		let pieces = [link.range]

		if (link.range.startRow >= 0) for (const range of ranges) pieces = pieces.flatMap(piece => subtract(piece, range))

		if (pieces.length === 1 && pieces[0] === link.range) {
			kept.push(link.markup)

			if (link.relationshipId !== null) after.add(link.relationshipId)

			continue
		}

		changed = true
		pieces.forEach((piece, k) => kept.push(moved(link, piece, k > 0)))

		if (pieces.length > 0 && link.relationshipId !== null) after.add(link.relationshipId)
	}

	return { kept, before, after, changed }
}

// The links over `ranges` taken out (those reaching past them keep the rest), then `added` put in.
export function editLinks(
	section: LinksSection | null,
	ranges: readonly SheetRange[],
	added: readonly NewLink[],
	relationshipsNamespace: string,
	sheetPrefix: string,
	cut: LinksCut = cutLinks(section, ranges)
): LinksEdit {
	const kept = [...cut.kept]
	const after = new Set(cut.after)
	const before = cut.before
	const changed = cut.changed || added.length > 0

	const prefix = section?.prefix ?? sheetPrefix
	const relationshipPrefix = section?.relationshipPrefix ?? null

	for (const link of added) {
		let markup = `<${prefix}hyperlink ref="${rangeRef(link.range)}"`

		if (link.relationshipId !== null) {
			markup +=
				relationshipPrefix === null
					? ` xmlns:r="${relationshipsNamespace}" r:id="${escapeAttribute(link.relationshipId)}"`
					: ` ${relationshipPrefix}:id="${escapeAttribute(link.relationshipId)}"`
			after.add(link.relationshipId)
		}

		if (link.location !== null) markup += ` location="${escapeAttribute(encodeXstring(link.location))}"`
		if (link.tooltip !== null) markup += ` tooltip="${escapeAttribute(encodeXstring(link.tooltip))}"`
		if (link.display !== null) markup += ` display="${escapeAttribute(encodeXstring(link.display))}"`

		kept.push(`${markup}/>`)
	}

	const open = section?.open ?? `<${prefix}hyperlinks>`
	const close = section?.close ?? `</${prefix}hyperlinks>`

	return {
		occurrences: kept.length === 0 ? [] : [`${open}${kept.join("")}${close}`],
		released: [...before].filter(id => !after.has(id)),
		changed
	}
}
