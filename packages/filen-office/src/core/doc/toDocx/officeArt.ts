import { unzlibSync } from "fflate"
import { dibToBmp, hasPlaceableHeader, PLACEABLE_HEADER, withPlaceableHeader } from "../../metafile/bitmap"
import { le16, le32, les32 } from "../bytes"

// [MS-ODRAW] records as Word binary files hold them: the drawing group and per-story drawings of
// OfficeArtContent ([MS-DOC] §2.9.172, Table stream at fcDggInfo), inline picture shapes (PICF in the Data
// stream), and BLIPs (§2.2.23–§2.2.31), in the WordDocument stream (FBSE.foDelay) or embedded in an FBSE.

export const RT_DGG_CONTAINER = 0xf000
export const RT_BSTORE_CONTAINER = 0xf001
export const RT_DG_CONTAINER = 0xf002
export const RT_SPGR_CONTAINER = 0xf003
export const RT_SP_CONTAINER = 0xf004
export const RT_FBSE = 0xf007
export const RT_FSP = 0xf00a
export const RT_OPT = 0xf00b
export const RT_SECONDARY_OPT = 0xf121
export const RT_TERTIARY_OPT = 0xf122
export const RT_FSPGR = 0xf009
export const RT_CHILD_ANCHOR = 0xf00f
export const RT_BLIP_FIRST = 0xf018
export const RT_BLIP_LAST = 0xf117

const MAX_DEPTH = 32

export interface ArtRecord {
	readonly type: number
	readonly instance: number
	readonly version: number
	// The record's data: [start, end) in `data`.
	readonly start: number
	readonly end: number
}

// The records in data[start, end), in order; a record running past `end` is cut to it.
export function records(data: Uint8Array, start: number, end: number): ArtRecord[] {
	const out: ArtRecord[] = []
	const limit = Math.min(end, data.length)

	for (let at = start; at + 8 <= limit;) {
		const head = le16(data, at)
		const type = le16(data, at + 2)
		const length = le32(data, at + 4)
		const dataStart = at + 8
		const dataEnd = Math.min(limit, dataStart + length)

		out.push({ type, instance: head >> 4, version: head & 0xf, start: dataStart, end: dataEnd })
		at = dataStart + length
	}

	return out
}

export interface ArtProperty {
	readonly value: number
	// The complex data of an fComplex property.
	readonly complex: Uint8Array | undefined
}

// OfficeArtFOPT / secondary / tertiary (§2.2.9): opid (pid:14 fBid fComplex) + op, then complex data in order.
export function readProperties(data: Uint8Array, record: ArtRecord, into: Map<number, ArtProperty>): void {
	const count = record.instance
	let complexAt = record.start + 6 * count

	if (complexAt > record.end) return

	for (let k = 0; k < count; k++) {
		const at = record.start + 6 * k
		const opid = le16(data, at)
		const value = le32(data, at + 2)
		const pid = opid & 0x3fff
		let complex: Uint8Array | undefined

		if ((opid & 0x8000) !== 0) {
			const length = Math.min(value, Math.max(0, record.end - complexAt))

			complex = data.subarray(complexAt, complexAt + length)
			complexAt += length
		}

		into.set(pid, { value, complex })
	}
}

export interface ArtShape {
	readonly spid: number
	// MSOSPT (§2.4.24): FSP's recInstance.
	readonly shapeType: number
	// FSP.grfPersistent: fGroup 0x1, fChild 0x2, fPatriarch 0x4, fDeleted 0x8, fOleShape 0x10, fHaveMaster 0x20,
	// fFlipH 0x40, fFlipV 0x80, fConnector 0x100, fHaveAnchor 0x200, fBackground 0x400, fHaveSpt 0x800.
	readonly flags: number
	readonly properties: ReadonlyMap<number, ArtProperty>
	// A group: the shapes it holds (a group's first SpContainer describes the group itself).
	readonly children: readonly ArtShape[] | undefined
	// A group's coordinate space (OfficeArtFSPGR, §2.2.38).
	readonly groupRect?: ArtRect
	// A group member's place in its group's coordinate space (OfficeArtChildAnchor, §2.2.39).
	readonly childAnchor?: ArtRect
}

export interface ArtRect {
	readonly left: number
	readonly top: number
	readonly right: number
	readonly bottom: number
}

// §2.2.38 / §2.2.39: left, top, right, bottom (32-bit).
function ltrb(data: Uint8Array, record: ArtRecord): ArtRect | undefined {
	if (record.end - record.start < 16) return undefined

	return {
		left: les32(data, record.start),
		top: les32(data, record.start + 4),
		right: les32(data, record.start + 8),
		bottom: les32(data, record.start + 12)
	}
}

export function readShape(data: Uint8Array, container: ArtRecord): ArtShape | undefined {
	const properties = new Map<number, ArtProperty>()
	let spid: number | undefined
	let shapeType = 0
	let flags = 0
	let groupRect: ArtRect | undefined
	let childAnchor: ArtRect | undefined

	for (const record of records(data, container.start, container.end)) {
		if (record.type === RT_FSPGR) {
			groupRect = ltrb(data, record)
		} else if (record.type === RT_CHILD_ANCHOR) {
			childAnchor = ltrb(data, record)
		} else if (record.type === RT_FSP && record.end - record.start >= 8) {
			spid = le32(data, record.start)
			flags = le32(data, record.start + 4)
			shapeType = record.instance
		} else if (record.type === RT_OPT || record.type === RT_SECONDARY_OPT || record.type === RT_TERTIARY_OPT) {
			readProperties(data, record, properties)
		}
	}

	if (spid === undefined) return undefined

	return {
		spid,
		shapeType,
		flags,
		properties,
		children: undefined,
		...(groupRect === undefined ? {} : { groupRect }),
		...(childAnchor === undefined ? {} : { childAnchor })
	}
}

// Shapes stack in the order their drawing lists them, first at the bottom ([MS-ODRAW] §2.2.14
// OfficeArtSpgrContainer): spid → its place (1 to the count of shapes), counted over every drawing of the file.
class Stacking {
	readonly order = new Map<number, number>()

	place(spid: number): void {
		if (!this.order.has(spid)) this.order.set(spid, this.order.size + 1)
	}
}

function readGroup(
	data: Uint8Array,
	container: ArtRecord,
	depth: number,
	shapes: Map<number, ArtShape>,
	stacking: Stacking
): ArtShape | undefined {
	let self: ArtShape | undefined
	const children: ArtShape[] = []

	for (const record of records(data, container.start, container.end)) {
		let shape: ArtShape | undefined

		if (record.type === RT_SP_CONTAINER) shape = readShape(data, record)
		else if (record.type === RT_SPGR_CONTAINER && depth < MAX_DEPTH) shape = readGroup(data, record, depth + 1, shapes, stacking)

		if (shape === undefined) continue

		if (self === undefined && record.type === RT_SP_CONTAINER) {
			self = shape
			continue
		}

		children.push(shape)
		stacking.place(shape.spid)
	}

	if (self === undefined) return undefined

	const group: ArtShape = { ...self, children }

	for (const child of children) shapes.set(child.spid, child)

	shapes.set(group.spid, group)

	return group
}

export interface BlipEntry {
	// FBSE (§2.2.32): btWin32 and the BLIP, read from the delay stream or embedded (`data` holds the record).
	readonly type: number
	readonly blip: ArtRecord | undefined
	readonly data: Uint8Array
}

export interface ArtContent {
	// 1-based pib → BLIP store entry.
	readonly blips: readonly BlipEntry[]
	// Shapes by spid, main document and headers (spids are unique in a file).
	readonly shapes: ReadonlyMap<number, ArtShape>
	// spid → z-order, 1 at the bottom up to the map's size, from the drawings' order rather than the text's.
	readonly stacking: ReadonlyMap<number, number>
}

// FBSEs (or bare BLIPs) in data[start, end): the BLIP store of a drawing group, or the pictures after an inline
// shape (§2.9.? OfficeArtInlineSpContainer.rgfb).
export function readBlipStore(data: Uint8Array, start: number, end: number, delay: Uint8Array): BlipEntry[] {
	const out: BlipEntry[] = []

	for (const record of records(data, start, end)) {
		if (record.type === RT_FBSE && record.end - record.start >= 36) {
			const size = le32(data, record.start + 20)
			const foDelay = le32(data, record.start + 28)
			const cbName = data[record.start + 33] ?? 0
			const embeddedAt = record.start + 36 + cbName
			let blip: ArtRecord | undefined
			let source = data

			if (embeddedAt + 8 <= record.end) {
				blip = records(data, embeddedAt, record.end)[0]
			} else if (size > 0 && foDelay !== 0xffffffff && foDelay + 8 <= delay.length) {
				blip = records(delay, foDelay, Math.min(delay.length, foDelay + size))[0]
				source = delay
			}

			out.push({ type: data[record.start] ?? 0, blip, data: source })
		} else if (record.type >= RT_BLIP_FIRST && record.type <= RT_BLIP_LAST) {
			out.push({ type: 0, blip: record, data })
		} else {
			out.push({ type: 0, blip: undefined, data })
		}
	}

	return out
}

// OfficeArtContent: the drawing group container, then per drawing a dgglbl byte and an OfficeArtDgContainer.
export function readArtContent(table: Uint8Array, fc: number, lcb: number, delay: Uint8Array): ArtContent {
	const shapes = new Map<number, ArtShape>()
	const stacking = new Stacking()
	const end = Math.min(table.length, fc + lcb)
	const first = lcb >= 8 ? records(table, fc, end)[0] : undefined
	let blips: BlipEntry[] = []

	if (first?.type !== RT_DGG_CONTAINER) return { blips, shapes, stacking: stacking.order }

	for (const record of records(table, first.start, first.end)) {
		if (record.type === RT_BSTORE_CONTAINER) blips = readBlipStore(table, record.start, record.end, delay)
	}

	for (let at = first.end; at + 9 <= end;) {
		const container = records(table, at + 1, end)[0]

		if (container?.type !== RT_DG_CONTAINER) break

		for (const record of records(table, container.start, container.end)) {
			if (record.type === RT_SPGR_CONTAINER) {
				readGroup(table, record, 0, shapes, stacking)
			} else if (record.type === RT_SP_CONTAINER) {
				const shape = readShape(table, record)

				if (shape !== undefined) {
					shapes.set(shape.spid, shape)
					stacking.place(shape.spid)
				}
			}
		}

		at = container.end
	}

	return { blips, shapes, stacking: stacking.order }
}

export interface Blip {
	readonly bytes: Uint8Array
	readonly extension: "emf" | "wmf" | "pict" | "jpeg" | "png" | "bmp" | "tiff"
	readonly contentType: string
}

// BLIP record types (§2.2.23 ff.) → file kind, and the recInstance values that carry a second UID.
const BLIP_KINDS: ReadonlyMap<number, readonly [Blip["extension"], string, number]> = new Map([
	[0xf01a, ["emf", "image/x-emf", 0x3d5]],
	[0xf01b, ["wmf", "image/x-wmf", 0x217]],
	[0xf01c, ["pict", "image/pict", 0x543]],
	[0xf01d, ["jpeg", "image/jpeg", 0x46b]],
	[0xf02a, ["jpeg", "image/jpeg", 0x6e3]],
	[0xf01e, ["png", "image/png", 0x6e1]],
	[0xf01f, ["bmp", "image/bmp", 0x7a9]],
	[0xf029, ["tiff", "image/tiff", 0x6e5]]
])

// The file kind of a BLIP record type; undefined for a type that holds no picture file.
export function blipKind(type: number): Omit<Blip, "bytes"> | undefined {
	const kind = BLIP_KINDS.get(type)

	return kind === undefined ? undefined : { extension: kind[0], contentType: kind[1] }
}

const MAX_INFLATED = 64 * 1024 * 1024
// Deflate's longest match (258 bytes) costs at least two bits, so a zlib stream inflates to at most 1032 times its
// length: what a metafile can really hold, whatever cbSize declares.
const DEFLATE_RATIO = 1032

interface Metafile {
	readonly header: number
	readonly cbSize: number
	readonly bodyStart: number
	readonly bodyEnd: number
	readonly compressed: boolean
}

// OfficeArtMetafileHeader (§2.2.31): cbSize, rcBounds, ptSize, cbSave, compression (0 deflate, 0xFE none). Only the
// header's bytes are read: `record.end` bounds the body.
function metafileOf(data: Uint8Array, record: ArtRecord, uids: number): Metafile | undefined {
	const header = record.start + uids

	if (header + 34 > record.end) return undefined

	const cbSave = le32(data, header + 28)

	return {
		header,
		cbSize: le32(data, header),
		bodyStart: header + 34,
		bodyEnd: Math.min(record.end, header + 34 + cbSave),
		compressed: (data[header + 32] ?? 0) === 0
	}
}

// The bytes a compressed metafile inflates to at most (cbSize, bounded by what its deflate stream can hold).
function inflatedLimit(metafile: Metafile): number {
	return Math.min(metafile.cbSize, (metafile.bodyEnd - metafile.bodyStart) * DEFLATE_RATIO + 258)
}

// The size of the picture file a BLIP holds, from its headers alone (only the bytes up to and including the metafile
// header or tag byte are read): exact for bitmaps and uncompressed metafiles, an upper bound for compressed ones.
// Undefined where blipFile gives none.
export function blipSize(data: Uint8Array, record: ArtRecord): number | undefined {
	const kind = BLIP_KINDS.get(record.type)

	if (kind === undefined) return undefined

	const [extension, , twoUids] = kind
	const uids = record.instance === twoUids ? 32 : 16

	if (extension === "emf" || extension === "wmf" || extension === "pict") {
		const metafile = metafileOf(data, record, uids)

		if (metafile === undefined || (metafile.compressed && metafile.cbSize > MAX_INFLATED)) return undefined

		const size = metafile.compressed ? inflatedLimit(metafile) : metafile.bodyEnd - metafile.bodyStart

		return extension === "wmf" ? size + PLACEABLE_HEADER : size
	}

	const length = record.end - (record.start + uids + 1)

	// dibToBmp leaves a DIB too short for its header as it is.
	return length <= 0 ? undefined : length + (extension === "bmp" && length >= 16 ? 14 : 0)
}

// The picture file a BLIP holds, or undefined for a record that is not one or is damaged.
export function blipFile(data: Uint8Array, record: ArtRecord): Blip | undefined {
	const kind = BLIP_KINDS.get(record.type)

	if (kind === undefined) return undefined

	const [extension, contentType, twoUids] = kind
	const uids = record.instance === twoUids ? 32 : 16

	if (extension === "emf" || extension === "wmf" || extension === "pict") {
		const metafile = metafileOf(data, record, uids)

		if (metafile === undefined) return undefined

		const body = data.subarray(metafile.bodyStart, metafile.bodyEnd)
		let bytes: Uint8Array

		if (metafile.compressed) {
			if (metafile.cbSize > MAX_INFLATED) return undefined

			// The output never outgrows the array it is given, so the array is no larger than the stream can fill,
			// and a shorter result is copied out: a subarray would keep the whole allocation alive.
			const out = new Uint8Array(inflatedLimit(metafile))

			try {
				bytes = unzlibSync(body, { out })
			} catch {
				return undefined
			}

			if (bytes.length < out.length) bytes = bytes.slice()
		} else {
			bytes = body.slice()
		}

		if (extension === "wmf") bytes = placeable(bytes, data, metafile.header)

		return { bytes, extension, contentType }
	}

	// Bitmaps: UIDs, a tag byte, then the file.
	const body = data.subarray(record.start + uids + 1, record.end)

	if (body.length === 0) return undefined

	const bytes = extension === "bmp" ? dibToBmp(body) : body

	// A copy, so the picture does not keep the whole stream alive.
	return { bytes: bytes === body ? body.slice() : bytes, extension, contentType }
}

// A WMF BLIP is stored without its placeable header ([MS-WMF] §2.3.2.3); rcBounds (logical units) and ptSize
// (EMUs) give it back, so the picture keeps its size wherever it is read. Bounds past int16 leave it bare.
function placeable(wmf: Uint8Array, data: Uint8Array, header: number): Uint8Array {
	if (hasPlaceableHeader(wmf)) return wmf

	const left = les32(data, header + 4)
	const top = les32(data, header + 8)
	const right = les32(data, header + 12)
	const bottom = les32(data, header + 16)
	const widthEmu = les32(data, header + 20)
	const width = right - left

	if (
		width <= 0 ||
		widthEmu <= 0 ||
		Math.abs(left) > 0x7fff ||
		Math.abs(right) > 0x7fff ||
		Math.abs(top) > 0x7fff ||
		Math.abs(bottom) > 0x7fff
	)
		return wmf

	return withPlaceableHeader(wmf, {
		left,
		top,
		right,
		bottom,
		inch: Math.max(1, Math.min(0xffff, Math.round((width * 914400) / widthEmu)))
	})
}

// Property ids (§2.3) the Word and PowerPoint conversions read.
export const PID = {
	rotation: 0x0004,
	lTxid: 0x0080,
	dxTextLeft: 0x0081,
	dyTextTop: 0x0082,
	dxTextRight: 0x0083,
	dyTextBottom: 0x0084,
	wrapText: 0x0085,
	anchorText: 0x0087,
	txflTextFlow: 0x0088,
	textBooleans: 0x00bf,
	gtextUNICODE: 0x00c0,
	gtextSize: 0x00c3,
	gtextFont: 0x00c5,
	gtextBooleans: 0x00ff,
	cropFromTop: 0x0100,
	cropFromBottom: 0x0101,
	cropFromLeft: 0x0102,
	cropFromRight: 0x0103,
	pib: 0x0104,
	pictureTransparent: 0x0107,
	pictureContrast: 0x0108,
	pictureBrightness: 0x0109,
	blipBooleans: 0x013f,
	geoLeft: 0x0140,
	geoTop: 0x0141,
	geoRight: 0x0142,
	geoBottom: 0x0143,
	shapePath: 0x0144,
	pVertices: 0x0145,
	pSegmentInfo: 0x0146,
	adjustValue: 0x0147,
	geometryBooleans: 0x017f,
	fillType: 0x0180,
	fillColor: 0x0181,
	fillOpacity: 0x0182,
	fillBackColor: 0x0183,
	fillBackOpacity: 0x0184,
	fillBlip: 0x0186,
	fillAngle: 0x018b,
	fillFocus: 0x018c,
	fillToLeft: 0x018d,
	fillToTop: 0x018e,
	fillToRight: 0x018f,
	fillToBottom: 0x0190,
	fillShadeColors: 0x0197,
	fillShadeType: 0x019c,
	fillStyleBooleans: 0x01bf,
	lineColor: 0x01c0,
	lineOpacity: 0x01c1,
	lineBackColor: 0x01c2,
	lineType: 0x01c4,
	lineWidth: 0x01cb,
	lineStyle: 0x01cd,
	lineDashing: 0x01ce,
	lineStartArrowhead: 0x01d0,
	lineEndArrowhead: 0x01d1,
	lineStartArrowWidth: 0x01d2,
	lineStartArrowLength: 0x01d3,
	lineEndArrowWidth: 0x01d4,
	lineEndArrowLength: 0x01d5,
	lineJoinStyle: 0x01d6,
	lineEndCapStyle: 0x01d7,
	lineStyleBooleans: 0x01ff,
	shadowType: 0x0200,
	shadowColor: 0x0201,
	shadowOpacity: 0x0204,
	shadowOffsetX: 0x0205,
	shadowOffsetY: 0x0206,
	shadowStyleBooleans: 0x023f,
	hspMaster: 0x0301,
	shapeBooleans: 0x033f,
	wzName: 0x0380,
	wzDescription: 0x0381,
	posH: 0x038f,
	posRelH: 0x0390,
	posV: 0x0391,
	posRelV: 0x0392,
	tableProperties: 0x039f,
	groupShapeBooleans: 0x03bf
} as const

// A boolean of a property set (§2.3.x booleans): bit `bit` with its fUse bit 16 higher; undefined when unset.
export function booleanProperty(properties: ReadonlyMap<number, ArtProperty>, pid: number, bit: number): boolean | undefined {
	const value = properties.get(pid)?.value

	if (value === undefined || ((value >>> (bit + 16)) & 1) === 0) return undefined

	return ((value >>> bit) & 1) !== 0
}

// OfficeArtCOLORREF (§2.2.2) as RGB, or undefined for scheme/system/palette colours this does not resolve.
export function artColor(value: number | undefined): number | undefined {
	if (value === undefined) return undefined

	const flags = value >>> 24

	// fPaletteIndex, fSystemRGB, fSchemeIndex, fSysIndex.
	if ((flags & (0x01 | 0x04 | 0x08 | 0x10)) !== 0) return undefined

	return ((value & 0xff) << 16) | (value & 0xff00) | ((value >> 16) & 0xff)
}

// UTF-16 text of a complex property (shape names, descriptions), up to its terminator.
export function complexText(property: ArtProperty | undefined): string | undefined {
	const bytes = property?.complex

	if (bytes === undefined) return undefined

	let out = ""

	for (let at = 0; at + 1 < bytes.length; at += 2) {
		const unit = le16(bytes, at)

		if (unit === 0) break

		out += String.fromCharCode(unit)
	}

	return out === "" ? undefined : out
}
