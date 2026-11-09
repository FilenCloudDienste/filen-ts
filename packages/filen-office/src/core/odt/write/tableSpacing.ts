import type { XmlDocument } from "../../xml/index"
import type { OdtTableSpacing } from "../types"
import type { PropertyValue, Props, StyleChains } from "./meaning"

// A table's space above and below (fo:margin-top/bottom) as a save writes it. The translation adds it to the
// paragraph beside the table in the body (Translator.spaceTable); a paragraph written from the edit has that space
// taken out again, so reading the file again adds it once. Where the edit leaves less space beside a table than the
// table's own (a paragraph moved or deleted, its space lowered), the table is written with what the edit shows.

// Twips a paragraph's space above (`before`, the table before it) and below (`after`, the table after it) owe tables.
export interface SpacingShift {
	readonly before: number
	readonly after: number
}

function childNamed(document: XmlDocument, node: number, local: string): number {
	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === local) return child
	}

	return -1
}

function isParagraph(document: XmlDocument, node: number | undefined): node is number {
	return node !== undefined && node >= 0 && document.localName(node) === "p"
}

// A paragraph ending a section takes no space above a table (the table starts a page of its own).
function endsSection(document: XmlDocument, paragraph: number): boolean {
	const pPr = childNamed(document, paragraph, "pPr")

	return pPr >= 0 && childNamed(document, pPr, "sectPr") >= 0
}

// The empty paragraph a translation adds after a table to end a section: no paragraph of the source.
function sectionCarrier(document: XmlDocument, paragraph: number): boolean {
	const pPr = document.firstChildElement(paragraph)

	return (
		pPr >= 0 &&
		document.localName(pPr) === "pPr" &&
		document.nextSiblingElement(pPr) < 0 &&
		document.localName(document.firstChildElement(pPr)) === "sectPr" &&
		document.nextSiblingElement(document.firstChildElement(pPr)) < 0
	)
}

function add(shifts: Map<number, SpacingShift>, paragraph: number, before: number, after: number): void {
	const known = shifts.get(paragraph)

	shifts.set(paragraph, { before: (known?.before ?? 0) + before, after: (known?.after ?? 0) + after })
}

export interface SpacingBody {
	readonly tBody: XmlDocument
	readonly eBody: XmlDocument
	readonly tBlocks: readonly number[]
	readonly eBlocks: readonly number[]
}

export class TableSpacing {
	// What each paragraph of the translation and of the edit owes the tables beside it.
	private readonly tShifts = new Map<number, SpacingShift>()
	private readonly eShifts = new Map<number, SpacingShift>()
	// Translated tables (w:tbl) written with less space than their source's, and the space they keep.
	readonly reduced = new Map<number, OdtTableSpacing>()
	private readonly body: SpacingBody

	// `match`: each translated block's edited block (-1: none), in order.
	constructor(body: SpacingBody, spacing: ReadonlyMap<number, OdtTableSpacing>, match: Int32Array, chains: StyleChains) {
		this.body = body

		const { tBody, eBody, tBlocks, eBlocks } = body

		for (const [index, space] of spacing) {
			const before = tBlocks[index - 1]
			const after = tBlocks[index + 1]

			if (space.top > 0 && isParagraph(tBody, before) && !endsSection(tBody, before)) add(this.tShifts, before, 0, space.top)
			if (space.bottom > 0 && isParagraph(tBody, after) && !sectionCarrier(tBody, after)) add(this.tShifts, after, space.bottom, 0)

			const edited = this.editedTable(index, match)
			const table = tBlocks[index] ?? -1

			if (edited < 0) continue

			const above = eBlocks[edited - 1]
			const below = eBlocks[edited + 1]
			let top = space.top
			let bottom = space.bottom

			if (top > 0 && isParagraph(eBody, above) && !endsSection(eBody, above)) {
				top = Math.min(top, shown(eBody, above, "after", chains))
				add(this.eShifts, above, 0, top)
			}

			if (bottom > 0 && isParagraph(eBody, below) && !sectionCarrier(eBody, below)) {
				bottom = Math.min(bottom, shown(eBody, below, "before", chains))
				add(this.eShifts, below, bottom, 0)
			}

			if (top !== space.top || bottom !== space.bottom) this.reduced.set(table, { top, bottom })
		}
	}

	// The edited block a translated table became: the one matched with it, else the one in its place among the
	// unmatched tables between the matched blocks around it (as a rewrite pairs them).
	private editedTable(index: number, match: Int32Array): number {
		const { tBody, eBody, tBlocks, eBlocks } = this.body
		const matched = match[index] ?? -1

		if (matched >= 0) return eDocTable(eBody, eBlocks, matched)

		let from = index - 1

		while (from >= 0 && (match[from] ?? -1) < 0) from--

		let to = index + 1

		while (to < tBlocks.length && (match[to] ?? -1) < 0) to++

		let rank = 0

		for (let k = from + 1; k < index; k++) if (tBody.localName(tBlocks[k] ?? -1) === "tbl") rank++

		const end = to < tBlocks.length ? (match[to] ?? eBlocks.length) : eBlocks.length

		for (let k = from < 0 ? 0 : (match[from] ?? -1) + 1; k < end; k++) {
			if (eBody.localName(eBlocks[k] ?? -1) !== "tbl") continue
			if (rank === 0) return k

			rank--
		}

		return -1
	}

	// What a paragraph of the translation (tBody) or the edit (eBody) owes the tables beside it; undefined: nothing.
	shift(document: XmlDocument, paragraph: number): SpacingShift | undefined {
		if (document === this.body.eBody) return this.eShifts.get(paragraph)
		if (document === this.body.tBody) return this.tShifts.get(paragraph)

		return undefined
	}
}

function eDocTable(eBody: XmlDocument, eBlocks: readonly number[], index: number): number {
	return eBody.localName(eBlocks[index] ?? -1) === "tbl" ? index : -1
}

// A paragraph's space above or below as the edit shows it (twips).
function shown(document: XmlDocument, paragraph: number, side: "before" | "after", chains: StyleChains): number {
	const pPr = childNamed(document, paragraph, "pPr")
	const own = pPr < 0 ? -1 : childNamed(document, pPr, "spacing")
	const style = pPr < 0 ? -1 : childNamed(document, pPr, "pStyle")
	const value =
		(own < 0 ? undefined : document.attribute(own, `w:${side}`)) ??
		chains
			.paragraph(style < 0 ? undefined : document.attribute(style, "w:val"))
			.pPr.get("spacing")
			?.attributes.get(side)

	return Math.max(0, Number(value ?? "0") || 0)
}

// Paragraph properties less what tables beside it add, both sides then its own (`inherited`: its style's spacing).
export function withoutTableSpacing(props: Props, shift: SpacingShift, inherited: PropertyValue | undefined): Props {
	const own = props.get("spacing")
	const attributes = new Map(own?.attributes ?? [])

	for (const [side, by] of [
		["before", shift.before],
		["after", shift.after]
	] as const) {
		const value = Number(attributes.get(side) ?? inherited?.attributes.get(side) ?? "0") || 0

		attributes.set(side, String(Math.max(0, value - by)))
	}

	const out: Props = new Map(props)

	out.set("spacing", { attributes, children: own?.children ?? "" })

	return out
}
