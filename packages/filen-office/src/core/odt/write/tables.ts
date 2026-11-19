import type { XmlDocument } from "../../xml/index"
import { ByteKeyMap } from "./byteKeys"
import { childNamed, readProps, type Props, type PropertyValue, type StyleChains } from "./meaning"

// A table as its cells show it (ECMA-376 Part 1 §17.4): each cell's borders and margins with the table's (its own
// tblBorders and tblCellMar, else its style's) where the cell sets none — the outer edges from the table's
// top/left/bottom/right, the inner ones from insideH/insideV — and its width as its grid columns'. ODF has borders
// and padding on cells only (Part 3 §17.18), so this is what the translation of a table written as ODF says.

export interface EffectiveCell {
	readonly node: number
	readonly column: number
	readonly span: number
	// tcPr as it takes effect: tcBorders and tcMar complete, tcW left out (the grid says it).
	readonly props: Props
}

export interface EffectiveRow {
	readonly node: number
	readonly trPr: Props
	readonly cells: readonly EffectiveCell[]
}

export interface EffectiveTable {
	readonly tblPr: Props
	readonly grid: readonly number[]
	readonly rows: readonly EffectiveRow[]
}

const SIDES = ["top", "left", "bottom", "right"] as const
const NO_BYTES = new Uint8Array(0)

// Sides of a tcBorders/tcMar/tblBorders/tblCellMar value, start and end as left and right.
function sides(value: PropertyValue | undefined): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>()

	if (value === undefined) return out

	for (const match of value.children.matchAll(/<([a-zA-Z]+)((?: [a-zA-Z:]+="[^"]*")*)>/gu)) {
		const local = match[1] ?? ""
		const side = local === "start" ? "left" : local === "end" ? "right" : local
		const attributes = new Map<string, string>()

		for (const pair of (match[2] ?? "").matchAll(/ ([a-zA-Z:]+)="([^"]*)"/gu)) attributes.set(pair[1] ?? "", pair[2] ?? "")

		out.set(side, attributes)
	}

	return out
}

function sideMarkup(entries: Map<string, Map<string, string>>): string {
	return [...entries]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(
			([side, attributes]) =>
				`<${side}${[...attributes]
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([name, value]) => ` ${name}=${JSON.stringify(value)}`)
					.join("")}>`
		)
		.join("")
}

// A border as it shows: none for nil or none, an automatic colour as black (the colour a border is drawn in).
function border(attributes: Map<string, string> | undefined): Map<string, string> | undefined {
	if (attributes === undefined) return undefined

	const value = attributes.get("val")

	if (value === undefined || value === "nil" || value === "none") return undefined

	const out = new Map(attributes)

	if ((out.get("color") ?? "auto") === "auto") out.set("color", "000000")
	if (out.get("space") === undefined) out.set("space", "0")

	return out
}

// `place`: where the rows `table` holds are among the table's own (a table written in pieces): the first's index
// among them, and how many it has.
export function effectiveTable(
	document: XmlDocument,
	table: number,
	chains: StyleChains,
	place?: { readonly offset: number; readonly total: number }
): EffectiveTable {
	const tblPr: Props = new Map()
	const tblPrNode = childNamed(document, table, "tblPr")

	if (tblPrNode >= 0) readProps(document, tblPrNode, tblPr)

	const style = chains.table(tblPr.get("tblStyle")?.attributes.get("val"))
	const tableBorders = sides(tblPr.get("tblBorders") ?? style.get("tblBorders"))
	const tableMargins = sides(tblPr.get("tblCellMar") ?? style.get("tblCellMar"))
	const grid: number[] = []
	const gridNode = childNamed(document, table, "tblGrid")

	for (let col = gridNode < 0 ? -1 : document.firstChildElement(gridNode); col >= 0; col = document.nextSiblingElement(col)) {
		if (document.localName(col) === "gridCol") grid.push(Number(document.attribute(col, "w:w") ?? "0"))
	}

	const rowNodes: number[] = []

	for (let child = document.firstChildElement(table); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === "tr") rowNodes.push(child)
	}

	const shared = new ByteKeyMap<{ readonly props: Props; readonly span: number }>(1 << 16)
	const rows: EffectiveRow[] = rowNodes.map((row, rowIndex) => {
		const trPr: Props = new Map()
		const trPrNode = childNamed(document, row, "trPr")

		if (trPrNode >= 0) readProps(document, trPrNode, trPr)

		const cells: EffectiveCell[] = []
		let column = 0

		for (let cell = document.firstChildElement(row); cell >= 0; cell = document.nextSiblingElement(cell)) {
			if (document.localName(cell) !== "tc") continue

			const tcPr = childNamed(document, cell, "tcPr")
			// Cells with the same tcPr on the same edges of the table show alike: one Props for them (read only).
			const first = (place?.offset ?? 0) + rowIndex === 0
			const last = (place?.offset ?? 0) + rowIndex === (place?.total ?? rowNodes.length) - 1
			const raw = tcPr < 0 ? NO_BYTES : document.raw(tcPr)
			const salt = (first ? 1 : 0) | (last ? 2 : 0) | (column << 2)
			const known = shared.get(raw, salt)

			if (known !== undefined) {
				cells.push({ node: cell, column, span: known.span, props: known.props })
				column += known.span

				continue
			}

			const props: Props = new Map()

			if (tcPr >= 0) readProps(document, tcPr, props)

			const span = gridSpan(props)
			const own = sides(props.get("tcBorders"))
			const borders = new Map<string, Map<string, string>>()
			const edge = {
				top: first ? "top" : "insideH",
				bottom: last ? "bottom" : "insideH",
				left: column === 0 ? "left" : "insideV",
				right: column + span >= grid.length ? "right" : "insideV"
			}

			for (const side of SIDES) {
				const shown = border(own.get(side) ?? tableBorders.get(edge[side]))

				if (shown !== undefined) borders.set(side, shown)
			}

			const margins = new Map<string, Map<string, string>>()
			const ownMargins = sides(props.get("tcMar"))

			for (const side of SIDES) {
				const margin = ownMargins.get(side) ?? tableMargins.get(side)
				const width = margin === undefined || (margin.get("type") ?? "dxa") !== "dxa" ? "0" : (margin.get("w") ?? "0")

				margins.set(side, new Map([["w", width]]))
			}

			props.delete("tcW")
			props.delete("tcBorders")
			props.delete("tcMar")

			if (borders.size > 0) props.set("tcBorders", { attributes: new Map(), children: sideMarkup(borders) })

			props.set("tcMar", { attributes: new Map(), children: sideMarkup(margins) })
			shared.set(raw, { props, span }, salt)
			cells.push({ node: cell, column, span, props })
			column += span
		}

		return { node: row, trPr, cells }
	})

	return { tblPr, grid, rows }
}

// A cell's w:gridSpan, clamped to Word's 63 columns a table holds ([MS-DOC] TDefTableOperand.NumberOfColumns), which
// bounds the covered cells written after it.
export function gridSpan(props: Props): number {
	return Math.min(63, Math.max(1, Number(props.get("gridSpan")?.attributes.get("val") ?? "1") || 1))
}

// The table's own properties as they show: alignment, indent, shading; the width its grid gives. Borders and cell
// margins are the cells'; the look and layout select nothing without a style's conditional formats or content to fit.
export function tableProperties(table: EffectiveTable): string {
	const out: string[] = []
	const jc = table.tblPr.get("jc")?.attributes.get("val") ?? "left"
	const indent = table.tblPr.get("tblInd")
	const shd = table.tblPr.get("shd")

	out.push(`jc=${jc === "start" ? "left" : jc === "end" ? "right" : jc}`)

	if (jc === "left" || jc === "start")
		out.push(
			`ind=${indent?.attributes.get("type") === "dxa" || indent?.attributes.get("type") === undefined ? (indent?.attributes.get("w") ?? "0") : "0"}`
		)
	if (shd !== undefined && (shd.attributes.get("fill") ?? "auto") !== "auto") out.push(`shd=${shd.attributes.get("fill") ?? ""}`)

	out.push(`grid=${table.grid.join(",")}`)

	return out.join(" ")
}
