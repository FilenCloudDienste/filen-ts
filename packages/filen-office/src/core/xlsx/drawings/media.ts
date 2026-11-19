import { imageFormat, imageHandling } from "../../drawingml/picture"
import { imageWithinBudget } from "../../opc/mediaPolicy"
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, naturalExtent, sniffImage, type DocxImageInfo } from "../../docx/objects/images"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetId, type SheetRefusal } from "../../sheet/protocol"
import type { SheetChangeSink, SheetHandled } from "../../sheet/registry"
import { escapeAttribute } from "../../xml/index"
import { partFolder } from "../comments/parts"
import type { XlsxDocument } from "../edit/document"
import { relationshipType } from "../write/namespaces"
import type { DrawingAnchor, DrawingMarker } from "./anchor"
import { appendDrawingObject } from "./edit"
import { axisPositions, type SheetAxisPositions } from "./geometry"
import { CONTENT_TYPES, mediaContentType } from "./mediaTypes"
import { drawingStore } from "./store"
import { DrawingWrites } from "./writes"

// Pictures: inserted as a new media part, a relationship to it and an xdr:pic on a two-cell anchor that moves but
// does not size with its cells (editAs="oneCell", as Excel's Insert Picture places it). The bytes are checked by
// their header here, whatever the caller said they are; an SVG carries the PNG Office draws where it cannot draw
// SVG (a:blip, with the SVG in the asvg:svgBlip extension). Media read for a renderer are pictures the package holds.

const SVG_BLIP_EXTENSION = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}"
const SVG_NAMESPACE = "http://schemas.microsoft.com/office/drawing/2016/SVG/main"

// Where a picture goes: its top-left cell and offsets; its size is the picture's own unless the caller gives one.
export interface ImagePlacement {
	readonly from: DrawingMarker
	// EMU; the picture's natural size (96 dpi, or what its header asks) when absent.
	readonly cx?: number
	readonly cy?: number
}

function checked(bytes: Uint8Array): DocxImageInfo | SheetRefusal {
	if (bytes.length > MAX_IMAGE_BYTES) return { reason: "tooLarge", detail: "picture" }

	const info = sniffImage(bytes)

	if (typeof info === "string")
		return info === "tooLarge" || info === "pixels"
			? { reason: "tooLarge", detail: "picture" }
			: { reason: "unsupported", detail: "picture" }

	return info
}

// The two-cell anchor covering a box from `from` of `cx` × `cy` EMU, through the sheet's sizes (a picture reaching
// past the grid's last row or column ends in it).
export function coveringAnchor(document: XlsxDocument, sheet: SheetId, from: DrawingMarker, cx: number, cy: number): DrawingAnchor {
	const layout = document.layout(sheet)
	const walk = (
		axis: SheetAxisPositions,
		index: number,
		offset: number,
		length: number,
		last: number
	): { index: number; offset: number } => {
		let at = index
		let left = Math.min(offset, axis.size(index)) + length

		// An edge on a boundary lies at the next index's start, as Excel writes it.
		while (at < last && left >= axis.size(at) && (left > 0 || axis.size(at) === 0)) {
			left -= axis.size(at)
			at++
		}

		return { index: at, offset: Math.max(0, Math.min(left, axis.size(at))) }
	}
	const right = walk(axisPositions(layout.cols), from.col, from.colOff, cx, SHEET_MAX_COLS - 1)
	const bottom = walk(axisPositions(layout.rows), from.row, from.rowOff, cy, SHEET_MAX_ROWS - 1)

	return {
		mode: "twoCell",
		editAs: "oneCell",
		from,
		to: { row: bottom.index, col: right.index, rowOff: bottom.offset, colOff: right.offset }
	}
}

function stem(name: string): string {
	const dot = name.lastIndexOf(".")

	return (dot < 0 ? name : name.slice(0, dot)).toLowerCase()
}

// A picture inserted at `placement`; `fallback` is the PNG an SVG carries. `name` is the file's (the object's name
// Excel shows as "Picture n" when none), `alt` its alternative text.
export async function insertImage(
	document: XlsxDocument,
	sheet: SheetId,
	placement: ImagePlacement,
	bytes: Uint8Array,
	fallback: Uint8Array | undefined,
	name: string,
	alt: string,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const info = checked(bytes)

	if ("reason" in info) return { refused: info }
	if (info.format === "svg" && fallback === undefined) return { refused: { reason: "unsupported", detail: "picture" } }

	const shown = fallback === undefined ? null : checked(fallback)

	if (shown !== null && ("reason" in shown || shown.format !== "png")) return { refused: { reason: "unsupported", detail: "picture" } }
	if (info.format !== "svg" && info.format !== "emf" && info.format !== "wmf" && info.width * info.height > MAX_IMAGE_PIXELS)
		return { refused: { reason: "tooLarge", detail: "picture" } }

	const natural = naturalExtent(info)
	const cx = placement.cx ?? natural.cx
	const cy = placement.cy ?? natural.cy
	const anchor = coveringAnchor(document, sheet, placement.from, cx, cy)
	const workbook = document.workbook
	const writes = new DrawingWrites(workbook)
	// Media are numbered across their extensions (image1.png, image2.svg), as Excel numbers them.
	const media = (extension: string, data: Uint8Array): string => {
		const taken = new Set<string>()

		for (const part of workbook.parts.parts()) taken.add(stem(part.name))
		for (const name of workbook.changes.parts.keys()) taken.add(stem(name))

		const folder = `${partFolder(workbook)}media/image`
		let n = 1

		while (taken.has(stem(`${folder}${String(n)}`))) n++

		const part = `${folder}${String(n)}.${extension}`

		writes.setPart(part, mediaContentType(part), data)

		return part
	}
	const main = media(shown === null ? info.extension : "png", fallback ?? bytes)
	const svg = shown === null ? null : media("svg", bytes)
	const imageType = relationshipType(workbook.strict, "image")
	const result = await appendDrawingObject(document, sheet, writes, anchor, (relate, id) => {
		const embed = relate(imageType, main)
		const extension =
			svg === null
				? ""
				: `<a:extLst><a:ext uri="${SVG_BLIP_EXTENSION}"><asvg:svgBlip xmlns:asvg="${SVG_NAMESPACE}" r:embed="${escapeAttribute(relate(imageType, svg))}"/></a:ext></a:extLst>`
		const title = name === "" ? `Picture ${String(id)}` : name

		return (
			`<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${String(id)}" name="${escapeAttribute(title)}"${alt === "" ? "" : ` descr="${escapeAttribute(alt)}"`}/>` +
			'<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
			`<xdr:blipFill><a:blip r:embed="${escapeAttribute(embed)}">${extension}</a:blip><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
			`<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${String(cx)}" cy="${String(cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
		)
	})

	if ("refused" in result) {
		writes.undo()

		return result
	}

	changes.layout(sheet)

	return writes.step(next => {
		next.layout(sheet)
	})
}

// A picture's bytes for a renderer: a part of the package that is an image (by its content type or name), within the
// size a picture may have, in bytes and in the pixels its header declares (a raster whose header does not say is
// refused, as the other formats' renderers refuse it); null otherwise.
export async function mediaBytes(
	document: XlsxDocument,
	partName: string
): Promise<{ readonly bytes: Uint8Array; readonly type: string } | null> {
	const store = drawingStore(document.workbook)
	const contentType = document.workbook.parts.get(partName)?.contentType ?? mediaContentType(partName)
	const format = imageFormat(partName, contentType)

	if (format === "unknown") return null

	const handling = imageHandling(format)

	if (handling !== "native" && handling !== "sanitize") return null

	try {
		const part = document.workbook.parts.get(partName)

		// Checked by its stored size before it is inflated.
		if (part?.source !== null && part?.source !== undefined && part.source.uncompressedSize > MAX_IMAGE_BYTES) return null

		const bytes = await store.media(partName)

		if (bytes === null || bytes.length > MAX_IMAGE_BYTES || !imageWithinBudget(bytes)) return null

		return { bytes, type: CONTENT_TYPES[format] ?? contentType }
	} catch {
		return null
	}
}
