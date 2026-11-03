import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../../sheet/protocol"
import type { XmlDocument } from "../../xml/index"
import { childByLocal } from "../refs/markup"

// Where a sheet's drawing object sits (ECMA-376 Part 1 §20.5.2.33 twoCellAnchor, §20.5.2.24 oneCellAnchor,
// §20.5.2.1 absoluteAnchor): cell markers with offsets in EMU, or a position on the sheet. Lengths are EMU
// (914,400 per inch; 9,525 per CSS pixel at 100 %).

export const EMU_PER_PX = 9525

// A cell marker (CT_Marker): the cell the edge lies in and its offset into the cell, EMU.
export interface DrawingMarker {
	readonly row: number
	readonly col: number
	readonly rowOff: number
	readonly colOff: number
}

export type DrawingAnchor =
	// editAs: how the object follows its cells (§20.5.3.1); twoCell when absent.
	| {
			readonly mode: "twoCell"
			readonly from: DrawingMarker
			readonly to: DrawingMarker
			readonly editAs: "twoCell" | "oneCell" | "absolute"
	  }
	| { readonly mode: "oneCell"; readonly from: DrawingMarker; readonly cx: number; readonly cy: number }
	| { readonly mode: "absolute"; readonly x: number; readonly y: number; readonly cx: number; readonly cy: number }

// ST_Coordinate's bounds (§20.1.10.16), the most any offset or extent may be.
export const MAX_COORDINATE = 27_273_042_316_900

function integer(text: string | undefined): number | null {
	if (text === undefined) return null

	const value = Number(text.trim())

	return Number.isSafeInteger(value) ? value : null
}

// An ST_Coordinate: an integer (EMU) or a universal measure ("2.5in", §22.9.2.15). Null when it does not read.
export function coordinate(text: string | undefined): number | null {
	if (text === undefined) return null

	const trimmed = text.trim()
	const plain = integer(trimmed)

	if (plain !== null) return plain

	const match = /^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/.exec(trimmed)

	if (match === null) return null

	const per: Readonly<Record<string, number>> = { mm: 36000, cm: 360000, in: 914400, pt: 12700, pc: 152400, pi: 152400 }

	return Math.round(Number(match[1]) * (per[match[2] ?? ""] ?? 0))
}

function readMarker(document: XmlDocument, node: number): DrawingMarker | null {
	if (node < 0) return null

	const value = (local: string): number | null => {
		const child = childByLocal(document, node, local)

		return child < 0 ? null : local.endsWith("Off") ? coordinate(document.textContent(child)) : integer(document.textContent(child))
	}
	const row = value("row")
	const col = value("col")

	if (row === null || col === null || row < 0 || col < 0) return null

	return { row, col, rowOff: value("rowOff") ?? 0, colOff: value("colOff") ?? 0 }
}

function readExtent(document: XmlDocument, node: number): { cx: number; cy: number } | null {
	if (node < 0) return null

	const cx = coordinate(document.attribute(node, "cx"))
	const cy = coordinate(document.attribute(node, "cy"))

	return cx === null || cy === null || cx < 0 || cy < 0 ? null : { cx, cy }
}

// The anchor of an xdr anchor element, null when it does not read (the object then stays where the file has it
// and cannot be moved).
export function readAnchor(document: XmlDocument, node: number): DrawingAnchor | null {
	switch (document.localName(node)) {
		case "twoCellAnchor": {
			const from = readMarker(document, childByLocal(document, node, "from"))
			const to = readMarker(document, childByLocal(document, node, "to"))
			const editAs = document.attribute(node, "editAs")

			if (from === null || to === null) return null

			return { mode: "twoCell", from, to, editAs: editAs === "oneCell" || editAs === "absolute" ? editAs : "twoCell" }
		}
		case "oneCellAnchor": {
			const from = readMarker(document, childByLocal(document, node, "from"))
			const ext = readExtent(document, childByLocal(document, node, "ext"))

			return from === null || ext === null ? null : { mode: "oneCell", from, ...ext }
		}
		case "absoluteAnchor": {
			const pos = childByLocal(document, node, "pos")
			const x = pos < 0 ? null : coordinate(document.attribute(pos, "x"))
			const y = pos < 0 ? null : coordinate(document.attribute(pos, "y"))
			const ext = readExtent(document, childByLocal(document, node, "ext"))

			return x === null || y === null || ext === null ? null : { mode: "absolute", x, y, ...ext }
		}
		default:
			return null
	}
}

function validMarker(marker: DrawingMarker): boolean {
	return (
		Number.isSafeInteger(marker.row) &&
		Number.isSafeInteger(marker.col) &&
		Number.isSafeInteger(marker.rowOff) &&
		Number.isSafeInteger(marker.colOff) &&
		marker.row >= 0 &&
		marker.col >= 0 &&
		marker.row < SHEET_MAX_ROWS &&
		marker.col < SHEET_MAX_COLS &&
		// ST_Coordinate: a file may place an edge before its cell's start (Excel writes small negative offsets).
		Math.abs(marker.rowOff) <= MAX_COORDINATE &&
		Math.abs(marker.colOff) <= MAX_COORDINATE
	)
}

function validLength(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COORDINATE
}

// An anchor an edit may write: markers on the grid, in order, lengths within ST_Coordinate.
export function validAnchor(anchor: DrawingAnchor): boolean {
	switch (anchor.mode) {
		case "twoCell":
			return (
				validMarker(anchor.from) &&
				validMarker(anchor.to) &&
				(anchor.to.row > anchor.from.row || (anchor.to.row === anchor.from.row && anchor.to.rowOff >= anchor.from.rowOff)) &&
				(anchor.to.col > anchor.from.col || (anchor.to.col === anchor.from.col && anchor.to.colOff >= anchor.from.colOff))
			)
		case "oneCell":
			return validMarker(anchor.from) && validLength(anchor.cx) && validLength(anchor.cy)
		case "absolute":
			return validLength(anchor.x) && validLength(anchor.y) && validLength(anchor.cx) && validLength(anchor.cy)
	}
}

function marker(p: string, name: "from" | "to", value: DrawingMarker): string {
	return (
		`<${p}${name}><${p}col>${String(value.col)}</${p}col><${p}colOff>${String(value.colOff)}</${p}colOff>` +
		`<${p}row>${String(value.row)}</${p}row><${p}rowOff>${String(value.rowOff)}</${p}rowOff></${p}${name}>`
	)
}

// The anchor's placement children in schema order (CT_TwoCellAnchor: from, to; CT_OneCellAnchor: from, ext;
// CT_AbsoluteAnchor: pos, ext), with `p` the drawing namespace's prefix and its colon ("xdr:").
export function placementMarkup(p: string, anchor: DrawingAnchor): string {
	switch (anchor.mode) {
		case "twoCell":
			return marker(p, "from", anchor.from) + marker(p, "to", anchor.to)
		case "oneCell":
			return `${marker(p, "from", anchor.from)}<${p}ext cx="${String(anchor.cx)}" cy="${String(anchor.cy)}"/>`
		case "absolute":
			return `<${p}pos x="${String(anchor.x)}" y="${String(anchor.y)}"/><${p}ext cx="${String(anchor.cx)}" cy="${String(anchor.cy)}"/>`
	}
}

// The anchor element's name.
export function anchorElement(anchor: DrawingAnchor): string {
	return anchor.mode === "twoCell" ? "twoCellAnchor" : anchor.mode === "oneCell" ? "oneCellAnchor" : "absoluteAnchor"
}
