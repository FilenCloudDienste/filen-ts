import { blipFile, blipKind, blipSize, type ArtProperty, type ArtRecord } from "../doc/toDocx/officeArt"
import {
	OpcPackage,
	writeZip,
	type ByteChunks,
	type ByteSink,
	type ByteSource,
	type Slicing,
	type WriteZipReport,
	type ZipPlanItem
} from "../opc/index"
import type { LinkedPart } from "../opc/package"
import { PresentationError, refused, type Refused } from "../presentation/model"
import { tooLarge } from "../presentation/refusal"
import { encodeUtf8 } from "../xml/utf8"
import { paragraphSpans, pp10Records, timingOf, type PptAnimShape, type PptLegacyBuild } from "./anim"
import { CommentAuthors, commentsXml, slideComments, type PptComment } from "./comments"
import { decryptPicture } from "./decrypt"
import {
	kids,
	openPptFile,
	persistRecord,
	readDocument,
	type BlipStoreEntry,
	type PptFile,
	type HeadersFooters,
	type PptDocument,
	type PptOpenOptions
} from "./document"
import {
	adjustGuides,
	alphaOf,
	artColorOf,
	colorRef,
	colorXml,
	emu,
	EMU_PER_MASTER,
	flag,
	hex,
	isConnector,
	isWordArt,
	lookup,
	msoArray,
	P,
	presetOf,
	value,
	type ColorSources,
	type PptShape,
	type PropertyChain,
	type Rect
} from "./officeArt"
import { PptMedia } from "./media"
import { PptOle } from "./ole"
import { i32, RT, u16, u32, type PptRecord as PptRecordRef } from "./records"
import { PptReport, type PptLoss } from "./report"
import { readSlides, SLIDE_FLAGS, type PptSlide, type PptSlides } from "./slides"
import {
	listStyleXml,
	mergeChar,
	mergePara,
	paragraphsXml,
	TEXT_TYPE,
	xmlText,
	type Interaction,
	type Ruler,
	type StyleLevel,
	type TextBlock,
	type TextEmitContext
} from "./text"
import { transitionXml } from "./transitions"

// A PowerPoint 97–2003 deck as an in-memory PresentationML package ([MS-PPT] → ECMA-376 Part 1 §19), the doc→docx
// pattern: the pptx reader then reads it, so viewing, rendering, conversion and Save as are one path. Main masters
// become slide masters with a theme of their colour scheme and txStyles of their TextMasterStyleAtoms; title masters
// and each slide layout in use become slide layouts; slides, notes and the notes master follow, every shape with its
// position, geometry, fill, line, shadow and text. Colours are written resolved through the scheme of the slide that
// shows them. Pictures stay in the Pictures stream until read. What does not convert is counted in the report.

export interface PptConversion {
	readonly kind: "converted"
	readonly pptx: OpcPackage
	readonly losses: readonly PptLoss[]
	readonly slides: number
	readonly encrypted: boolean
	// Wipes the key an encrypted file's pictures are decrypted with when read; its pictures cannot be read after.
	release(): void
}

const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const ROOT_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`
const CT = {
	presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
	slideshow: "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
	template: "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
	slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
	layout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
	master: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
	notes: "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
	notesMaster: "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml",
	handoutMaster: "application/vnd.openxmlformats-officedocument.presentationml.handoutMaster+xml",
	theme: "application/vnd.openxmlformats-officedocument.theme+xml",
	presProps: "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml",
	comments: "application/vnd.openxmlformats-officedocument.presentationml.comments+xml",
	commentAuthors: "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml",
	rels: "application/vnd.openxmlformats-package.relationships+xml"
} as const

class Rels {
	private readonly list: string[] = []
	private readonly byKey = new Map<string, string>()

	add(type: string, target: string, external = false): string {
		const key = `${type} ${target} ${String(external)}`
		const held = this.byKey.get(key)

		if (held !== undefined) return held

		const id = `rId${String(this.list.length + 1)}`

		this.list.push(
			`<Relationship Id="${id}" Type="${REL}/${type}" Target="${xmlText(target)}"${external ? ' TargetMode="External"' : ""}/>`
		)
		this.byKey.set(key, id)

		return id
	}

	xml(): string {
		return `${DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.list.join("")}</Relationships>`
	}
}

interface Picture {
	readonly extension: string
	readonly contentType: string
	readonly size: number
	readonly read: () => Promise<Uint8Array>
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	emf: "image/x-emf",
	wmf: "image/x-wmf",
	pict: "image/pict",
	jpeg: "image/jpeg",
	png: "image/png",
	bmp: "image/bmp",
	tiff: "image/tiff"
}

// rh, two UIDs and an OfficeArtMetafileHeader: every byte blipSize reads.
const BLIP_HEAD = 8 + 32 + 34

// A picture over a BLIP record, decoded when its part is read and never kept: only the record's headers are read
// here, so a deck holds no picture until it is shown. Its size is blipSize's (an upper bound for a compressed
// metafile), which the package's limits check before any part is read.
function lazyPicture(record: ArtRecord, head: Uint8Array, load: () => Promise<Uint8Array>): Picture | undefined {
	const kind = blipKind(record.type)
	const size = blipSize(head, record)

	if (kind === undefined || size === undefined) return undefined

	return {
		extension: kind.extension,
		contentType: CONTENT_TYPES[kind.extension] ?? kind.contentType,
		size,
		read: async () => {
			const blip = blipFile(await load(), record)

			if (blip === undefined) throw new PresentationError("malformed", "a picture could not be read")

			return blip.bytes
		}
	}
}

// The picture of a BLIP store entry, embedded or in the Pictures stream (decrypted per read when the file is
// encrypted). Undefined when the entry holds none that can be read.
async function describeBlip(entry: BlipStoreEntry, document: PptDocument): Promise<Picture | undefined> {
	const file = document.file

	if (entry.embedded !== undefined) {
		const { data, type, instance, start, end } = entry.embedded

		return lazyPicture({ type, instance, version: 0, start, end }, data, () => Promise.resolve(data))
	}

	const pictures = file.pictures
	const delay = entry.delay

	if (pictures === undefined || delay === undefined || delay.offset + 8 > pictures.size) return undefined

	const size = delay.size === 0 ? pictures.size - delay.offset : Math.min(delay.size, pictures.size - delay.offset)
	const read = (offset: number, length: number): Promise<Uint8Array> => {
		if (offset + length > pictures.size) throw new PresentationError("malformed", "a picture runs past the Pictures stream")

		return pictures.read(offset, length)
	}
	const key = file.key

	if (key !== undefined) {
		const head = await decryptPicture(read, delay.offset, size, key, true)
		const length = u32(head, 4)
		const record = { type: u16(head, 2), instance: u16(head, 0) >> 4, version: 0, start: 8, end: 8 + length }

		return lazyPicture(record, head, () => decryptPicture(read, delay.offset, size, key))
	}

	const head = await read(delay.offset, Math.min(pictures.size - delay.offset, BLIP_HEAD))
	const length = u32(head, 4)

	if (length + 8 > size) return undefined

	const record = { type: u16(head, 2), instance: u16(head, 0) >> 4, version: 0, start: 8, end: 8 + length }

	return lazyPicture(record, head, () => read(delay.offset, 8 + length))
}

// --- Shapes ---

// PlaceholderEnum (§2.13.21) → ST_PlaceholderType and orientation.
const PLACEHOLDERS: ReadonlyMap<number, readonly [string, string?]> = new Map([
	[1, ["title"]],
	[2, ["body"]],
	[3, ["ctrTitle"]],
	[4, ["subTitle"]],
	[5, ["sldImg"]],
	[6, ["body"]],
	[7, ["dt"]],
	[8, ["sldNum"]],
	[9, ["ftr"]],
	[10, ["hdr"]],
	[11, ["sldImg"]],
	[12, ["body"]],
	[13, ["title"]],
	[14, ["body"]],
	[15, ["ctrTitle"]],
	[16, ["subTitle"]],
	[17, ["title", "vert"]],
	[18, ["body", "vert"]],
	[19, ["obj"]],
	[20, ["chart"]],
	[21, ["tbl"]],
	[22, ["clipArt"]],
	[23, ["dgm"]],
	[24, ["media"]],
	[25, ["obj", "vert"]],
	[26, ["pic"]]
])

const SIZES = ["full", "half", "quarter"]
const DASHES = [
	"solid",
	"sysDash",
	"sysDot",
	"sysDashDot",
	"sysDashDotDot",
	"dot",
	"dash",
	"lgDash",
	"dashDot",
	"lgDashDot",
	"lgDashDotDot"
]
const ARROWS = ["none", "triangle", "stealth", "diamond", "oval", "arrow"]
const ARROW_SIZES = ["sm", "med", "lg"]
const COMPOUNDS = ["sng", "dbl", "thickThin", "thinThick", "tri"]
const ANCHORS: readonly (readonly [string, boolean])[] = [
	["t", false],
	["ctr", false],
	["b", false],
	["t", true],
	["ctr", true],
	["b", true],
	["t", false],
	["b", false],
	["t", true],
	["b", true]
]
const FLOWS = ["horz", "vert", "vert270", "eaVert", "horz", "eaVert"]
const JUMPS = ["", "nextslide", "previousslide", "firstslide", "lastslide", "lastslideviewed", "endshow"]

interface PartContext {
	readonly rels: Rels
	readonly scheme: readonly number[]
	readonly kind: "slide" | "layout" | "master" | "notes" | "notesMaster"
	// 1-based slide number (slides); undefined on masters and layouts.
	readonly slideNumber: number | undefined
	// The slide list's text bodies of this slide (OutlineTextRefAtom indices).
	readonly outline: readonly TextBlock[]
	// Master shapes by spid (hspMaster).
	readonly masterShapes: ReadonlyMap<number, PptShape>
	readonly text: TextEmitContext
	// Placeholder text types whose style the part's family does not imply get a lstStyle.
	readonly placeholderRulers: ReadonlyMap<number, Ruler>
	// The id of the next shape (cNvPr ids stay unique when spids repeat).
	readonly ids: Set<number>
}

function round(value: number): number {
	return Math.round(value)
}

// The rectangle of a shape as DrawingML places it: a rotation of 45°–135° or 225°–315° stores the rectangle turned by
// 90° about its centre (MS-ODRAW §2.3.18.5), so its width and height swap back.
function placement(rect: Rect, rotation: number): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
	const width = rect.right - rect.left
	const height = rect.bottom - rect.top
	const turned = ((rotation % 360) + 360) % 360
	const swap = (turned >= 45 && turned < 135) || (turned >= 225 && turned < 315)

	if (!swap) return { x: rect.left, y: rect.top, w: width, h: height }

	const cx = rect.left + width / 2
	const cy = rect.top + height / 2

	return { x: cx - height / 2, y: cy - width / 2, w: height, h: width }
}

function rotationOf(chain: PropertyChain): number {
	const raw = value(chain, P.rotation)

	return raw === undefined ? 0 : (raw | 0) / 65536
}

class Converter {
	readonly parts = new Map<string, Uint8Array | LinkedPart>()
	readonly overrides = new Map<string, string>()
	readonly defaults = new Map<string, string>([
		["rels", CT.rels],
		["xml", "application/xml"]
	])
	readonly report = new PptReport()
	private readonly media = new Map<number, string | null>()
	private readonly mediaParts = new Map<string, Picture>()
	private mediaCount = 0
	// Characters written across the deck (a body of the slide list may be referenced by many shapes), §1.12.
	private characters = 0

	readonly document: PptDocument
	readonly pictures: readonly (Picture | undefined)[]
	readonly slidePartOf: ReadonlyMap<number, string>
	readonly sounds: PptMedia
	readonly ole: PptOle
	readonly authors = new CommentAuthors()

	constructor(
		document: PptDocument,
		pictures: readonly (Picture | undefined)[],
		slidePartOf: ReadonlyMap<number, string>,
		documentRecords: readonly PptRecordRef[]
	) {
		this.document = document
		this.pictures = pictures
		this.slidePartOf = slidePartOf
		this.sounds = new PptMedia(document.file.stream, documentRecords, document.file.counter)
		this.ole = new PptOle(document.file, documentRecords, this.report)
	}

	add(name: string, xml: string, contentType: string): void {
		this.parts.set(name, encodeUtf8(xml))
		this.overrides.set(`/${name}`, contentType)
	}

	addRels(part: string, rels: Rels): void {
		const slash = part.lastIndexOf("/")

		this.parts.set(`${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`, encodeUtf8(rels.xml()))
	}

	// The media part of BLIP store entry `pib` (1-based), relative to a part in ppt/<dir>/; undefined when unreadable.
	picture(pib: number, slide: number | undefined): string | undefined {
		const held = this.media.get(pib)

		if (held !== undefined) return held ?? undefined

		const picture = this.pictures[pib - 1]

		if (picture === undefined) {
			this.media.set(pib, null)
			this.report.note("picture", slide)

			return undefined
		}

		if (picture.extension === "pict") this.report.note("picture", slide)

		const name = `ppt/media/image${String(++this.mediaCount)}.${picture.extension}`

		this.mediaParts.set(name, picture)
		this.defaults.set(picture.extension, picture.contentType)
		this.media.set(pib, name)

		return name
	}

	finishMedia(): void {
		for (const [name, picture] of this.mediaParts) this.parts.set(name, { size: picture.size, read: picture.read })
	}

	// --- Fill, line, effects ---

	fill(chain: PropertyChain, scheme: readonly number[], context: PartContext | undefined): string {
		if (!(flag(chain, P.fillStyleBooleans, 4) ?? true)) return "<a:noFill/>"

		const sources: ColorSources = { scheme, chain }
		const type = value(chain, P.fillType) ?? 0
		const color = artColorOf(sources, P.fillColor)
		const alpha = alphaOf(value(chain, P.fillOpacity))

		switch (type) {
			case 1: {
				this.report.note("patternFill", context?.slideNumber)

				return `<a:pattFill prst="pct50"><a:fgClr>${colorXml(color, alpha)}</a:fgClr><a:bgClr>${colorXml(artColorOf(sources, P.fillBackColor), alphaOf(value(chain, P.fillBackOpacity)))}</a:bgClr></a:pattFill>`
			}
			case 2:
			case 3: {
				const pib = value(chain, P.fillBlip)
				const part = pib === undefined || context === undefined ? undefined : this.picture(pib, context.slideNumber)

				if (part === undefined || context === undefined) return `<a:solidFill>${colorXml(color, alpha)}</a:solidFill>`

				const id = context.rels.add("image", `../media/${part.slice(part.lastIndexOf("/") + 1)}`)

				return `<a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${id}"/>${type === 2 ? '<a:srcRect/><a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/>' : "<a:srcRect/><a:stretch><a:fillRect/></a:stretch>"}</a:blipFill>`
			}
			case 4:
			case 5:
			case 6:
			case 7:
			case 8:
				return this.gradient(chain, sources, type, color, alpha)
			case 9:
				return `<a:solidFill>${colorXml(scheme[0] ?? 0xffffff)}</a:solidFill>`
			default:
				return `<a:solidFill>${colorXml(color, alpha)}</a:solidFill>`
		}
	}

	private gradient(chain: PropertyChain, sources: ColorSources, type: number, first: number, alpha: number | undefined): string {
		const last = artColorOf(sources, P.fillBackColor)
		const lastAlpha = alphaOf(value(chain, P.fillBackOpacity))
		const stops: [number, number, number | undefined][] = []
		const shades = msoArray(lookup(chain, P.fillShadeColors)?.complex)

		if (shades !== undefined && shades.size === 8 && shades.count >= 2) {
			// MS-ODRAW §2.3.7.27: (colour, position as FixedPoint 0–1) pairs.
			for (let k = 0; k < shades.count; k++) {
				const color = colorRef(sources, u32(shades.data, 8 * k))
				const position = Math.max(0, Math.min(100000, Math.round((u32(shades.data, 8 * k + 4) * 100000) / 65536)))

				stops.push([position, color, undefined])
			}
		} else {
			const focus = Math.max(-100, Math.min(100, i32Value(value(chain, P.fillFocus))))
			const [a, b, aAlpha, bAlpha] = focus >= 0 ? [first, last, alpha, lastAlpha] : [last, first, lastAlpha, alpha]
			const at = Math.abs(focus) * 1000

			if (at > 0) stops.push([0, a, aAlpha])

			stops.push([at, b, bAlpha])

			if (at < 100000) stops.push([100000, a, aAlpha])
		}

		const list = stops
			.map(([position, color, stopAlpha]) => `<a:gs pos="${String(position)}">${colorXml(color, stopAlpha)}</a:gs>`)
			.join("")

		if (type === 5 || type === 6 || type === 8) {
			const to = (pid: number): number => Math.round(((value(chain, pid) ?? 0) * 100000) / 65536)
			const l = to(P.fillToLeft)
			const t = to(P.fillToTop)
			const r = 100000 - to(P.fillToRight)
			const b = 100000 - to(P.fillToBottom)

			return `<a:gradFill rotWithShape="1"><a:gsLst>${list}</a:gsLst><a:path path="${type === 6 ? "shape" : "rect"}"><a:fillToRect l="${String(l)}" t="${String(t)}" r="${String(r)}" b="${String(b)}"/></a:path></a:gradFill>`
		}

		// fillAngle: counterclockwise from a bottom-to-top vector; ST_PositiveFixedAngle is clockwise from left-to-right.
		const angle = (i32Value(value(chain, P.fillAngle)) / 65536) | 0
		const degrees = (((270 - angle) % 360) + 360) % 360

		return `<a:gradFill rotWithShape="1"><a:gsLst>${list}</a:gsLst><a:lin ang="${String(degrees * 60000)}" scaled="0"/></a:gradFill>`
	}

	line(chain: PropertyChain, scheme: readonly number[], element = "ln"): string {
		if (!(flag(chain, P.lineStyleBooleans, 3) ?? true)) return `<a:${element}><a:noFill/></a:${element}>`

		const sources: ColorSources = { scheme, chain }
		const width = Math.max(0, Math.min(20116800, value(chain, P.lineWidth) ?? 9525))
		const compound = COMPOUNDS[value(chain, P.lineStyle) ?? 0] ?? "sng"
		const cap = ["rnd", "sq", "flat"][value(chain, P.lineEndCapStyle) ?? 2] ?? "flat"
		const dash = DASHES[value(chain, P.lineDashing) ?? 0] ?? "solid"
		const join = ["<a:bevel/>", '<a:miter lim="800000"/>', "<a:round/>"][value(chain, P.lineJoinStyle) ?? 2] ?? "<a:round/>"
		const end = (head: number, widthPid: number, lengthPid: number, element: string): string => {
			const kind = ARROWS[value(chain, head) ?? 0] ?? "none"

			if (kind === "none") return ""

			return `<a:${element} type="${kind}" w="${ARROW_SIZES[value(chain, widthPid) ?? 1] ?? "med"}" len="${ARROW_SIZES[value(chain, lengthPid) ?? 1] ?? "med"}"/>`
		}
		const arrows =
			end(P.lineStartArrowhead, P.lineStartArrowWidth, P.lineStartArrowLength, "headEnd") +
			end(P.lineEndArrowhead, P.lineEndArrowWidth, P.lineEndArrowLength, "tailEnd")

		return `<a:${element} w="${String(width)}" cap="${cap}" cmpd="${compound}"><a:solidFill>${colorXml(artColorOf(sources, P.lineColor), alphaOf(value(chain, P.lineOpacity)))}</a:solidFill><a:prstDash val="${dash}"/>${join}${element === "ln" ? arrows : ""}</a:${element}>`
	}

	effects(chain: PropertyChain, scheme: readonly number[]): string {
		if (!(flag(chain, P.shadowStyleBooleans, 1) ?? false)) return ""

		const sources: ColorSources = { scheme, chain }
		const x = i32Value(value(chain, P.shadowOffsetX) ?? 25400)
		const y = i32Value(value(chain, P.shadowOffsetY) ?? 25400)
		const distance = Math.min(2147483647, Math.round(Math.hypot(x, y)))
		const direction = Math.round(((((Math.atan2(y, x) * 180) / Math.PI) % 360) + 360) % 360) * 60000

		return `<a:effectLst><a:outerShdw dist="${String(distance)}" dir="${String(direction)}" algn="ctr" rotWithShape="0">${colorXml(artColorOf(sources, P.shadowColor), alphaOf(value(chain, P.shadowOpacity)))}</a:outerShdw></a:effectLst>`
	}

	// --- Geometry ---

	geometry(shape: PptShape, chain: PropertyChain, context: PartContext): string {
		const vertices = msoArray(lookup(chain, P.pVertices)?.complex)

		if (vertices !== undefined && vertices.count > 0 && (shape.shapeType === 0 || presetOf(shape.shapeType) === undefined)) {
			return this.customGeometry(chain, vertices, context)
		}

		const preset = presetOf(shape.shapeType) ?? "rect"

		return `<a:prstGeom prst="${preset}"><a:avLst>${adjustGuides(chain, shape.shapeType)}</a:avLst></a:prstGeom>`
	}

	private customGeometry(
		chain: PropertyChain,
		vertices: { readonly count: number; readonly size: number; readonly data: Uint8Array },
		context: PartContext
	): string {
		const left = i32Value(value(chain, P.geoLeft))
		const top = i32Value(value(chain, P.geoTop))
		const right = i32Value(value(chain, P.geoRight) ?? 21600)
		const bottom = i32Value(value(chain, P.geoBottom) ?? 21600)
		const width = Math.max(1, right - left)
		const height = Math.max(1, bottom - top)
		const points: [number, number][] = []

		for (let k = 0; k < vertices.count; k++) {
			const at = k * vertices.size
			const x = vertices.size >= 8 ? i32(vertices.data, at) : (u16(vertices.data, at) << 16) >> 16
			const y = vertices.size >= 8 ? i32(vertices.data, at + 4) : (u16(vertices.data, at + 2) << 16) >> 16

			// A coordinate that names a guide (0x80000000–0x8000007F) has no value without the guides: the origin.
			points.push([x >= -0x80000000 && x <= -0x7fffff81 ? left : x, y >= -0x80000000 && y <= -0x7fffff81 ? top : y])
		}

		const point = (index: number): string => {
			const [x, y] = points[Math.min(index, points.length - 1)] ?? [left, top]

			return `<a:pt x="${String(round(x - left))}" y="${String(round(y - top))}"/>`
		}
		const segments = msoArray(lookup(chain, P.pSegmentInfo)?.complex)
		const paths: string[] = []
		let current = ""
		let next = 0
		let fill = true
		let stroke = true
		const close = (): void => {
			if (current !== "")
				paths.push(
					`<a:path w="${String(width)}" h="${String(height)}"${fill ? "" : ' fill="none"'}${stroke ? "" : ' stroke="false"'}>${current}</a:path>`
				)

			current = ""
		}

		if (segments === undefined || segments.size !== 2) {
			const closed = (value(chain, P.shapePath) ?? 1) % 2 === 1

			current = `<a:moveTo>${point(0)}</a:moveTo>`

			for (let k = 1; k < points.length; k++) current += `<a:lnTo>${point(k)}</a:lnTo>`

			if (closed) current += "<a:close/>"

			close()
		} else {
			let commands = 0

			for (let k = 0; k < segments.count; k++) {
				const info = u16(segments.data, 2 * k)
				const type = info >>> 13
				const count = info & 0x1fff

				if (++commands > 100_000) break

				switch (type) {
					case 0:
						for (let n = 0; n < Math.max(1, count); n++) current += `<a:lnTo>${point(next++)}</a:lnTo>`
						break
					case 1:
						for (let n = 0; n < Math.max(1, count); n++) {
							current += `<a:cubicBezTo>${point(next)}${point(next + 1)}${point(next + 2)}</a:cubicBezTo>`
							next += 3
						}

						break
					case 2:
						current += `<a:moveTo>${point(next++)}</a:moveTo>`
						break
					case 3:
						current += "<a:close/>"
						break
					case 4:
						close()
						fill = true
						stroke = true
						break
					default: {
						// §2.2.54: the escape code in bits 8–12, its POINT count in the low byte.
						const escape = (info >>> 8) & 0x1f
						const used = info & 0xff

						if (escape === 0x0a) fill = false
						else if (escape === 0x0b) stroke = false
						else if (used > 0) {
							this.report.note("customGeometry", context.slideNumber)

							for (let n = 0; n < used; n++) current += `<a:lnTo>${point(next++)}</a:lnTo>`
						}
					}
				}
			}

			close()
		}

		if (paths.length === 0) paths.push(`<a:path w="${String(width)}" h="${String(height)}"/>`)

		return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>${paths.join("")}</a:pathLst></a:custGeom>`
	}

	// --- Text ---

	link(interaction: Interaction, rels: Rels, slide: number | undefined): string {
		return this.action(interaction, rels, slide, "hlinkClick")
	}

	action(interaction: Interaction, rels: Rels, slide: number | undefined, element: string): string {
		switch (interaction.action) {
			case 3: {
				const jump = JUMPS[interaction.jump] ?? ""

				return jump === "" ? "" : `<a:${element} r:id="" action="ppaction://hlinkshowjump?jump=${jump}"/>`
			}
			case 4: {
				// §2.13.15 LinkToEnum: next, previous, first and last slide are jumps.
				if (interaction.hyperlinkType <= 3) {
					return `<a:${element} r:id="" action="ppaction://hlinkshowjump?jump=${JUMPS[interaction.hyperlinkType + 1] ?? "nextslide"}"/>`
				}

				const link = this.document.hyperlinks.get(interaction.hyperlink)

				if (link === undefined) return ""

				// §2.10.16: a location "slideId,slideNumber,title" jumps to a slide of this deck.
				const target = link.target ?? ""
				const location = link.location ?? ""

				if (interaction.hyperlinkType === 7 || (target === "" && location !== "")) {
					const slideId = Number.parseInt(location.split(",")[0] ?? "", 10)
					const part = this.slidePartOf.get(slideId)

					if (part === undefined) return ""

					return `<a:${element} r:id="${rels.add("slide", `../slides/${part}`)}" action="ppaction://hlinksldjump"/>`
				}

				if (target === "") return ""

				return `<a:${element} r:id="${rels.add("hyperlink", target, true)}"/>`
			}
			case 7: {
				// A named show (§2.6.11), by its place in p:custShowLst (the custShow id written below).
				const index = this.document.namedShows.findIndex(show => show.name === interaction.name)

				if (index < 0) return ""

				return `<a:${element} r:id="" action="ppaction://customshow?id=${String(index)}&amp;return=${interaction.returns ? "true" : "false"}"/>`
			}
			// A macro, a program or an OLE verb is carried as PowerPoint writes it, so the reader classifies it refused
			// (inert, shown with its reason, a notice when clicked in the show), never run.
			case 1:
				return `<a:${element} r:id="" action="ppaction://macro?name=${xmlText(interaction.name ?? "")}"/>`
			case 2: {
				const program = interaction.name ?? ""

				return `<a:${element} r:id="${program === "" ? "" : rels.add("hyperlink", program, true)}" action="ppaction://program"/>`
			}
			case 5:
				return `<a:${element} r:id="" action="ppaction://ole?verb=${String(interaction.oleVerb)}"/>`
			// §2.13.13 II_MediaAction: the shape's own movie or sound plays.
			case 6:
				return `<a:${element} r:id="" action="ppaction://media"/>`
			case 0:
				return ""
			default:
				this.report.note("action", slide)

				return ""
		}
	}

	textBody(chain: PropertyChain, context: PartContext, block: TextBlock | undefined, placeholderType: string | undefined): string {
		const insets = [P.dxTextLeft, P.dyTextTop, P.dxTextRight, P.dyTextBottom].map((pid, index) => {
			const raw = value(chain, pid)

			return raw === undefined ? (index % 2 === 0 ? 91440 : 45720) : Math.max(0, i32Value(raw))
		})
		const [anchor, centered] = ANCHORS[value(chain, P.anchorText) ?? 0] ?? ["t", false]
		const flow = FLOWS[value(chain, P.txflTextFlow) ?? 0] ?? "horz"
		const wrap = (value(chain, P.wrapText) ?? 0) === 2 ? "none" : "square"
		const fit = flag(chain, P.textBooleans, 1) === true ? "<a:spAutoFit/>" : ""
		const bodyPr = `<a:bodyPr wrap="${wrap}" lIns="${String(insets[0])}" tIns="${String(insets[1])}" rIns="${String(insets[2])}" bIns="${String(insets[3])}"${flow === "horz" ? "" : ` vert="${flow}"`} rtlCol="0" anchor="${anchor}"${centered ? ' anchorCtr="1"' : ""}>${fit}</a:bodyPr>`

		if (block === undefined) return `<p:txBody>${bodyPr}<a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody>`

		if (block.damaged === true) this.report.note("damagedContent", context.slideNumber)

		this.characters += block.text.length

		if (this.characters > this.document.file.deckBudgets.charactersPerDeck)
			tooLarge("characters per deck", this.document.file.deckBudgets.charactersPerDeck)

		const lstStyle = this.listStyleFor(block.type, placeholderType, context)

		return `<p:txBody>${bodyPr}${lstStyle}${paragraphsXml(block, context.text, this.document.defaultRuler) || "<a:p/>"}</p:txBody>`
	}

	// A lstStyle carrying the master style of a text type the pptx would not inherit: centred title and body, half and
	// quarter bodies, and text whose type is not its shape's family (a body's text in a plain shape).
	private listStyleFor(type: number, placeholderType: string | undefined, context: PartContext): string {
		const family = familyOf(placeholderType, context.kind)

		if (family === type || context.kind === "master" || context.kind === "notesMaster") return "<a:lstStyle/>"

		return `<a:lstStyle>${listStyleXml(type, context.text, context.placeholderRulers.get(type))}</a:lstStyle>`
	}

	// --- Shapes ---

	nextId(context: PartContext, spid: number): number {
		let id = spid > 0 && spid < 2147483647 ? spid : 1

		while (context.ids.has(id)) id++

		context.ids.add(id)

		return id
	}

	// `scale`: EMU per unit of the coordinate space the shape is placed in (master units on a slide, a group's own
	// units inside it).
	shapeXml(shape: PptShape, context: PartContext, child: boolean, scale = EMU_PER_MASTER): string {
		const master = shape.properties.get(P.hspMaster)?.value
		const masterShape = master === undefined ? undefined : context.masterShapes.get(master)
		const chain: PropertyChain =
			masterShape === undefined
				? [shape.properties, this.document.defaults]
				: [shape.properties, masterShape.properties, this.document.defaults]
		const rotation = rotationOf(chain)
		// A group written without an anchor places its members in its own coordinate space as they are (PowerPoint draws
		// them there; LibreOffice 7.5 leaves the group out).
		const rect = (child ? shape.childAnchor : shape.anchor) ?? (shape.children === undefined ? undefined : shape.groupRect)
		const box = rect === undefined ? undefined : placement(rect, rotation)
		const flipH = (shape.flags & 0x40) !== 0
		const flipV = (shape.flags & 0x80) !== 0
		const xfrmAttributes = `${rotation === 0 ? "" : ` rot="${String(Math.round((((rotation % 360) + 360) % 360) * 60000))}"`}${flipH ? ' flipH="1"' : ""}${flipV ? ' flipV="1"' : ""}`
		const offExt =
			box === undefined
				? ""
				: `<a:off x="${String(Math.round(box.x * scale))}" y="${String(Math.round(box.y * scale))}"/><a:ext cx="${String(Math.max(0, Math.round(box.w * scale)))}" cy="${String(Math.max(0, Math.round(box.h * scale)))}"/>`
		const id = this.nextId(context, shape.spid)
		const name = textProperty(lookup(chain, P.wzName)) ?? `${shape.children === undefined ? "Shape" : "Group"} ${String(id)}`
		const description = textProperty(shape.properties.get(P.wzDescription))
		const hidden = flag([shape.properties], P.groupShapeBooleans, 1) === true
		const click = shape.click === undefined ? "" : this.action(shape.click, context.rels, context.slideNumber, "hlinkClick")
		const hover = shape.hover === undefined ? "" : this.action(shape.hover, context.rels, context.slideNumber, "hlinkHover")
		const cNvPr = `<p:cNvPr id="${String(id)}" name="${xmlText(name)}"${description === undefined ? "" : ` descr="${xmlText(description)}"`}${hidden ? ' hidden="1"' : ""}${click + hover === "" ? "/>" : `>${click}${hover}</p:cNvPr>`}`

		if (
			shape.children !== undefined &&
			box !== undefined &&
			shape.groupRect !== undefined &&
			((value([shape.properties], P.tableProperties) ?? 0) & 1) !== 0
		) {
			const table = this.tableXml(shape.children, shape.groupRect, box, context, cNvPr, scale)

			if (table !== undefined) return table
		}

		if (shape.children !== undefined) {
			const group = shape.groupRect
			const inner = childScale(shape)
			const xfrm =
				box === undefined || group === undefined
					? ""
					: `<a:xfrm${xfrmAttributes}>${offExt}<a:chOff x="${String(Math.round(group.left * inner))}" y="${String(Math.round(group.top * inner))}"/><a:chExt cx="${String(Math.max(0, Math.round((group.right - group.left) * inner)))}" cy="${String(Math.max(0, Math.round((group.bottom - group.top) * inner)))}"/></a:xfrm>`
			const members = shape.children.map(member => this.shapeXml(member, context, true, inner)).join("")

			return `<p:grpSp><p:nvGrpSpPr>${cNvPr}<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${xfrm}</p:grpSpPr>${members}</p:grpSp>`
		}

		const xfrm = box === undefined ? "" : `<a:xfrm${xfrmAttributes}>${offExt}</a:xfrm>`
		const placeholder = shape.placeholder === undefined ? undefined : PLACEHOLDERS.get(shape.placeholder.type)
		const ph =
			placeholder === undefined || shape.placeholder === undefined
				? ""
				: `<p:ph type="${placeholder[0]}"${placeholder[1] === undefined ? "" : ` orient="${placeholder[1]}"`}${shape.placeholder.size > 0 && shape.placeholder.size < 3 ? ` sz="${SIZES[shape.placeholder.size] ?? "full"}"` : ""}${placeholder[0] === "title" || placeholder[0] === "ctrTitle" || shape.placeholder.position < 0 ? "" : ` idx="${String(shape.placeholder.position)}"`}/>`
		// A movie's ExMediaAtom sits in its ExVideoContainer: the media reader finds those the document list does not.
		const media =
			shape.exObjRef !== undefined &&
			(this.document.media.has(shape.exObjRef) || this.sounds.mediaObject(shape.exObjRef) !== undefined)
		const ole = (shape.flags & 0x10) !== 0 || (shape.exObjRef !== undefined && this.document.oleObjects.has(shape.exObjRef))
		const pib = value(chain, P.pib)

		const exObjRef = shape.exObjRef
		const add = (type: string, target: string, external?: boolean): string => context.rels.add(type, target, external === true)
		const part = pib !== undefined && pib > 0 ? this.picture(pib, context.slideNumber) : undefined

		if (part !== undefined) {
			if (media && exObjRef !== undefined) {
				const element = this.sounds.nvPrXml(exObjRef, add)

				if (element === undefined) this.report.note("media", context.slideNumber)

				return this.pictureXml(shape, chain, context, cNvPr, ph, xfrm, part, element ?? "")
			}

			if (ole) {
				const frame =
					exObjRef === undefined
						? undefined
						: this.ole.frameXml(
								exObjRef,
								{
									cNvPr,
									xfrm: box === undefined ? "" : `<p:xfrm${xfrmAttributes}>${offExt}</p:xfrm>`,
									ph,
									picture: this.pictureXml(shape, chain, context, '<p:cNvPr id="0" name=""/>', "", xfrm, part)
								},
								add,
								context.slideNumber
							)

				if (frame !== undefined) return frame

				this.report.note("oleObject", context.slideNumber)
			}

			return this.pictureXml(shape, chain, context, cNvPr, ph, xfrm, part)
		}

		if (media) this.report.note("media", context.slideNumber)
		else if (ole) this.report.note("oleObject", context.slideNumber)

		const block = shape.outlineRef !== undefined ? context.outline[shape.outlineRef] : shape.text
		const wordArt = isWordArt(shape.shapeType) ? textProperty(lookup(chain, P.gtextUNICODE)) : undefined
		const connector = isConnector(shape.shapeType)
		const spPr = `<p:spPr>${xfrm}${this.geometry(shape, chain, context)}${wordArt === undefined ? this.fill(chain, context.scheme, context) : "<a:noFill/>"}${wordArt === undefined ? this.line(chain, context.scheme) : "<a:ln><a:noFill/></a:ln>"}${this.effects(chain, context.scheme)}</p:spPr>`

		if (connector && block === undefined) {
			return `<p:cxnSp><p:nvCxnSpPr>${cNvPr}<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>${spPr}</p:cxnSp>`
		}

		let txBody = ""

		if (wordArt !== undefined) {
			this.report.note("wordArt", context.slideNumber)
			txBody = this.wordArtBody(wordArt, chain, context, box)
		} else if (block !== undefined || placeholder !== undefined) {
			txBody = this.textBody(chain, context, block, placeholder?.[0])
		}

		const textBox = shape.shapeType === 202 && placeholder === undefined ? ' txBox="1"' : ""

		return `<p:sp><p:nvSpPr>${cNvPr}<p:cNvSpPr${textBox}/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>${spPr}${txBody}</p:sp>`
	}

	// A group PowerPoint marks as a table (MS-ODRAW §2.2.59 fIsTable) as a:tbl: the grid from its cells' edges, each
	// cell's span, fill, margins and text, and its borders from the group's line shapes along the cell edges.
	private tableXml(
		members: readonly PptShape[],
		space: Rect,
		box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
		context: PartContext,
		cNvPr: string,
		scale: number
	): string | undefined {
		const cells = members.filter(
			member =>
				member.children === undefined &&
				member.childAnchor !== undefined &&
				member.shapeType !== 20 &&
				!isConnector(member.shapeType)
		)
		const lines = members.filter(
			member => member.childAnchor !== undefined && (member.shapeType === 20 || isConnector(member.shapeType))
		)

		if (cells.length === 0 || cells.length + lines.length !== members.length) return undefined

		const tolerance = 2
		const edges = (values: number[]): number[] => {
			const sorted = [...values].sort((a, b) => a - b)
			const out: number[] = []

			for (const value of sorted) if (out.length === 0 || value - (out[out.length - 1] ?? 0) > tolerance) out.push(value)

			return out
		}
		const xs = edges(cells.flatMap(cell => [cell.childAnchor?.left ?? 0, cell.childAnchor?.right ?? 0]))
		const ys = edges(cells.flatMap(cell => [cell.childAnchor?.top ?? 0, cell.childAnchor?.bottom ?? 0]))
		const indexOf = (list: readonly number[], value: number): number => list.findIndex(edge => Math.abs(edge - value) <= tolerance)
		const columns = xs.length - 1
		const rows = ys.length - 1

		if (columns < 1 || rows < 1 || columns * rows > 100_000) return undefined

		const grid: (PptShape | undefined)[] = new Array<PptShape | undefined>(columns * rows)
		const spans = new Map<PptShape, { readonly r0: number; readonly c0: number; readonly r1: number; readonly c1: number }>()

		for (const cell of cells) {
			const anchor = cell.childAnchor

			if (anchor === undefined) return undefined

			const c0 = indexOf(xs, anchor.left)
			const c1 = indexOf(xs, anchor.right)
			const r0 = indexOf(ys, anchor.top)
			const r1 = indexOf(ys, anchor.bottom)

			if (c0 < 0 || r0 < 0 || c1 <= c0 || r1 <= r0) return undefined

			for (let r = r0; r < r1; r++)
				for (let c = c0; c < c1; c++) {
					if (grid[r * columns + c] !== undefined) return undefined

					grid[r * columns + c] = cell
				}

			spans.set(cell, { r0, c0, r1, c1 })
		}

		const scaleX = space.right - space.left === 0 ? 1 : box.w / (space.right - space.left)
		const scaleY = space.bottom - space.top === 0 ? 1 : box.h / (space.bottom - space.top)
		const border = (cell: PptShape, side: "lnL" | "lnR" | "lnT" | "lnB"): string => {
			const anchor = cell.childAnchor

			if (anchor === undefined) return ""

			for (const line of lines) {
				const a = line.childAnchor

				if (a === undefined) continue

				const horizontal = Math.abs(a.bottom - a.top) <= tolerance
				const vertical = Math.abs(a.right - a.left) <= tolerance
				const covers = (from: number, to: number, start: number, end: number): boolean =>
					Math.min(from, to) <= (start + end) / 2 && Math.max(from, to) >= (start + end) / 2
				const hit =
					side === "lnT" || side === "lnB"
						? horizontal &&
							Math.abs(a.top - (side === "lnT" ? anchor.top : anchor.bottom)) <= tolerance &&
							covers(a.left, a.right, anchor.left, anchor.right)
						: vertical &&
							Math.abs(a.left - (side === "lnL" ? anchor.left : anchor.right)) <= tolerance &&
							covers(a.top, a.bottom, anchor.top, anchor.bottom)

				if (hit) return this.line([line.properties, this.document.defaults], context.scheme, side)
			}

			return `<a:${side}><a:noFill/></a:${side}>`
		}
		const gridXml = Array.from(
			{ length: columns },
			(_, c) => `<a:gridCol w="${String(Math.max(0, Math.round(((xs[c + 1] ?? 0) - (xs[c] ?? 0)) * scaleX * scale)))}"/>`
		).join("")
		let rowsXml = ""

		for (let r = 0; r < rows; r++) {
			let row = ""

			for (let c = 0; c < columns; c++) {
				const cell = grid[r * columns + c]
				const span = cell === undefined ? undefined : spans.get(cell)

				if (cell === undefined || span === undefined) {
					row += "<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></a:txBody><a:tcPr/></a:tc>"
					continue
				}

				if (span.r0 !== r || span.c0 !== c) {
					row += `<a:tc${span.c0 !== c ? ' hMerge="1"' : ""}${span.r0 !== r ? ' vMerge="1"' : ""}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></a:txBody><a:tcPr/></a:tc>`
					continue
				}

				const chain: PropertyChain = [cell.properties, this.document.defaults]
				const block = cell.outlineRef !== undefined ? context.outline[cell.outlineRef] : cell.text
				const body = this.textBody(chain, context, block, undefined)
					.replace(/^<p:txBody>/u, "<a:txBody>")
					.replace(/<\/p:txBody>$/u, "</a:txBody>")
				const margins = [P.dxTextLeft, P.dxTextRight, P.dyTextTop, P.dyTextBottom].map((pid, index) => {
					const raw = value(chain, pid)

					return raw === undefined ? (index < 2 ? 91440 : 45720) : Math.max(0, i32Value(raw))
				})
				const [anchor] = ANCHORS[value(chain, P.anchorText) ?? 0] ?? ["t", false]
				const fill = this.fill(chain, context.scheme, context)

				row += `<a:tc${span.c1 - span.c0 > 1 ? ` gridSpan="${String(span.c1 - span.c0)}"` : ""}${span.r1 - span.r0 > 1 ? ` rowSpan="${String(span.r1 - span.r0)}"` : ""}>${body}<a:tcPr marL="${String(margins[0])}" marR="${String(margins[1])}" marT="${String(margins[2])}" marB="${String(margins[3])}" anchor="${anchor}">${border(cell, "lnL")}${border(cell, "lnR")}${border(cell, "lnT")}${border(cell, "lnB")}${fill}</a:tcPr></a:tc>`
			}

			rowsXml += `<a:tr h="${String(Math.max(0, Math.round(((ys[r + 1] ?? 0) - (ys[r] ?? 0)) * scaleY * scale)))}">${row}</a:tr>`
		}

		return `<p:graphicFrame><p:nvGraphicFramePr>${cNvPr}<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${String(Math.round(box.x * scale))}" y="${String(Math.round(box.y * scale))}"/><a:ext cx="${String(Math.max(0, Math.round(box.w * scale)))}" cy="${String(Math.max(0, Math.round(box.h * scale)))}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>${gridXml}</a:tblGrid>${rowsXml}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
	}

	private wordArtBody(text: string, chain: PropertyChain, context: PartContext, box: { readonly h: number } | undefined): string {
		const font = textProperty(lookup(chain, P.gtextFont))
		const color = artColorOf({ scheme: context.scheme, chain }, P.fillColor)
		const lines = text.split(/\r\n|\r|\n/u)
		const height = box === undefined ? 36 : (box.h / 8 / Math.max(1, lines.length)) * 0.8
		const size = Math.max(100, Math.min(400000, Math.round(height * 100)))
		const runs = lines
			.map(
				line =>
					`<a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="${String(size)}"><a:solidFill>${colorXml(color)}</a:solidFill>${font === undefined ? "" : `<a:latin typeface="${xmlText(font)}"/>`}</a:rPr><a:t>${xmlText(line)}</a:t></a:r></a:p>`
			)
			.join("")

		return `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>${runs}</p:txBody>`
	}

	private pictureXml(
		shape: PptShape,
		chain: PropertyChain,
		context: PartContext,
		cNvPr: string,
		ph: string,
		xfrm: string,
		part: string,
		mediaXml = ""
	): string {
		const id = context.rels.add("image", `../media/${part.slice(part.lastIndexOf("/") + 1)}`)
		const crop = (pid: number): number => Math.round((i32Value(value(chain, pid)) * 100000) / 65536)
		const l = crop(P.cropFromLeft)
		const t = crop(P.cropFromTop)
		const r = crop(P.cropFromRight)
		const b = crop(P.cropFromBottom)
		const srcRect =
			l === 0 && t === 0 && r === 0 && b === 0
				? "<a:srcRect/>"
				: `<a:srcRect l="${String(l)}" t="${String(t)}" r="${String(r)}" b="${String(b)}"/>`
		const line = flag(chain, P.lineStyleBooleans, 3) === true ? this.line(chain, context.scheme) : ""
		const gray = flag(chain, P.blipBooleans, 2) === true ? "<a:grayscl/>" : ""

		return `<p:pic><p:nvPicPr>${cNvPr}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr>${ph}${mediaXml}</p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="${id}">${gray}</a:blip>${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm}<a:prstGeom prst="${presetOf(shape.shapeType) ?? "rect"}"><a:avLst/></a:prstGeom>${line}${this.effects(chain, context.scheme)}</p:spPr></p:pic>`
	}

	background(shape: PptShape | undefined, scheme: readonly number[], context: PartContext): string {
		if (shape === undefined) return ""

		const chain: PropertyChain = [shape.properties, this.document.defaults]

		return `<p:bg><p:bgPr>${this.fill(chain, scheme, context)}<a:effectLst/></p:bgPr></p:bg>`
	}
}

function i32Value(raw: number | undefined): number {
	return raw === undefined ? 0 : raw | 0
}

// UTF-16 text of a complex property (names, WordArt text), up to its terminator.
function textProperty(property: ArtProperty | undefined): string | undefined {
	const bytes = property?.complex

	if (bytes === undefined) return undefined

	let out = ""

	for (let at = 0; at + 1 < bytes.length; at += 2) {
		const unit = u16(bytes, at)

		if (unit === 0) break

		out += String.fromCharCode(unit)
	}

	return out === "" ? undefined : out
}

// The text type a pptx shape inherits its master style from: title placeholders the title style, notes bodies the
// notes style, other placeholders the body style; plain shapes the other style.
function familyOf(placeholderType: string | undefined, kind: PartContext["kind"]): number {
	if (placeholderType === "title" || placeholderType === "ctrTitle") return TEXT_TYPE.title
	if (kind === "notes" || kind === "notesMaster") return placeholderType === "body" ? TEXT_TYPE.notes : TEXT_TYPE.other
	if (
		placeholderType === undefined ||
		placeholderType === "dt" ||
		placeholderType === "ftr" ||
		placeholderType === "sldNum" ||
		placeholderType === "hdr"
	) {
		return TEXT_TYPE.other
	}

	return TEXT_TYPE.body
}

export async function pptToPptx(source: ByteSource, options: PptOpenOptions = {}): Promise<PptConversion | Refused> {
	try {
		return await convert(source, options)
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)

		throw error
	}
}

async function convert(source: ByteSource, options: PptOpenOptions): Promise<PptConversion> {
	const file = await openPptFile(source, options)

	try {
		return await converted(file)
	} catch (error) {
		file.key?.wipe()

		throw error
	}
}

async function converted(file: PptFile): Promise<PptConversion> {
	const document = readDocument(file)
	const slides = readSlides(document)
	const pictures: (Picture | undefined)[] = []

	for (const entry of document.blips) {
		try {
			pictures.push(await describeBlip(entry, document))
		} catch (error) {
			if (!(error instanceof PresentationError)) throw error

			pictures.push(undefined)
		}
	}

	const slidePartOf = new Map<number, string>()

	document.slides.forEach((entry, index) => slidePartOf.set(entry.id, `slide${String(index + 1)}.xml`))

	const documentRecords = kids(file, persistRecord(file, file.directory.current.docPersistIdRef, RT.document))
	const converter = new Converter(document, pictures, slidePartOf, documentRecords)
	const written = new PackageWriter(converter, document, slides).write()

	converter.finishMedia()

	if (document.macros) converter.report.note("macros")

	const pptx = OpcPackage.fromParts(written)

	streamedParts.set(pptx, written)

	return {
		kind: "converted",
		pptx,
		// Read again after a Save as: an embedded object's storage found damaged as it is written is counted then.
		get losses() {
			return converter.report.losses()
		},
		slides: document.slides.length,
		encrypted: file.encrypted,
		release: () => file.key?.wipe()
	}
}

// The parts of each converted package, so Save as streams those that can be read in pieces.
const streamedParts = new WeakMap<OpcPackage, ReadonlyMap<string, Uint8Array | LinkedPart>>()

function streams(part: Uint8Array | LinkedPart): part is LinkedPart & ByteChunks {
	return !(part instanceof Uint8Array) && "chunks" in part
}

// Extensions of parts whose content is compressed already: stored as they are, not deflated again.
const STORED = new Set(["png", "jpeg", "jpg", "gif", "mp3", "mp4", "m4a", "wma", "wmv", "avi", "mov"])

// The converted package as a .pptx file (Save as): its parts read one at a time (pictures decrypted and the embedded
// objects' storages inflated as they are reached) and zipped to `sink`, [Content_Types].xml first. The same deck
// always gives the same bytes.
export async function writePptConversion(
	pptx: OpcPackage,
	sink: ByteSink,
	options: { readonly slicing?: Slicing } = {}
): Promise<WriteZipReport> {
	const names = [...pptx.entries()].map(entry => entry.name)
	const ordered = [...names.filter(name => name === "[Content_Types].xml"), ...names.filter(name => name !== "[Content_Types].xml")]

	const held = streamedParts.get(pptx)

	async function* items(): AsyncIterable<ZipPlanItem> {
		for (const name of ordered) {
			const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
			const part = held?.get(name)
			// A part that streams its pieces (an embedded object's storage) is never joined.
			const bytes = part !== undefined && streams(part) ? part : await pptx.read(name)

			yield { kind: "data", name, bytes, compress: !STORED.has(extension) }
		}
	}

	return writeZip({ items: items() }, null, sink, options.slicing === undefined ? {} : { slicing: options.slicing })
}

// --- Parts ---

interface LayoutPlan {
	readonly part: string
	readonly master: number
	readonly type: string
	readonly name: string
	// A title master's own slide (its shapes and background), or the placeholders of the slides that use it.
	readonly titleMaster: PptSlide | undefined
	readonly placeholders: Map<string, string>
}

// SlideLayoutType (§2.13.25) → ST_SlideLayoutType and a name.
const LAYOUTS: ReadonlyMap<number, readonly [string, string]> = new Map([
	[0, ["title", "Title Slide"]],
	[1, ["obj", "Title and Content"]],
	[2, ["title", "Title Slide"]],
	[7, ["titleOnly", "Title Only"]],
	[8, ["twoObj", "Two Content"]],
	[9, ["objOverTx", "Two Rows"]],
	[10, ["objAndTwoObj", "Content and Two Rows"]],
	[11, ["twoObjAndObj", "Two Rows and Content"]],
	[13, ["twoObjOverTx", "Two Columns and Row"]],
	[14, ["fourObj", "Four Content"]],
	[15, ["objOnly", "Content"]],
	[16, ["blank", "Blank"]],
	[17, ["vertTitleAndTx", "Vertical Title and Text"]],
	[18, ["vertTitleAndTxOverChart", "Vertical Title and Text Over Chart"]]
])

function defaultScheme(): number[] {
	return [0xffffff, 0x000000, 0x808080, 0x000000, 0x00cc99, 0x3333cc, 0xccccff, 0xb2b2b2]
}

class PackageWriter {
	private readonly masterIndex = new Map<PptSlide, number>()
	private readonly layouts: LayoutPlan[] = []
	private readonly layoutOf = new Map<PptSlide, LayoutPlan>()
	private readonly masterLayouts = new Map<number, LayoutPlan[]>()

	private readonly converter: Converter
	private readonly document: PptDocument
	private readonly slides: PptSlides

	constructor(converter: Converter, document: PptDocument, slides: PptSlides) {
		this.converter = converter
		this.document = document
		this.slides = slides
	}

	private mainMasterOf(slide: PptSlide): PptSlide | undefined {
		const master = this.slides.masterById.get(slide.masterIdRef)

		if (master?.kind === "titleMaster") return this.slides.masterById.get(master.masterIdRef) ?? this.slides.mainMasters[0]

		return master ?? this.slides.mainMasters[0]
	}

	private schemeOf(slide: PptSlide | undefined, depth = 0): readonly number[] {
		if (slide === undefined) return defaultScheme()
		if ((slide.flags & SLIDE_FLAGS.masterScheme) === 0 || slide.kind === "mainMaster" || slide.kind === "notesMaster") {
			if (slide.scheme !== undefined) return slide.scheme
		}

		if (depth > 4) return slide.scheme ?? defaultScheme()

		const master =
			slide.kind === "notes" ? this.slides.notesMaster : (this.slides.masterById.get(slide.masterIdRef) ?? this.mainMasterOf(slide))

		return master === undefined || master === slide ? (slide.scheme ?? defaultScheme()) : this.schemeOf(master, depth + 1)
	}

	// The style of `type` at `level` for text on `master`: the document's styles, then the master's (§2.9.35); a centred
	// or partial type over its base type.
	private styleOf(master: PptSlide | undefined, type: number, level: number): StyleLevel {
		const base = type === TEXT_TYPE.centerTitle ? TEXT_TYPE.title : type >= TEXT_TYPE.centerBody ? TEXT_TYPE.body : type
		const levelOf = (
			styles: ReadonlyMap<number, { readonly levels: readonly (StyleLevel | undefined)[] }> | undefined,
			t: number
		): StyleLevel | undefined => styles?.get(t)?.levels[level]
		const firstMaster = this.slides.mainMasters[0]
		const chain = [
			levelOf(this.document.styles, base),
			levelOf(firstMaster?.styles, base),
			levelOf(master?.styles, base),
			...(base === type
				? []
				: [levelOf(this.document.styles, type), levelOf(firstMaster?.styles, type), levelOf(master?.styles, type)])
		]

		return { pf: mergePara(...chain.map(entry => entry?.pf)), cf: mergeChar(...chain.map(entry => entry?.cf)) }
	}

	private textContext(
		master: PptSlide | undefined,
		scheme: readonly number[],
		explicitColors: boolean,
		slideNumber: number | undefined,
		hf: HeadersFooters | undefined,
		rels: Rels
	): TextEmitContext {
		const converter = this.converter

		return {
			fonts: this.document.fonts,
			scheme,
			style: (type, level) => this.styleOf(master, type, level),
			explicitColors,
			slideNumber,
			footer: hf?.footer,
			header: hf?.header,
			date: hf?.userDate,
			link: interaction => converter.link(interaction, rels, slideNumber)
		}
	}

	private context(
		kind: PartContext["kind"],
		rels: Rels,
		scheme: readonly number[],
		master: PptSlide | undefined,
		explicitColors: boolean,
		slideNumber: number | undefined,
		outline: readonly TextBlock[],
		hf: HeadersFooters | undefined
	): PartContext {
		const masterShapes = new Map<number, PptShape>()
		const placeholderRulers = new Map<number, Ruler>()
		const visit = (shapes: readonly PptShape[]): void => {
			for (const shape of shapes) {
				masterShapes.set(shape.spid, shape)

				if (shape.text?.ruler !== undefined && !placeholderRulers.has(shape.text.type))
					placeholderRulers.set(shape.text.type, shape.text.ruler)

				if (shape.children !== undefined) visit(shape.children)
			}
		}

		if (master !== undefined) visit(master.drawing.shapes)

		return {
			rels,
			scheme,
			kind,
			slideNumber,
			outline,
			masterShapes,
			text: this.textContext(master, scheme, explicitColors, slideNumber, hf, rels),
			placeholderRulers,
			ids: new Set([1])
		}
	}

	private plan(): void {
		const mains = this.slides.mainMasters

		mains.forEach((master, index) => {
			this.masterIndex.set(master, index)
			this.masterLayouts.set(index, [])
		})

		const add = (plan: LayoutPlan): LayoutPlan => {
			this.layouts.push(plan)
			this.masterLayouts.get(plan.master)?.push(plan)

			return plan
		}

		for (const titleMaster of this.slides.titleMasters) {
			const main = this.mainMasterOf(titleMaster)
			const index = main === undefined ? 0 : (this.masterIndex.get(main) ?? 0)
			const plan = add({
				part: `slideLayout${String(this.layouts.length + 1)}.xml`,
				master: index,
				type: "title",
				name: titleMaster.name ?? "Title Slide",
				titleMaster,
				placeholders: new Map()
			})

			this.layoutOf.set(titleMaster, plan)
		}

		const byKey = new Map<string, LayoutPlan>()

		for (const slide of this.slides.slides) {
			const master = this.slides.masterById.get(slide.masterIdRef)

			if (master?.kind === "titleMaster") {
				const plan = this.layoutOf.get(master)

				if (plan !== undefined) {
					this.layoutOf.set(slide, plan)
					continue
				}
			}

			const main = this.mainMasterOf(slide)
			const index = main === undefined ? 0 : (this.masterIndex.get(main) ?? 0)
			const [type, name] = LAYOUTS.get(slide.layout) ?? ["obj", "Title and Content"]
			const key = `${String(index)}:${String(slide.layout)}`
			let plan = byKey.get(key)

			if (plan === undefined) {
				plan = add({
					part: `slideLayout${String(this.layouts.length + 1)}.xml`,
					master: index,
					type,
					name,
					titleMaster: undefined,
					placeholders: new Map()
				})
				byKey.set(key, plan)
			}

			for (const shape of slide.drawing.shapes) {
				const ph = shape.placeholder === undefined ? undefined : PLACEHOLDERS.get(shape.placeholder.type)

				if (ph === undefined || shape.placeholder === undefined) continue

				const idx =
					ph[0] === "title" || ph[0] === "ctrTitle" || shape.placeholder.position < 0
						? ""
						: ` idx="${String(shape.placeholder.position)}"`
				const key = `${ph[0]}${idx}`

				if (!plan.placeholders.has(key))
					plan.placeholders.set(key, `<p:ph type="${ph[0]}"${ph[1] === undefined ? "" : ` orient="${ph[1]}"`}${idx}/>`)
			}

			this.layoutOf.set(slide, plan)
		}

		// Every master has a layout (§19.3.1.42 sldLayoutIdLst).
		this.masterLayouts.forEach((list, index) => {
			if (list.length === 0)
				add({
					part: `slideLayout${String(this.layouts.length + 1)}.xml`,
					master: index,
					type: "obj",
					name: "Title and Content",
					titleMaster: undefined,
					placeholders: new Map()
				})
		})
	}

	write(): Map<string, Uint8Array | LinkedPart> {
		const converter = this.converter
		const document = this.document

		if (this.slides.mainMasters.length === 0) throw new PresentationError("malformed", "The presentation has no main master")

		this.plan()

		const presentationRels = new Rels()
		const masterIds: string[] = []

		this.slides.mainMasters.forEach((master, index) => {
			const part = `slideMaster${String(index + 1)}.xml`

			this.writeMaster(master, index, part)
			masterIds.push(
				`<p:sldMasterId id="${String(2147483648 + index * 1000)}" r:id="${presentationRels.add("slideMaster", `slideMasters/${part}`)}"/>`
			)
		})

		let notesMasterXml = ""

		if (this.slides.notesMaster !== undefined || this.slides.notes.size > 0) {
			this.writeNotesMaster(this.slides.notesMaster)
			notesMasterXml = `<p:notesMasterIdLst><p:notesMasterId r:id="${presentationRels.add("notesMaster", "notesMasters/notesMaster1.xml")}"/></p:notesMasterIdLst>`
		}

		let handoutXml = ""

		if (this.slides.handoutMaster !== undefined) {
			this.writeHandoutMaster(this.slides.handoutMaster)
			handoutXml = `<p:handoutMasterIdLst><p:handoutMasterId r:id="${presentationRels.add("handoutMaster", "handoutMasters/handoutMaster1.xml")}"/></p:handoutMasterIdLst>`
		}

		const slideIds: string[] = []
		const usedIds = new Set<number>()

		this.slides.slides.forEach((slide, index) => {
			const entry = document.slides[index]
			let id = entry !== undefined && entry.id >= 256 && entry.id <= 2147483647 ? entry.id : 256 + index

			while (usedIds.has(id)) id++

			usedIds.add(id)
			this.writeSlide(slide, index, entry?.texts ?? [])
			slideIds.push(`<p:sldId id="${String(id)}" r:id="${presentationRels.add("slide", `slides/slide${String(index + 1)}.xml`)}"/>`)
		})

		presentationRels.add("theme", "theme/theme1.xml")
		presentationRels.add("presProps", "presProps.xml")

		if (converter.authors.size > 0) {
			presentationRels.add("commentAuthors", "commentAuthors.xml")
			converter.add("ppt/commentAuthors.xml", `${DECLARATION}${converter.authors.xml()}`, CT.commentAuthors)
		}

		const shows = document.namedShows
			.map(
				(show, index) =>
					`<p:custShow name="${xmlText(show.name)}" id="${String(index)}"><p:sldLst>${show.slideIds
						.map(id => {
							const part = converter.slidePartOf.get(id)

							return part === undefined ? "" : `<p:sld r:id="${presentationRels.add("slide", `slides/${part}`)}"/>`
						})
						.join("")}</p:sldLst></p:custShow>`
			)
			.join("")

		const size = `<p:sldSz cx="${String(clampSize(emu(document.slideSize.x)))}" cy="${String(clampSize(emu(document.slideSize.y)))}"/>`
		const notesSize = `<p:notesSz cx="${String(clampSize(emu(document.notesSize.x || 4320)))}" cy="${String(clampSize(emu(document.notesSize.y || 5760)))}"/>`
		const firstMaster = this.slides.mainMasters[0]
		const defaultContext = this.textContext(firstMaster, this.schemeOf(firstMaster), true, undefined, undefined, presentationRels)
		const defaultTextStyle = `<p:defaultTextStyle>${listStyleXml(TEXT_TYPE.other, defaultContext)}</p:defaultTextStyle>`
		const firstSlide = document.firstSlideNumber > 1 ? ` firstSlideNum="${String(document.firstSlideNumber)}"` : ""

		converter.add(
			"ppt/presentation.xml",
			`${DECLARATION}<p:presentation ${ROOT_NS}${firstSlide} saveSubsetFonts="1"><p:sldMasterIdLst>${masterIds.join("")}</p:sldMasterIdLst>${notesMasterXml}${handoutXml}<p:sldIdLst>${slideIds.join("")}</p:sldIdLst>${size}${notesSize}${shows === "" ? "" : `<p:custShowLst>${shows}</p:custShowLst>`}${defaultTextStyle}</p:presentation>`,
			CT.presentation
		)
		converter.addRels("ppt/presentation.xml", presentationRels)
		converter.add("ppt/presProps.xml", `${DECLARATION}<p:presentationPr ${ROOT_NS}/>`, CT.presProps)

		converter.sounds.finish(converter.parts, converter.defaults)
		converter.ole.finish(converter.parts, converter.defaults)

		const packageRels = new Rels()

		packageRels.add("officeDocument", "ppt/presentation.xml")
		converter.parts.set("_rels/.rels", encodeUtf8(packageRels.xml()))

		const contentTypes = `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[
			...converter.defaults
		]
			.map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`)
			.join(
				""
			)}${[...converter.overrides].map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join("")}</Types>`

		converter.parts.set("[Content_Types].xml", encodeUtf8(contentTypes))

		return converter.parts
	}

	private shapesXml(shapes: readonly PptShape[], context: PartContext): string {
		return shapes.map(shape => this.converter.shapeXml(shape, context, false)).join("")
	}

	private spTree(content: string): string {
		return `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${content}</p:spTree>`
	}

	private writeTheme(master: PptSlide, index: number): void {
		const scheme = master.scheme ?? defaultScheme()
		const title = this.styleOf(master, TEXT_TYPE.title, 0).cf.font
		const body = this.styleOf(master, TEXT_TYPE.body, 0).cf.font
		const font = (ref: number | undefined): string => xmlText(ref === undefined ? "Arial" : (this.document.fonts[ref]?.name ?? "Arial"))
		const color = (name: string, rgb: number | undefined): string => `<a:${name}><a:srgbClr val="${hex(rgb ?? 0)}"/></a:${name}>`
		const fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
		const lines = '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'

		this.converter.add(
			`ppt/theme/theme${String(index + 1)}.xml`,
			`${DECLARATION}<a:theme xmlns:a="${NS_A}" name="${xmlText(master.name ?? `Master ${String(index + 1)}`)}"><a:themeElements><a:clrScheme name="Scheme ${String(index + 1)}">${color("dk1", scheme[1])}${color("lt1", scheme[0])}${color("dk2", scheme[2])}${color("lt2", scheme[3])}${color("accent1", scheme[4])}${color("accent2", scheme[5])}${color("accent3", scheme[6])}${color("accent4", scheme[7])}${color("accent5", scheme[4])}${color("accent6", scheme[5])}${color("hlink", scheme[6])}${color("folHlink", scheme[7])}</a:clrScheme><a:fontScheme name="Fonts ${String(index + 1)}"><a:majorFont><a:latin typeface="${font(title)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${font(body)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Format ${String(index + 1)}"><a:fillStyleLst>${fills}${fills}${fills}</a:fillStyleLst><a:lnStyleLst>${lines}${lines}${lines}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fills}${fills}${fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`,
			CT.theme
		)
	}

	private writeMaster(master: PptSlide, index: number, part: string): void {
		const converter = this.converter
		const rels = new Rels()
		const scheme = this.schemeOf(master)
		const outline = this.document.masters.find(entry => entry.persistId === master.persistId)?.texts ?? []
		const context = this.context("master", rels, scheme, master, false, undefined, outline, this.document.slideHF)

		this.writeTheme(master, index)

		if ([...master.styles.values()].some(style => style.damaged === true)) converter.report.note("damagedContent")

		const layouts = (this.masterLayouts.get(index) ?? []).map(plan => {
			this.writeLayout(plan, master)

			return `<p:sldLayoutId id="${String(2147483649 + index * 1000 + this.layouts.indexOf(plan))}" r:id="${rels.add("slideLayout", `../slideLayouts/${plan.part}`)}"/>`
		})

		rels.add("theme", `../theme/theme${String(index + 1)}.xml`)

		const shapes = this.shapesXml(master.drawing.shapes, context)
		const background =
			converter.background(master.drawing.background, scheme, context) ||
			`<p:bg><p:bgPr><a:solidFill>${colorXml(scheme[0] ?? 0xffffff)}</a:solidFill><a:effectLst/></p:bgPr></p:bg>`
		const textContext = this.textContext(master, scheme, true, undefined, undefined, rels)
		const txStyles = `<p:txStyles><p:titleStyle>${listStyleXml(TEXT_TYPE.title, textContext)}</p:titleStyle><p:bodyStyle>${listStyleXml(TEXT_TYPE.body, textContext)}</p:bodyStyle><p:otherStyle>${listStyleXml(TEXT_TYPE.other, textContext)}</p:otherStyle></p:txStyles>`

		converter.add(
			`ppt/slideMasters/${part}`,
			`${DECLARATION}<p:sldMaster ${ROOT_NS}><p:cSld${master.name === undefined ? "" : ` name="${xmlText(master.name)}"`}>${background}${this.spTree(shapes)}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${layouts.join("")}</p:sldLayoutIdLst>${txStyles}</p:sldMaster>`,
			CT.master
		)
		converter.addRels(`ppt/slideMasters/${part}`, rels)
	}

	private writeLayout(plan: LayoutPlan, master: PptSlide): void {
		const converter = this.converter
		const rels = new Rels()
		let content = ""
		let background = ""
		let showMaster = ""

		rels.add("slideMaster", `../slideMasters/slideMaster${String(plan.master + 1)}.xml`)

		if (plan.titleMaster !== undefined) {
			const title = plan.titleMaster
			const scheme = this.schemeOf(title)
			const outline = this.document.masters.find(entry => entry.persistId === title.persistId)?.texts ?? []
			const context = this.context("layout", rels, scheme, master, false, undefined, outline, this.document.slideHF)

			content = this.shapesXml(title.drawing.shapes, context)

			if ((title.flags & SLIDE_FLAGS.masterBackground) === 0)
				background = converter.background(title.drawing.background, scheme, context)
			if ((title.flags & SLIDE_FLAGS.masterObjects) === 0) showMaster = ' showMasterSp="0"'
		} else {
			let id = 2

			for (const ph of plan.placeholders.values()) {
				content += `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="Placeholder ${String(id - 1)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/></p:sp>`
				id++
			}
		}

		converter.add(
			`ppt/slideLayouts/${plan.part}`,
			`${DECLARATION}<p:sldLayout ${ROOT_NS} type="${plan.type}" preserve="1"${showMaster}><p:cSld name="${xmlText(plan.name)}">${background}${this.spTree(content)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
			CT.layout
		)
		converter.addRels(`ppt/slideLayouts/${plan.part}`, rels)
	}

	// The master's (or title master's) date, footer and slide-number placeholders a slide shows, as its own.
	private footers(slide: PptSlide, master: PptSlide | undefined, hf: HeadersFooters | undefined): PptShape[] {
		if (hf === undefined || master === undefined) return []

		const owner = this.slides.masterById.get(slide.masterIdRef)

		if (owner?.kind === "titleMaster" && this.document.omitTitlePlaceholders) return []

		const source = owner?.kind === "titleMaster" ? owner : master
		const wanted = new Set<number>()

		// §2.4.15.2: fHasDate 0x1, fHasSlideNumber 0x8, fHasFooter 0x20.
		if ((hf.flags & 0x1) !== 0) wanted.add(7)
		if ((hf.flags & 0x8) !== 0) wanted.add(8)
		if ((hf.flags & 0x20) !== 0) wanted.add(9)

		const present = new Set(slide.drawing.shapes.map(shape => shape.placeholder?.type))

		return source.drawing.shapes.filter(
			shape => shape.placeholder !== undefined && wanted.has(shape.placeholder.type) && !present.has(shape.placeholder.type)
		)
	}

	private writeSlide(slide: PptSlide, index: number, outline: readonly TextBlock[]): void {
		const converter = this.converter
		const rels = new Rels()
		const plan = this.layoutOf.get(slide)
		const number = index + 1
		const master = this.mainMasterOf(slide)
		const owner = this.slides.masterById.get(slide.masterIdRef) ?? master
		const scheme = this.schemeOf(slide)
		const masterScheme = this.schemeOf(owner)
		const ownScheme = scheme.some((rgb, at) => rgb !== masterScheme[at])
		const hf = slide.headersFooters ?? this.document.slideHF
		const context = this.context(
			"slide",
			rels,
			scheme,
			master,
			ownScheme,
			number + Math.max(0, this.document.firstSlideNumber - 1),
			outline,
			hf
		)

		if (plan !== undefined) rels.add("slideLayout", `../slideLayouts/${plan.part}`)

		if (
			ownScheme &&
			(slide.flags & SLIDE_FLAGS.masterObjects) !== 0 &&
			(owner?.drawing.shapes.some(shape => shape.placeholder === undefined) ?? false)
		) {
			converter.report.note("slideColorScheme", number)
		}

		const footers = this.footers(slide, master, hf)
		const footerContext =
			owner === undefined
				? context
				: { ...context, outline: this.document.masters.find(entry => entry.persistId === owner.persistId)?.texts ?? [] }
		const shapes =
			this.shapesXml(slide.drawing.shapes, context) + footers.map(shape => converter.shapeXml(shape, footerContext, false)).join("")
		let background = ""

		if ((slide.flags & SLIDE_FLAGS.masterBackground) === 0) background = converter.background(slide.drawing.background, scheme, context)
		else if (ownScheme) background = converter.background(owner?.drawing.background ?? master?.drawing.background, scheme, context)

		const hidden = slide.show?.hidden === true ? ' show="0"' : ""
		const showMaster = (slide.flags & SLIDE_FLAGS.masterObjects) === 0 ? ' showMasterSp="0"' : ""

		const sound = (soundIdRef: number): { readonly rId: string; readonly name: string } | undefined =>
			converter.sounds.sound(soundIdRef, (type, target) => rels.add(type, target))
		const transition = slide.show === undefined ? undefined : transitionXml(slide.show, sound)

		if (transition?.unsupported === true) converter.report.note("transition", number)

		const [builds, animShapes] = this.animated(slide, outline, owner)
		const tag = this.pp10(slide.record, number)
		const timing = timingOf(tag, builds, {
			data: this.document.file.stream,
			shapes: animShapes,
			counter: this.document.file.counter,
			sound,
			embeddedSound: container => {
				const held = converter.sounds.embeddedSoundPart(container)

				return held === undefined
					? undefined
					: { rId: rels.add("audio", `../media/${held.part.slice(held.part.lastIndexOf("/") + 1)}`), name: held.name }
			},
			scheme,
			budgets: this.document.file.deckBudgets.timing
		})

		if (timing.lost) converter.report.note("animation", number)

		converter.add(
			`ppt/slides/slide${String(number)}.xml`,
			`${DECLARATION}<p:sld ${ROOT_NS}${showMaster}${hidden}><p:cSld${slide.name === undefined ? "" : ` name="${xmlText(slide.name)}"`}>${background}${this.spTree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transition?.xml ?? ""}${timing.xml}</p:sld>`,
			CT.slide
		)

		const comments = tag === undefined ? [] : this.comments(tag, number)

		if (comments.length > 0) {
			const part = `ppt/comments/comment${String(number)}.xml`

			rels.add("comments", `../comments/comment${String(number)}.xml`)
			converter.add(part, `${DECLARATION}${commentsXml(comments, converter.authors)}`, CT.comments)
		}

		const notes = slide.notesIdRef === 0 ? undefined : this.slides.notes.get(slide.notesIdRef)

		if (notes !== undefined) {
			rels.add("notesSlide", `../notesSlides/notesSlide${String(number)}.xml`)
			this.writeNotes(notes, number)
		}

		converter.addRels(`ppt/slides/slide${String(number)}.xml`, rels)
	}

	// The records of a slide's "___PPT10" tag; a damaged tag loses the slide's timing and comments, never the deck.
	private pp10(slide: PptRecordRef, number: number): readonly PptRecordRef[] | undefined {
		try {
			return pp10Records(this.document.file.stream, slide, this.document.file.counter)
		} catch (error) {
			if (!(error instanceof PresentationError) || error.reason !== "malformed") throw error

			this.converter.report.note("animation", number)
			this.converter.report.note("comment", number)

			return undefined
		}
	}

	private comments(tag: readonly PptRecordRef[], number: number): readonly PptComment[] {
		try {
			return slideComments(this.document.file.stream, tag, this.document.file.counter)
		} catch (error) {
			if (!(error instanceof PresentationError) || error.reason !== "malformed") throw error

			this.converter.report.note("comment", number)

			return []
		}
	}

	// The slide's shapes as its timing addresses them (by spid, with their paragraphs) and their Office 97 builds. A
	// placeholder without a build of its own plays its master placeholder's (§2.8.1 on a master shape; PowerPoint and
	// LibreOffice 7.5 play it on each slide that shows the placeholder).
	private animated(
		slide: PptSlide,
		outline: readonly TextBlock[],
		master: PptSlide | undefined
	): [readonly PptLegacyBuild[], ReadonlyMap<number, PptAnimShape>] {
		const builds: PptLegacyBuild[] = []
		const shapes = new Map<number, PptAnimShape>()
		const inherited = new Map<string, { readonly start: number; readonly end: number }>()

		for (const shape of master?.drawing.shapes ?? []) {
			const family = buildFamily(shape)

			if (family !== undefined && shape.animation !== undefined && !inherited.has(family)) inherited.set(family, shape.animation)
		}

		const visit = (list: readonly PptShape[], top: boolean): void => {
			for (const shape of list) {
				const block = shape.outlineRef !== undefined ? outline[shape.outlineRef] : shape.text

				if (!shapes.has(shape.spid)) shapes.set(shape.spid, { paragraphs: paragraphSpans(block) })

				// A build plays on a shape of the slide; one inside a group plays with its group (§2.8.1 is per shape on
				// the slide, and PowerPoint animates a group whole).
				if (top) {
					const family = buildFamily(shape)
					const master = shape.animation === undefined && family !== undefined ? inherited.get(family) : undefined

					if (shape.animation !== undefined)
						builds.push({ spid: shape.spid, start: shape.animation.start, end: shape.animation.end })
					else if (master !== undefined) builds.push({ spid: shape.spid, start: master.start, end: master.end, inherited: true })
				}

				if (shape.children !== undefined) visit(shape.children, false)
			}
		}

		visit(slide.drawing.shapes, true)

		return [builds, shapes]
	}

	private writeNotesMaster(notesMaster: PptSlide | undefined): void {
		const converter = this.converter
		const rels = new Rels()
		const scheme = this.schemeOf(notesMaster)
		const master = this.slides.mainMasters[0]
		const context = this.context("notesMaster", rels, scheme, master, false, undefined, [], this.document.notesHF)

		rels.add("theme", "../theme/theme1.xml")

		const shapes = notesMaster === undefined ? "" : this.shapesXml(notesMaster.drawing.shapes, context)
		const background =
			(notesMaster === undefined ? "" : converter.background(notesMaster.drawing.background, scheme, context)) ||
			`<p:bg><p:bgPr><a:solidFill>${colorXml(scheme[0] ?? 0xffffff)}</a:solidFill><a:effectLst/></p:bgPr></p:bg>`
		const textContext = this.textContext(master, scheme, true, undefined, undefined, rels)

		converter.add(
			"ppt/notesMasters/notesMaster1.xml",
			`${DECLARATION}<p:notesMaster ${ROOT_NS}><p:cSld>${background}${this.spTree(shapes)}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle>${listStyleXml(TEXT_TYPE.notes, textContext)}</p:notesStyle></p:notesMaster>`,
			CT.notesMaster
		)
		converter.addRels("ppt/notesMasters/notesMaster1.xml", rels)
	}

	// §2.5.8 HandoutContainer: its drawing and scheme, as p:handoutMaster.
	private writeHandoutMaster(handout: PptSlide): void {
		const converter = this.converter
		const rels = new Rels()
		const scheme = handout.scheme ?? this.schemeOf(this.slides.mainMasters[0])
		const context = this.context("notesMaster", rels, scheme, this.slides.mainMasters[0], false, undefined, [], this.document.notesHF)

		rels.add("theme", "../theme/theme1.xml")

		const shapes = this.shapesXml(handout.drawing.shapes, context)
		const background =
			converter.background(handout.drawing.background, scheme, context) ||
			`<p:bg><p:bgPr><a:solidFill>${colorXml(scheme[0] ?? 0xffffff)}</a:solidFill><a:effectLst/></p:bgPr></p:bg>`

		converter.add(
			"ppt/handoutMasters/handoutMaster1.xml",
			`${DECLARATION}<p:handoutMaster ${ROOT_NS}><p:cSld>${background}${this.spTree(shapes)}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:handoutMaster>`,
			CT.handoutMaster
		)
		converter.addRels("ppt/handoutMasters/handoutMaster1.xml", rels)
	}

	private writeNotes(notes: PptSlide, number: number): void {
		const converter = this.converter
		const rels = new Rels()
		const scheme = this.schemeOf(notes)
		const master = this.slides.mainMasters[0]
		// The notes list's text bodies (OutlineTextRefAtom), after the notes' persist atom as after a slide's.
		const outline = this.document.notes.find(entry => entry.persistId === notes.persistId)?.texts ?? []
		const context = this.context("notes", rels, scheme, master, false, number, outline, notes.headersFooters ?? this.document.notesHF)

		rels.add("notesMaster", "../notesMasters/notesMaster1.xml")
		rels.add("slide", `../slides/slide${String(number)}.xml`)

		const shapes = this.shapesXml(notes.drawing.shapes, context)

		converter.add(
			`ppt/notesSlides/notesSlide${String(number)}.xml`,
			`${DECLARATION}<p:notes ${ROOT_NS}><p:cSld>${this.spTree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`,
			CT.notes
		)
		converter.addRels(`ppt/notesSlides/notesSlide${String(number)}.xml`, rels)
	}
}

// The master placeholder a slide placeholder takes its build from: titles from the master's title, bodies, subtitles and
// objects from its body (§2.13.21: a slide placeholder's master counterpart).
function buildFamily(shape: PptShape): string | undefined {
	const type = shape.placeholder === undefined ? undefined : PLACEHOLDERS.get(shape.placeholder.type)?.[0]

	if (type === "title" || type === "ctrTitle") return "title"
	if (type === "body" || type === "subTitle" || type === "obj") return "body"

	return undefined
}

// EMU per unit of a group's own coordinate space: as on the slide, unless that space is so large its coordinates
// would leave ST_Coordinate's 32-bit range; then the largest scale that keeps them in it (the group's transform maps
// the space onto its extent either way).
function childScale(group: PptShape): number {
	let largest = 0
	const note = (rect: Rect | undefined): void => {
		if (rect === undefined) return

		largest = Math.max(largest, Math.abs(rect.left), Math.abs(rect.top), Math.abs(rect.right), Math.abs(rect.bottom))
		largest = Math.max(largest, Math.abs(rect.right - rect.left), Math.abs(rect.bottom - rect.top))
	}

	note(group.groupRect)

	for (const member of group.children ?? []) note(member.childAnchor)

	return largest * EMU_PER_MASTER <= INT32_MAX ? EMU_PER_MASTER : INT32_MAX / Math.max(1, largest) / 2
}

const INT32_MAX = 2147483647

function clampSize(value: number): number {
	return Math.max(914400, Math.min(51206400, value))
}
