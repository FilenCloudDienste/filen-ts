import { le16, le32, les16 } from "../bytes"
import type { DocFile } from "../read"
import {
	type ArtContent,
	type ArtShape,
	type Blip,
	type BlipEntry,
	PID,
	blipFile,
	blipSize,
	readBlipStore,
	readShape,
	records,
	RT_SP_CONTAINER
} from "./officeArt"
import type { Crop } from "./drawing"

// Pictures of a Word binary document as package media: PICF pictures in the Data stream (§2.9.192, with their
// OfficeArt inline shape), BLIP store pictures of floating shapes, and embedded objects' presentation metafiles.

export interface Media {
	readonly part: string
	readonly contentType: string
	readonly extension: string
}

// A grey box with a cross: what a picture or shape that cannot be converted shows.
const PLACEHOLDER_PNG =
	"89504e470d0a1a0a0000000d4948445200000018000000180800000000c51c62240000005f4944415478da8dd25b0e00100c4451fb5f4497386ba01e" +
	"d1e226fa678e78946250c54c8f72d0435ad8e016cf1c4ee951872c231910650613b6acf1021d1336286f1640e9e011149bf005b4146d4ec7a50b524b" +
	"a889d4767a287a5afc0c5015e027ed10c3e216980000000049454e44ae426082"

function decodeHex(text: string): Uint8Array {
	const out = new Uint8Array(text.length / 2)

	for (let k = 0; k < out.length; k++) out[k] = Number.parseInt(text.slice(2 * k, 2 * k + 2), 16)

	return out
}

// What the pictures of one conversion may decode to in all. blipFile bounds each picture, not their sum: a small
// file's pictures can each inflate to its bound.
export const MEDIA_BUDGET = 256 * 1024 * 1024

// A picture not decoded yet: the bytes it decodes to at most, and its decoding.
export interface PendingBlip {
	readonly size: number
	readonly decode: () => Blip | undefined
}

// A BLIP record as a pending picture; undefined for one blipFile reads no picture from.
function pendingOf(entry: BlipEntry | undefined): PendingBlip | undefined {
	const record = entry?.blip

	if (entry === undefined || record === undefined) return undefined

	const size = blipSize(entry.data, record)

	return size === undefined ? undefined : { size, decode: () => blipFile(entry.data, record) }
}

// Media parts of the package, deduplicated by source (the same BLIP shown twice is one part, decoded once).
export class MediaStore {
	readonly parts = new Map<string, Uint8Array>()
	readonly types = new Map<string, string>()
	private readonly bySource = new Map<string, Media>()
	private readonly budget: number
	private spent = 0
	private next = 1

	constructor(budget = MEDIA_BUDGET) {
		this.budget = budget
	}

	// The part a picture is written to; undefined for one that does not decode, or once the pictures decoded so far
	// and its bound are past the budget (each charged its bound before decoding, so a failed decode costs too).
	add(source: string, pending: PendingBlip): Media | undefined {
		const known = this.bySource.get(source)

		if (known !== undefined) return known
		if (this.spent + pending.size > this.budget) return undefined

		this.spent += pending.size

		const blip = pending.decode()

		return blip === undefined ? undefined : this.store(source, blip)
	}

	private store(source: string, blip: Blip): Media {
		const extension =
			blip.extension === "jpeg" ? "jpeg" : blip.extension === "pict" ? "pct" : blip.extension === "tiff" ? "tiff" : blip.extension
		const part = `word/media/image${String(this.next++)}.${extension}`
		const media: Media = { part, contentType: blip.contentType, extension }

		this.parts.set(part, blip.bytes)
		this.types.set(extension, blip.contentType)
		this.bySource.set(source, media)

		return media
	}

	// Outside the budget: what stands for a picture the budget leaves out.
	placeholder(): Media {
		return (
			this.bySource.get("placeholder") ??
			this.store("placeholder", { bytes: decodeHex(PLACEHOLDER_PNG), extension: "png", contentType: "image/png" })
		)
	}
}

// 16.16 fixed point (§2.2.? FixedPoint) as a number.
function fixed(value: number | undefined): number {
	return value === undefined ? 0 : (value | 0) / 65536
}

export function crop(shape: ArtShape | undefined): Crop | undefined {
	if (shape === undefined) return undefined

	const side = (pid: number): number => fixed(shape.properties.get(pid)?.value)
	const value = {
		left: side(PID.cropFromLeft),
		top: side(PID.cropFromTop),
		right: side(PID.cropFromRight),
		bottom: side(PID.cropFromBottom)
	}

	return value.left === 0 && value.top === 0 && value.right === 0 && value.bottom === 0 ? undefined : value
}

export interface InlinePicture {
	readonly blip: PendingBlip | undefined
	// Twips as shown (scaled and cropped).
	readonly width: number
	readonly height: number
	readonly crop: Crop | undefined
	readonly shape: ArtShape | undefined
	// The source key for media deduplication: the BLIP store entry's ("bstore:<pib>", as shapeBlip's) or the PICF's.
	readonly source: string
}

const MM_SHAPE = 0x64
const MM_SHAPEFILE = 0x66
const PICF_HEADER = 0x44

// PICF (§2.9.192) at `offset` in the Data stream: header, then for MM_SHAPE / MM_SHAPEFILE an OfficeArt inline
// shape and its BLIPs, else (older files) the metafile itself.
export function inlinePicture(file: DocFile, offset: number, art?: ArtContent): InlinePicture | undefined {
	const data = file.data

	if (data === undefined || offset + PICF_HEADER > data.length) return undefined

	const lcb = le32(data, offset)
	const cbHeader = le16(data, offset + 4)

	if (cbHeader !== PICF_HEADER || lcb < PICF_HEADER || offset + lcb > data.length) return undefined

	const mm = le16(data, offset + 6)
	const goalX = les16(data, offset + 28)
	const goalY = les16(data, offset + 30)
	const scaleX = le16(data, offset + 32)
	const scaleY = le16(data, offset + 34)
	const end = offset + lcb
	let at = offset + PICF_HEADER
	let blip: PendingBlip | undefined
	let source = `data:${String(offset)}`
	let shape: ArtShape | undefined
	let cut: Crop | undefined

	if (mm === MM_SHAPE || mm === MM_SHAPEFILE) {
		if (mm === MM_SHAPEFILE) at += 1 + (data[at] ?? 0)

		const first = records(data, at, end)[0]

		if (first?.type === RT_SP_CONTAINER) {
			shape = readShape(data, first)
			at = first.end
		}

		const store = readBlipStore(data, at, end, file.word)
		const pib = shape?.properties.get(PID.pib)?.value ?? 1
		// The BLIP follows the shape; without one there, pib names an entry of the document's BLIP store.
		const entry = store.length > 0 ? (store[pib - 1] ?? store.find(candidate => candidate.blip !== undefined)) : art?.blips[pib - 1]

		if (store.length === 0) source = `bstore:${String(pib)}`

		blip = pendingOf(entry)

		cut = crop(shape)
	} else {
		// The picture data is a metafile in the mapping mode `mm` ([MS-WMF] METAFILEPICT), stored without a
		// placeable header.
		const bytes = data.subarray(at, end)

		if (bytes.length >= 18)
			blip = { size: bytes.length, decode: () => ({ bytes: bytes.slice(), extension: "wmf", contentType: "image/x-wmf" }) }

		// dxaCropLeft, dyaCropTop, dxaCropRight, dyaCropBottom.
		const left = les16(data, offset + 36)
		const top = les16(data, offset + 38)
		const right = les16(data, offset + 40)
		const bottom = les16(data, offset + 42)

		if (goalX > 0 && goalY > 0 && (left !== 0 || top !== 0 || right !== 0 || bottom !== 0))
			cut = { left: left / goalX, top: top / goalY, right: right / goalX, bottom: bottom / goalY }
	}

	const shownX = Math.max(1, goalX * (1 - (cut?.left ?? 0) - (cut?.right ?? 0)))
	const shownY = Math.max(1, goalY * (1 - (cut?.top ?? 0) - (cut?.bottom ?? 0)))

	return {
		blip,
		width: (shownX * (scaleX === 0 ? 1000 : scaleX)) / 1000,
		height: (shownY * (scaleY === 0 ? 1000 : scaleY)) / 1000,
		crop: cut,
		shape,
		source
	}
}

// The BLIP a floating picture shape shows (its pib in the drawing group's BLIP store).
export function shapeBlip(art: ArtContent, shape: ArtShape): { readonly blip: PendingBlip; readonly source: string } | undefined {
	const pib = shape.properties.get(PID.pib)?.value ?? shape.properties.get(PID.fillBlip)?.value

	if (pib === undefined || pib < 1) return undefined

	const blip = pendingOf(art.blips[pib - 1])

	return blip === undefined ? undefined : { blip, source: `bstore:${String(pib)}` }
}

// An embedded object's presentation from its ObjectPool storage: "\x03META" (a metafile behind an 8-byte
// METAFILEPICT header) or an OLE presentation stream ("\x02OlePres000", [MS-OLEDS] §2.3.4) holding a metafile,
// EMF or DIB.
export function objectPreview(streams: ReadonlyMap<string, Uint8Array>): Blip | undefined {
	const meta = streams.get("\u0003META")

	if (meta !== undefined && meta.length > 8 + 18) return { bytes: meta.slice(8), extension: "wmf", contentType: "image/x-wmf" }

	for (const [name, bytes] of streams) {
		if (!name.startsWith("\u0002OlePres")) continue

		const blip = presentation(bytes)

		if (blip !== undefined) return blip
	}

	return undefined
}

// OLEPresentationStream: AnsiClipboardFormat (a 4-byte marker and a format id, or a string), TargetDeviceSize +
// TargetDevice, Aspect, Lindex, Advf, Reserved1, Width, Height, Size, Data.
function presentation(bytes: Uint8Array): Blip | undefined {
	if (bytes.length < 8) return undefined

	const marker = le32(bytes, 0)
	let at = 4
	let format = 0

	if (marker === 0xffffffff || marker === 0xfffffffe) {
		format = le32(bytes, 4)
		at = 8
	} else if (marker > 0 && marker < 256) {
		// A clipboard format name: not a standard picture format.
		return undefined
	}

	const deviceSize = le32(bytes, at)

	at += 4 + Math.max(0, deviceSize - 4)
	at += 4 + 4 + 4 + 4 + 4 + 4

	const size = le32(bytes, at)
	const data = bytes.subarray(at + 4, Math.min(bytes.length, at + 4 + size))

	// CF_METAFILEPICT 3, CF_DIB 8, CF_ENHMETAFILE 14.
	if (format === 3 && data.length > 18) return { bytes: data.slice(), extension: "wmf", contentType: "image/x-wmf" }
	if (format === 14 && data.length > 88) return { bytes: data.slice(), extension: "emf", contentType: "image/x-emf" }

	return undefined
}
