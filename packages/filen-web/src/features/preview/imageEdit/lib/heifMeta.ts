// HEIF/AVIF (ISO/IEC 23008-12, MIAF) container reading over the ISOBMFF box structure (ISO/IEC 14496-12):
// the primary item's size, alpha, ICC profile and Exif, from the `meta` box. Reads only; never copies more than the
// metadata it returns.

const BOX_FTYP = 0x66747970 // "ftyp"
const BOX_META = 0x6d657461 // "meta"
const BOX_PITM = 0x7069746d // "pitm"
const BOX_IINF = 0x69696e66 // "iinf"
const BOX_INFE = 0x696e6665 // "infe"
const BOX_ILOC = 0x696c6f63 // "iloc"
const BOX_IREF = 0x69726566 // "iref"
const BOX_IPRP = 0x69707270 // "iprp"
const BOX_IPCO = 0x6970636f // "ipco"
const BOX_IPMA = 0x69706d61 // "ipma"
const BOX_IDAT = 0x69646174 // "idat"
const BOX_ISPE = 0x69737065 // "ispe"
const BOX_IROT = 0x69726f74 // "irot"
const BOX_COLR = 0x636f6c72 // "colr"
const BOX_AUXC = 0x61757843 // "auxC"
const REF_AUXL = 0x6175786c // "auxl"
const ITEM_EXIF = 0x45786966 // "Exif"
const ITEM_AV01 = 0x61763031 // "av01"
const COLR_PROF = 0x70726f66 // "prof"
const COLR_RICC = 0x72494343 // "rICC"

// Image-sequence brands (ISO/IEC 23008-12 Annex B, AV1 Image File Format §6): the file holds an animation.
const SEQUENCE_BRANDS = new Set(["avis", "msf1", "hevc", "hevs"])
const AVIF_BRANDS = new Set(["avif", "avis"])
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"])

// Alpha auxiliary images (AV1 Image File Format §4.1, ISO/IEC 23008-12 for HEVC).
const ALPHA_URNS = new Set(["urn:mpeg:mpegB:cicp:systems:auxiliary:alpha", "urn:mpeg:hevc:2015:auxid:1"])

interface Box {
	type: number
	start: number
	// After the header (and, for a FullBox, still before its version/flags).
	payload: number
	end: number
}

interface Location {
	method: number
	extents: [number, number][]
}

interface HeifLayout {
	view: DataView
	brands: Set<string>
	primary: number
	itemTypes: Map<number, number>
	locations: Map<number, Location>
	properties: Box[]
	associations: Map<number, number[]>
	auxiliaries: Map<number, number[]>
	idat: Box | null
}

function readBox(view: DataView, at: number, limit: number): Box | null {
	if (at + 8 > limit) {
		return null
	}

	let size = view.getUint32(at)
	let payload = at + 8

	if (size === 1) {
		if (at + 16 > limit) {
			return null
		}

		size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12)
		payload = at + 16
	} else if (size === 0) {
		size = limit - at
	}

	if (size < payload - at || at + size > limit) {
		return null
	}

	return { type: view.getUint32(at + 4), start: at, payload, end: at + size }
}

function children(view: DataView, start: number, end: number): Box[] {
	const boxes: Box[] = []
	let at = start

	for (let box = readBox(view, at, end); box !== null; box = readBox(view, at, end)) {
		boxes.push(box)
		at = box.end
	}

	return boxes
}

function readUint(view: DataView, at: number, size: number): number {
	switch (size) {
		case 0: {
			return 0
		}

		case 2: {
			return view.getUint16(at)
		}

		case 4: {
			return view.getUint32(at)
		}

		case 8: {
			return view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4)
		}

		default: {
			throw new RangeError("unsupported field size")
		}
	}
}

function fourcc(value: number): string {
	return String.fromCharCode(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

// Item locations (ISO/IEC 14496-12 §8.11.3).
function parseIloc(view: DataView, box: Box, into: Map<number, Location>): void {
	let at = box.payload
	const version = view.getUint8(at)
	const sizes = view.getUint16(at + 4)
	const offsetSize = sizes >> 12
	const lengthSize = (sizes >> 8) & 0xf
	const baseOffsetSize = (sizes >> 4) & 0xf
	const indexSize = version === 1 || version === 2 ? sizes & 0xf : 0

	at += 6

	const count = version < 2 ? view.getUint16(at) : view.getUint32(at)

	at += version < 2 ? 2 : 4

	for (let i = 0; i < count; i++) {
		const id = version < 2 ? view.getUint16(at) : view.getUint32(at)

		at += version < 2 ? 2 : 4

		let method = 0

		if (version === 1 || version === 2) {
			method = view.getUint16(at) & 0xf
			at += 2
		}

		// data_reference_index
		at += 2

		const base = readUint(view, at, baseOffsetSize)

		at += baseOffsetSize

		const extentCount = view.getUint16(at)
		const extents: [number, number][] = []

		at += 2

		for (let e = 0; e < extentCount; e++) {
			at += indexSize

			const offset = readUint(view, at, offsetSize)
			const length = readUint(view, at + offsetSize, lengthSize)

			at += offsetSize + lengthSize
			extents.push([base + offset, length])
		}

		into.set(id, { method, extents })
	}
}

// Item infos (§8.11.6); only version 2+ entries carry an item type.
function parseIinf(view: DataView, box: Box, into: Map<number, number>): void {
	const version = view.getUint8(box.payload)
	const first = box.payload + 4 + (version === 0 ? 2 : 4)

	for (const infe of children(view, first, box.end)) {
		if (infe.type !== BOX_INFE) {
			continue
		}

		const infeVersion = view.getUint8(infe.payload)

		if (infeVersion < 2) {
			continue
		}

		const idSize = infeVersion === 2 ? 2 : 4
		const id = readUint(view, infe.payload + 4, idSize)

		into.set(id, view.getUint32(infe.payload + 4 + idSize + 2))
	}
}

// Auxiliary-image references: aux item → the items it serves (§8.11.12).
function parseIref(view: DataView, box: Box, into: Map<number, number[]>): void {
	const idSize = view.getUint8(box.payload) === 0 ? 2 : 4

	for (const ref of children(view, box.payload + 4, box.end)) {
		if (ref.type !== REF_AUXL) {
			continue
		}

		const from = readUint(view, ref.payload, idSize)
		const count = view.getUint16(ref.payload + idSize)
		const targets: number[] = []

		for (let i = 0; i < count; i++) {
			targets.push(readUint(view, ref.payload + idSize + 2 + i * idSize, idSize))
		}

		into.set(from, targets)
	}
}

// Property associations, 1-based indices into ipco (ISO/IEC 23008-12 §9.3.2).
function parseIpma(view: DataView, box: Box, into: Map<number, number[]>): void {
	const version = view.getUint8(box.payload)
	const wide = (view.getUint8(box.payload + 3) & 1) === 1
	const count = view.getUint32(box.payload + 4)
	let at = box.payload + 8

	for (let i = 0; i < count; i++) {
		const id = version < 1 ? view.getUint16(at) : view.getUint32(at)

		at += version < 1 ? 2 : 4

		const associations = view.getUint8(at)
		const indices: number[] = []

		at++

		for (let a = 0; a < associations; a++) {
			indices.push(wide ? view.getUint16(at) & 0x7fff : view.getUint8(at) & 0x7f)
			at += wide ? 2 : 1
		}

		into.set(id, indices)
	}
}

function parseLayout(bytes: Uint8Array): HeifLayout | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const top = children(view, 0, bytes.length)
	const ftyp = top[0]

	if (ftyp?.type !== BOX_FTYP) {
		return null
	}

	const brands = new Set<string>()

	for (let at = ftyp.payload; at + 4 <= ftyp.end; at += 4) {
		// The minor version sits between the major brand and the compatible ones.
		if (at !== ftyp.payload + 4) {
			brands.add(fourcc(view.getUint32(at)))
		}
	}

	const meta = top.find(box => box.type === BOX_META)

	if (meta === undefined) {
		return null
	}

	const layout: HeifLayout = {
		view,
		brands,
		primary: -1,
		itemTypes: new Map(),
		locations: new Map(),
		properties: [],
		associations: new Map(),
		auxiliaries: new Map(),
		idat: null
	}

	try {
		// meta is a FullBox (§8.11.1).
		for (const box of children(view, meta.payload + 4, meta.end)) {
			switch (box.type) {
				case BOX_PITM: {
					layout.primary = view.getUint8(box.payload) === 0 ? view.getUint16(box.payload + 4) : view.getUint32(box.payload + 4)

					break
				}

				case BOX_IINF: {
					parseIinf(view, box, layout.itemTypes)

					break
				}

				case BOX_ILOC: {
					parseIloc(view, box, layout.locations)

					break
				}

				case BOX_IREF: {
					parseIref(view, box, layout.auxiliaries)

					break
				}

				case BOX_IDAT: {
					layout.idat = box

					break
				}

				case BOX_IPRP: {
					for (const child of children(view, box.payload, box.end)) {
						if (child.type === BOX_IPCO) {
							layout.properties = children(view, child.payload, child.end)
						} else if (child.type === BOX_IPMA) {
							parseIpma(view, child, layout.associations)
						}
					}

					break
				}
			}
		}
	} catch (e) {
		// A field read past the end: a malformed or cut-off meta box.
		if (e instanceof RangeError) {
			return null
		}

		throw e
	}

	return layout
}

function propertiesOf(layout: HeifLayout, item: number): Box[] {
	const result: Box[] = []

	for (const index of layout.associations.get(item) ?? []) {
		const box = layout.properties[index - 1]

		if (box !== undefined) {
			result.push(box)
		}
	}

	return result
}

function iccFrom(layout: HeifLayout): Uint8Array | null {
	const colr = propertiesOf(layout, layout.primary).find(box => {
		if (box.type !== BOX_COLR || box.payload + 4 > box.end) {
			return false
		}

		const kind = layout.view.getUint32(box.payload)

		return kind === COLR_PROF || kind === COLR_RICC
	})

	return colr === undefined
		? null
		: new Uint8Array(layout.view.buffer, layout.view.byteOffset + colr.payload + 4, colr.end - colr.payload - 4).slice()
}

function auxType(layout: HeifLayout, box: Box): string {
	const view = layout.view
	let text = ""

	// auxC is a FullBox: aux_type is a NUL-terminated string after version/flags.
	for (let at = box.payload + 4; at < box.end; at++) {
		const byte = view.getUint8(at)

		if (byte === 0) {
			break
		}

		text += String.fromCharCode(byte)
	}

	return text
}

function hasAlphaAuxiliary(layout: HeifLayout): boolean {
	for (const [aux, targets] of layout.auxiliaries) {
		if (!targets.includes(layout.primary)) {
			continue
		}

		for (const box of propertiesOf(layout, aux)) {
			if (box.type === BOX_AUXC && ALPHA_URNS.has(auxType(layout, box))) {
				return true
			}
		}
	}

	return false
}

function exifFrom(bytes: Uint8Array, layout: HeifLayout): Uint8Array | null {
	let exifItem = -1

	for (const [id, type] of layout.itemTypes) {
		if (type === ITEM_EXIF) {
			exifItem = id

			break
		}
	}

	const location = layout.locations.get(exifItem)

	if (location === undefined || location.extents.length === 0 || location.method > 1) {
		return null
	}

	// Construction method 1 addresses the idat box's payload; 0, the file.
	const origin = location.method === 1 ? (layout.idat?.payload ?? -1) : 0

	if (origin < 0) {
		return null
	}

	let total = 0

	for (const [offset, length] of location.extents) {
		if (origin + offset + length > bytes.length) {
			return null
		}

		total += length
	}

	const first = location.extents[0]
	let data: Uint8Array

	if (location.extents.length === 1 && first !== undefined) {
		data = bytes.subarray(origin + first[0], origin + first[0] + first[1])
	} else {
		data = new Uint8Array(total)

		let at = 0

		for (const [offset, length] of location.extents) {
			data.set(bytes.subarray(origin + offset, origin + offset + length), at)
			at += length
		}
	}

	// The item is a 32-bit offset to the TIFF header, then the Exif data (ISO/IEC 23008-12 Annex A.2.1).
	if (data.length < 4) {
		return null
	}

	const tiffStart = 4 + new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0)

	if (tiffStart + 8 > data.length) {
		return null
	}

	const order = String.fromCharCode(data[tiffStart] ?? 0, data[tiffStart + 1] ?? 0)

	if (order !== "II" && order !== "MM") {
		return null
	}

	// Copied out of `bytes` once: the caller keeps it past the (possibly large) buffer it came from.
	return location.extents.length === 1 ? data.slice(tiffStart) : data.subarray(tiffStart)
}

// The Exif TIFF block of a HEIF/AVIF file, or null (none, or its bytes are not within `bytes`).
export function heifExif(bytes: Uint8Array): Uint8Array | null {
	const layout = parseLayout(bytes)

	return layout === null ? null : exifFrom(bytes, layout)
}

// The primary item's ICC profile ("prof"/"rICC" colr), or null (none, or an nclx colour description).
export function heifIcc(bytes: Uint8Array): Uint8Array | null {
	const layout = parseLayout(bytes)

	return layout === null ? null : iccFrom(layout)
}

export interface HeifInfo {
	mime: "image/avif" | "image/heic"
	// Displayed size: the primary item's ispe, swapped by an odd irot (the decoder applies irot/imir).
	width: number
	height: number
	hasAlpha: boolean
	animated: boolean
	icc: Uint8Array | null
	exif: Uint8Array | null
}

// What a head of a HEIF/AVIF file tells: null when it is not one or its meta box is not wholly within `bytes`.
export function sniffHeif(bytes: Uint8Array): HeifInfo | null {
	const layout = parseLayout(bytes)

	if (layout === null) {
		return null
	}

	const brands = [...layout.brands]

	if (!brands.some(brand => AVIF_BRANDS.has(brand) || HEIF_BRANDS.has(brand))) {
		return null
	}

	const avif = brands.some(brand => AVIF_BRANDS.has(brand)) || layout.itemTypes.get(layout.primary) === ITEM_AV01
	let width = 0
	let height = 0
	let turned = false

	for (const box of propertiesOf(layout, layout.primary)) {
		if (box.type === BOX_ISPE && box.payload + 12 <= box.end) {
			width = layout.view.getUint32(box.payload + 4)
			height = layout.view.getUint32(box.payload + 8)
		} else if (box.type === BOX_IROT && box.payload < box.end) {
			turned = (layout.view.getUint8(box.payload) & 1) === 1
		}
	}

	if (width === 0 || height === 0) {
		return null
	}

	return {
		mime: avif ? "image/avif" : "image/heic",
		width: turned ? height : width,
		height: turned ? width : height,
		hasAlpha: hasAlphaAuxiliary(layout),
		animated: brands.some(brand => SEQUENCE_BRANDS.has(brand)),
		icc: iccFrom(layout),
		exif: exifFrom(bytes, layout)
	}
}
