import { readProperties, records as artRecords, type ArtProperty, type ArtRecord } from "../doc/toDocx/officeArt"
import { tooDeep, tooLarge } from "../presentation/refusal"
import type { PptFile } from "./document"
import { i16, i32, RT, u16, u32, type PptRecord } from "./records"
import {
	interactionOf,
	pp9Records,
	readStyleTextProp9,
	readTextBlocks,
	RT_STYLE_TEXT_PROP9,
	type Interaction,
	type ParaProps,
	type TextBlock
} from "./text"

// The OfficeArt drawing of a slide ([MS-PPT] §2.5.13 DrawingContainer → [MS-ODRAW] §2.2.13 OfficeArtDgContainer) as a
// tree of shapes, read with the Word reader's OfficeArt record and property parsing (core/doc/toDocx/officeArt.ts):
// per shape its FSP, properties, anchors (the PowerPoint client anchor §2.7.1, or a child anchor in a group), its
// group rectangle, and the PowerPoint client data (§2.7.3: placeholder, interactions, external object) and text box
// (§2.9.76 OfficeArtClientTextbox: inline text or an OutlineTextRefAtom into the slide list's text).

const RT_SPGR_CONTAINER = 0xf003
const RT_SP_CONTAINER = 0xf004
const RT_FSPGR = 0xf009
const RT_FSP = 0xf00a
const RT_OPT = 0xf00b
const RT_CLIENT_TEXTBOX = 0xf00d
const RT_CHILD_ANCHOR = 0xf00f
const RT_CLIENT_ANCHOR = 0xf010
const RT_CLIENT_DATA = 0xf011
const RT_SECONDARY_OPT = 0xf121
const RT_TERTIARY_OPT = 0xf122

export interface Rect {
	readonly left: number
	readonly top: number
	readonly right: number
	readonly bottom: number
}

export interface Placeholder {
	readonly position: number
	readonly type: number
	readonly size: number
}

export interface PptShape {
	readonly spid: number
	// MSOSPT (MS-ODRAW §2.4.24), the FSP's recInstance.
	readonly shapeType: number
	// FSP flags (§2.2.40): fGroup 0x1, fChild 0x2, fPatriarch 0x4, fDeleted 0x8, fOleShape 0x10, fHaveMaster 0x20,
	// fFlipH 0x40, fFlipV 0x80, fConnector 0x100, fHaveAnchor 0x200, fBackground 0x400, fHaveSpt 0x800.
	readonly flags: number
	readonly properties: ReadonlyMap<number, ArtProperty>
	// Master units, slide space (top-level shapes).
	readonly anchor?: Rect
	// The parent group's coordinate space (children).
	readonly childAnchor?: Rect
	// A group: its child coordinate space (FSPGR) and children (back to front).
	readonly groupRect?: Rect
	readonly children?: readonly PptShape[]
	readonly placeholder?: Placeholder
	readonly click?: Interaction
	readonly hover?: Interaction
	readonly exObjRef?: number
	// An Office 97 build on the shape: its §2.8.1 AnimationInfoContainer's data range.
	readonly animation?: { readonly start: number; readonly end: number }
	// Inline text (ClientTextbox), or the index of the slide list's text body (OutlineTextRefAtom).
	readonly text?: TextBlock
	readonly outlineRef?: number
	// The paragraph extensions of its text (StyleTextProp9Atom in the ClientData's "___PPT9" tag).
	readonly ext9?: readonly ParaProps[]
}

export interface Drawing {
	// Top-level shapes, back to front (the patriarch's own SpContainer left out).
	readonly shapes: readonly PptShape[]
	readonly background: PptShape | undefined
}

export const MAX_GROUP_DEPTH = 128

function rect(data: Uint8Array, record: ArtRecord): Rect | undefined {
	const size = record.end - record.start

	// §2.7.2: a SmallRectStruct (top, left, right, bottom as 16-bit) or a RectStruct (32-bit).
	if (size === 8) {
		return {
			top: i16(data, record.start),
			left: i16(data, record.start + 2),
			right: i16(data, record.start + 4),
			bottom: i16(data, record.start + 6)
		}
	}

	if (size >= 16) {
		return {
			top: i32(data, record.start),
			left: i32(data, record.start + 4),
			right: i32(data, record.start + 8),
			bottom: i32(data, record.start + 12)
		}
	}

	return undefined
}

// MS-ODRAW §2.2.39/§2.2.38: left, top, right, bottom (32-bit).
function ltrb(data: Uint8Array, record: ArtRecord): Rect | undefined {
	if (record.end - record.start < 16) return undefined

	return {
		left: i32(data, record.start),
		top: i32(data, record.start + 4),
		right: i32(data, record.start + 8),
		bottom: i32(data, record.start + 12)
	}
}

function asPpt(record: ArtRecord): PptRecord {
	return record
}

class ShapeReader {
	private readonly data: Uint8Array
	private readonly file: PptFile
	// Shapes of the drawing read so far, against the shapes-per-slide budget (§1.12).
	private shapes = 0

	constructor(file: PptFile) {
		this.file = file
		this.data = file.stream
	}

	private records(start: number, end: number): ArtRecord[] {
		const out = artRecords(this.data, start, end)

		this.file.counter.add(out.length)

		return out
	}

	// §2.7.3 OfficeArtClientData.
	private clientData(
		record: ArtRecord,
		into: {
			placeholder?: Placeholder
			click?: Interaction
			hover?: Interaction
			exObjRef?: number
			animation?: { start: number; end: number }
			ext9?: readonly ParaProps[]
		}
	): void {
		const children = this.records(record.start, record.end)
		const ext9 = pp9Records(this.data, children, kid => this.records(kid.start, kid.end)).find(
			child => child.type === RT_STYLE_TEXT_PROP9
		)

		if (ext9 !== undefined) into.ext9 = readStyleTextProp9(this.data, asPpt(ext9))

		for (const child of children) {
			if (child.type === RT.placeholderAtom && child.end - child.start >= 8) {
				const position = i32(this.data, child.start)

				if (position !== -1 || (this.data[child.start + 4] ?? 0) !== 0) {
					into.placeholder = { position, type: this.data[child.start + 4] ?? 0, size: this.data[child.start + 5] ?? 0 }
				}
			} else if (child.type === RT.interactiveInfo) {
				const interaction = interactionOf(this.data, asPpt(child), kid => this.records(kid.start, kid.end))

				// §2.7.3: recInstance 0 a mouse click, 1 a mouse over.
				if (interaction !== undefined) {
					if (child.instance === 1) into.hover = interaction
					else into.click = interaction
				}
			} else if (child.type === RT.externalObjectRefAtom && child.end - child.start >= 4) {
				into.exObjRef = u32(this.data, child.start)
			} else if (child.type === RT.animationInfo) {
				into.animation = { start: child.start, end: child.end }
			}
		}
	}

	shape(container: ArtRecord): PptShape | undefined {
		const properties = new Map<number, ArtProperty>()
		let spid: number | undefined
		let shapeType = 0
		let flags = 0
		let anchor: Rect | undefined
		let childAnchor: Rect | undefined
		let groupRect: Rect | undefined
		let text: TextBlock | undefined
		let outlineRef: number | undefined
		const client: {
			placeholder?: Placeholder
			click?: Interaction
			hover?: Interaction
			exObjRef?: number
			animation?: { start: number; end: number }
			ext9?: readonly ParaProps[]
		} = {}
		let propertyBytes = 0

		for (const record of this.records(container.start, container.end)) {
			switch (record.type) {
				case RT_FSP:
					if (record.end - record.start >= 8) {
						spid = u32(this.data, record.start)
						flags = u32(this.data, record.start + 4)
						shapeType = record.instance
					}

					break
				case RT_FSPGR:
					groupRect = ltrb(this.data, record)
					break
				case RT_OPT:
				case RT_SECONDARY_OPT:
				case RT_TERTIARY_OPT:
					propertyBytes += record.end - record.start

					if (propertyBytes > this.file.budgets.shapePropertyBytes)
						tooLarge("OfficeArt property bytes per shape", this.file.budgets.shapePropertyBytes)

					readProperties(this.data, record, properties)
					break
				case RT_CLIENT_ANCHOR:
					anchor = rect(this.data, record)
					break
				case RT_CHILD_ANCHOR:
					childAnchor = ltrb(this.data, record)
					break
				case RT_CLIENT_DATA:
					this.clientData(record, client)
					break
				case RT_CLIENT_TEXTBOX: {
					const inner = this.records(record.start, record.end)
					const ref = inner.find(child => child.type === RT.outlineTextRefAtom && child.end - child.start >= 4)

					if (ref !== undefined) outlineRef = i32(this.data, ref.start)
					else
						text = readTextBlocks(
							this.data,
							inner,
							this.file.budgets,
							kid => this.records(kid.start, kid.end),
							this.file.deckBudgets.runsPerBody
						)[0]

					break
				}
				default:
					break
			}
		}

		if (spid === undefined) return undefined

		if (++this.shapes > this.file.deckBudgets.shapesPerSlide) tooLarge("shapes per slide", this.file.deckBudgets.shapesPerSlide)

		return {
			spid,
			shapeType,
			flags,
			properties,
			...(anchor === undefined ? {} : { anchor }),
			...(childAnchor === undefined ? {} : { childAnchor }),
			...(groupRect === undefined ? {} : { groupRect }),
			...(client.placeholder === undefined ? {} : { placeholder: client.placeholder }),
			...(client.click === undefined ? {} : { click: client.click }),
			...(client.hover === undefined ? {} : { hover: client.hover }),
			...(client.exObjRef === undefined ? {} : { exObjRef: client.exObjRef }),
			...(client.animation === undefined ? {} : { animation: client.animation }),
			...(text === undefined ? {} : { text }),
			...(outlineRef === undefined ? {} : { outlineRef }),
			...(client.ext9 === undefined || client.ext9.length === 0 ? {} : { ext9: client.ext9 })
		}
	}

	// MS-ODRAW §2.2.16 OfficeArtSpgrContainer: its first SpContainer is the group itself, then the members.
	group(container: ArtRecord, depth: number): PptShape | undefined {
		if (depth > MAX_GROUP_DEPTH) tooDeep("OfficeArt group nesting", MAX_GROUP_DEPTH)

		let self: PptShape | undefined
		const children: PptShape[] = []

		for (const record of this.records(container.start, container.end)) {
			let shape: PptShape | undefined

			if (record.type === RT_SP_CONTAINER) shape = this.shape(record)
			else if (record.type === RT_SPGR_CONTAINER) shape = this.group(record, depth + 1)

			if (shape === undefined) continue

			if (self === undefined && record.type === RT_SP_CONTAINER) self = shape
			else if ((shape.flags & 0x8) === 0) children.push(shape)
		}

		return self === undefined ? undefined : { ...self, children }
	}
}

// The shapes of a DrawingContainer (§2.5.13): the patriarch group's members and the background shape.
export function readDrawing(file: PptFile, drawing: PptRecord | undefined): Drawing {
	if (drawing === undefined) return { shapes: [], background: undefined }

	const reader = new ShapeReader(file)
	const dg = artRecords(file.stream, drawing.start, drawing.end).find(record => record.type === 0xf002)

	if (dg === undefined) return { shapes: [], background: undefined }

	let shapes: readonly PptShape[] = []
	let background: PptShape | undefined

	for (const record of artRecords(file.stream, dg.start, dg.end)) {
		if (record.type === RT_SPGR_CONTAINER) {
			shapes = reader.group(record, 0)?.children ?? []
		} else if (record.type === RT_SP_CONTAINER) {
			const shape = reader.shape(record)

			if (shape !== undefined && (shape.flags & 0x400) !== 0) background = shape
		}
	}

	return { shapes, background }
}

// --- Properties ---

// MS-ODRAW §2.3 property ids the conversion reads.
export const P = {
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
	tableProperties: 0x039f,
	groupShapeBooleans: 0x03bf
} as const

// A property, looked up through the shape, its master shape, then the drawing group's defaults.
export type PropertyChain = readonly ReadonlyMap<number, ArtProperty>[]

export function lookup(chain: PropertyChain, pid: number): ArtProperty | undefined {
	for (const map of chain) {
		const value = map.get(pid)

		if (value !== undefined) return value
	}

	return undefined
}

export function value(chain: PropertyChain, pid: number): number | undefined {
	return lookup(chain, pid)?.value
}

// A boolean of a property set (value bit `bit`, its fUse bit 16 higher), the first level that sets it.
export function flag(chain: PropertyChain, pid: number, bit: number): boolean | undefined {
	for (const map of chain) {
		const raw = map.get(pid)?.value

		if (raw !== undefined && ((raw >>> (bit + 16)) & 1) !== 0) return ((raw >>> bit) & 1) !== 0
	}

	return undefined
}

// An IMsoArray (MS-ODRAW §2.2.51): its element count, element size and data.
export function msoArray(
	bytes: Uint8Array | undefined
): { readonly count: number; readonly size: number; readonly data: Uint8Array } | undefined {
	if (bytes === undefined || bytes.length < 6) return undefined

	const count = u16(bytes, 0)
	const declared = u16(bytes, 4)
	const size = declared === 0xfff0 ? 4 : declared

	if (size === 0) return undefined

	const available = Math.floor((bytes.length - 6) / size)

	return { count: Math.min(count, available), size, data: bytes.subarray(6) }
}

// --- DrawingML ---

// One master unit (1/576 inch) in EMU.
export const EMU_PER_MASTER = 914400 / 576

export function emu(masterUnits: number): number {
	return Math.round(masterUnits * EMU_PER_MASTER)
}

// MSOSPT (MS-ODRAW §2.4.24) → ST_ShapeType (ECMA-376 §20.1.10.56). Text and WordArt types are rectangles with text.
const PRESETS: ReadonlyMap<number, string> = new Map(
	(
		[
			[1, "rect"],
			[2, "roundRect"],
			[3, "ellipse"],
			[4, "diamond"],
			[5, "triangle"],
			[6, "rtTriangle"],
			[7, "parallelogram"],
			[8, "trapezoid"],
			[9, "hexagon"],
			[10, "octagon"],
			[11, "plus"],
			[12, "star5"],
			[13, "rightArrow"],
			[14, "rightArrow"],
			[15, "homePlate"],
			[16, "cube"],
			[17, "wedgeRoundRectCallout"],
			[18, "star16"],
			[19, "arc"],
			[20, "line"],
			[21, "plaque"],
			[22, "can"],
			[23, "donut"],
			[32, "straightConnector1"],
			[33, "bentConnector2"],
			[34, "bentConnector3"],
			[35, "bentConnector4"],
			[36, "bentConnector5"],
			[37, "curvedConnector2"],
			[38, "curvedConnector3"],
			[39, "curvedConnector4"],
			[40, "curvedConnector5"],
			[41, "callout1"],
			[42, "callout2"],
			[43, "callout3"],
			[44, "accentCallout1"],
			[45, "accentCallout2"],
			[46, "accentCallout3"],
			[47, "borderCallout1"],
			[48, "borderCallout2"],
			[49, "borderCallout3"],
			[50, "accentBorderCallout1"],
			[51, "accentBorderCallout2"],
			[52, "accentBorderCallout3"],
			[53, "ribbon"],
			[54, "ribbon2"],
			[55, "chevron"],
			[56, "pentagon"],
			[57, "noSmoking"],
			[58, "star8"],
			[59, "star16"],
			[60, "star32"],
			[61, "wedgeRectCallout"],
			[62, "wedgeRoundRectCallout"],
			[63, "wedgeEllipseCallout"],
			[64, "wave"],
			[65, "foldedCorner"],
			[66, "leftArrow"],
			[67, "downArrow"],
			[68, "upArrow"],
			[69, "leftRightArrow"],
			[70, "upDownArrow"],
			[71, "irregularSeal1"],
			[72, "irregularSeal2"],
			[73, "lightningBolt"],
			[74, "heart"],
			[75, "rect"],
			[76, "quadArrow"],
			[77, "leftArrowCallout"],
			[78, "rightArrowCallout"],
			[79, "upArrowCallout"],
			[80, "downArrowCallout"],
			[81, "leftRightArrowCallout"],
			[82, "upDownArrowCallout"],
			[83, "quadArrowCallout"],
			[84, "bevel"],
			[85, "leftBracket"],
			[86, "rightBracket"],
			[87, "leftBrace"],
			[88, "rightBrace"],
			[89, "leftUpArrow"],
			[90, "bentUpArrow"],
			[91, "bentArrow"],
			[92, "star24"],
			[93, "stripedRightArrow"],
			[94, "notchedRightArrow"],
			[95, "blockArc"],
			[96, "smileyFace"],
			[97, "verticalScroll"],
			[98, "horizontalScroll"],
			[99, "circularArrow"],
			[100, "circularArrow"],
			[101, "uturnArrow"],
			[102, "curvedRightArrow"],
			[103, "curvedLeftArrow"],
			[104, "curvedUpArrow"],
			[105, "curvedDownArrow"],
			[106, "cloudCallout"],
			[107, "ellipseRibbon"],
			[108, "ellipseRibbon2"],
			[109, "flowChartProcess"],
			[110, "flowChartDecision"],
			[111, "flowChartInputOutput"],
			[112, "flowChartPredefinedProcess"],
			[113, "flowChartInternalStorage"],
			[114, "flowChartDocument"],
			[115, "flowChartMultidocument"],
			[116, "flowChartTerminator"],
			[117, "flowChartPreparation"],
			[118, "flowChartManualInput"],
			[119, "flowChartManualOperation"],
			[120, "flowChartConnector"],
			[121, "flowChartPunchedCard"],
			[122, "flowChartPunchedTape"],
			[123, "flowChartSummingJunction"],
			[124, "flowChartOr"],
			[125, "flowChartCollate"],
			[126, "flowChartSort"],
			[127, "flowChartExtract"],
			[128, "flowChartMerge"],
			[129, "flowChartOfflineStorage"],
			[130, "flowChartOnlineStorage"],
			[131, "flowChartMagneticTape"],
			[132, "flowChartMagneticDisk"],
			[133, "flowChartMagneticDrum"],
			[134, "flowChartDisplay"],
			[135, "flowChartDelay"],
			[176, "flowChartAlternateProcess"],
			[177, "flowChartOffpageConnector"],
			[178, "callout1"],
			[179, "accentCallout1"],
			[180, "borderCallout1"],
			[181, "accentBorderCallout1"],
			[182, "leftRightUpArrow"],
			[183, "sun"],
			[184, "moon"],
			[185, "bracketPair"],
			[186, "bracePair"],
			[187, "star4"],
			[188, "doubleWave"],
			[189, "actionButtonBlank"],
			[190, "actionButtonHome"],
			[191, "actionButtonHelp"],
			[192, "actionButtonInformation"],
			[193, "actionButtonForwardNext"],
			[194, "actionButtonBackPrevious"],
			[195, "actionButtonEnd"],
			[196, "actionButtonBeginning"],
			[197, "actionButtonReturn"],
			[198, "actionButtonDocument"],
			[199, "actionButtonSound"],
			[200, "actionButtonMovie"],
			[201, "rect"],
			[202, "rect"]
		] as const
	).map(([type, name]) => [type, name])
)

export function presetOf(shapeType: number): string | undefined {
	if (shapeType >= 24 && shapeType <= 31) return "rect"
	if (shapeType >= 136 && shapeType <= 175) return "rect"

	return PRESETS.get(shapeType)
}

export function isConnector(shapeType: number): boolean {
	return shapeType >= 32 && shapeType <= 40
}

export function isWordArt(shapeType: number): boolean {
	return (shapeType >= 24 && shapeType <= 31) || (shapeType >= 136 && shapeType <= 175)
}

// The adjust values (MS-ODRAW §2.3.6.10, shape coordinates of 21600) DrawingML guides take as a fraction of 100000,
// for the presets whose adjust means the same thing in both.
const ADJUST_FRACTIONS: ReadonlyMap<number, readonly string[]> = new Map([
	[2, ["adj"]],
	[7, ["adj"]],
	[8, ["adj"]],
	[9, ["adj"]],
	[10, ["adj"]],
	[11, ["adj"]],
	[21, ["adj"]],
	[22, ["adj"]],
	[23, ["adj"]],
	[65, ["adj"]],
	[84, ["adj"]],
	[109, []],
	[176, []]
])

export function adjustGuides(chain: PropertyChain, shapeType: number): string {
	const names = ADJUST_FRACTIONS.get(shapeType)
	const parts: string[] = []

	names?.forEach((name, index) => {
		const raw = value(chain, P.adjustValue + index)

		if (raw === undefined) return

		parts.push(`<a:gd name="${name}" fmla="val ${String(Math.round(((raw | 0) * 100000) / 21600))}"/>`)
	})

	return parts.join("")
}

// A signed 32-bit property value, 0 when unset.
export function i32Value(raw: number | undefined): number {
	return raw === undefined ? 0 : raw | 0
}

// The rectangle of a shape as DrawingML places it: a rotation of 45°–135° or 225°–315° stores the rectangle turned by
// 90° about its centre (MS-ODRAW §2.3.18.5), so its width and height swap back.
export function anchorBox(
	rect: Rect,
	rotation: number
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
	const width = rect.right - rect.left
	const height = rect.bottom - rect.top
	const turned = ((rotation % 360) + 360) % 360
	const swap = (turned >= 45 && turned < 135) || (turned >= 225 && turned < 315)

	if (!swap) return { x: rect.left, y: rect.top, w: width, h: height }

	const cx = rect.left + width / 2
	const cy = rect.top + height / 2

	return { x: cx - height / 2, y: cy - width / 2, w: height, h: width }
}

export interface ShapeGeometry {
	readonly xml: string
	// Path escapes (MS-ODRAW §2.2.54) drawn as straight lines.
	readonly approximations: number
}

// A shape's geometry as DrawingML: a freeform (or a type with no preset) with vertices as a custom geometry, else its
// preset with the adjust values that carry over; undefined for a type with neither.
export function shapeGeometry(chain: PropertyChain, shapeType: number): ShapeGeometry | undefined {
	const vertices = msoArray(lookup(chain, P.pVertices)?.complex)
	const preset = presetOf(shapeType)

	if (vertices !== undefined && vertices.count > 0 && (shapeType === 0 || preset === undefined)) return customGeometry(chain, vertices)

	if (preset === undefined) return undefined

	return { xml: `<a:prstGeom prst="${preset}"><a:avLst>${adjustGuides(chain, shapeType)}</a:avLst></a:prstGeom>`, approximations: 0 }
}

function customGeometry(
	chain: PropertyChain,
	vertices: { readonly count: number; readonly size: number; readonly data: Uint8Array }
): ShapeGeometry {
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

		return `<a:pt x="${String(Math.round(x - left))}" y="${String(Math.round(y - top))}"/>`
	}
	const segments = msoArray(lookup(chain, P.pSegmentInfo)?.complex)
	const paths: string[] = []
	let approximations = 0
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
						approximations++

						for (let n = 0; n < used; n++) current += `<a:lnTo>${point(next++)}</a:lnTo>`
					}
				}
			}
		}

		close()
	}

	if (paths.length === 0) paths.push(`<a:path w="${String(width)}" h="${String(height)}"/>`)

	return {
		xml: `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>${paths.join("")}</a:pathLst></a:custGeom>`,
		approximations
	}
}

export interface ColorSources {
	// The slide's colour scheme (8 RGB colours).
	readonly scheme: readonly number[]
	readonly chain: PropertyChain
}

// System colours (GetSysColor indices) as Windows' defaults draw them, for the few a drawing names.
const SYSTEM_COLORS: ReadonlyMap<number, number> = new Map([
	[0, 0xc0c0c0],
	[1, 0x000000],
	[4, 0xc0c0c0],
	[5, 0xffffff],
	[6, 0x000000],
	[8, 0x000000],
	[9, 0x000000],
	[15, 0xc0c0c0],
	[16, 0x808080],
	[18, 0x000000],
	[20, 0xffffff]
])

function modify(color: number, operation: number, parameter: number): number {
	const channel = (value: number): number => {
		switch (operation & 0x0f00) {
			case 0x0100:
				return (value * parameter) / 255
			case 0x0200:
				return 255 - ((255 - value) * parameter) / 255
			case 0x0300:
				return value + parameter
			case 0x0400:
				return value - parameter
			case 0x0500:
				return parameter - value
			case 0x0600:
				return value < parameter ? 0 : 255
			default:
				return value
		}
	}
	let r = (color >> 16) & 0xff
	let g = (color >> 8) & 0xff
	let b = color & 0xff

	if ((operation & 0x8000) !== 0) {
		const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b)

		r = gray
		g = gray
		b = gray
	}

	r = Math.max(0, Math.min(255, Math.round(channel(r))))
	g = Math.max(0, Math.min(255, Math.round(channel(g))))
	b = Math.max(0, Math.min(255, Math.round(channel(b))))

	if ((operation & 0x2000) !== 0) {
		r = 255 - r
		g = 255 - g
		b = 255 - b
	} else if ((operation & 0x4000) !== 0) {
		r ^= 0x80
		g ^= 0x80
		b ^= 0x80
	}

	return (r << 16) | (g << 8) | b
}

const DEFAULT_COLORS: Readonly<Record<number, number>> = {
	[P.fillColor]: 0xffffff,
	[P.fillBackColor]: 0xffffff,
	[P.lineColor]: 0x000000,
	[P.lineBackColor]: 0xffffff,
	[P.shadowColor]: 0x808080
}

// OfficeArtCOLORREF (MS-ODRAW §2.2.2) of property `pid` as RGB: scheme indices through the slide's scheme, the shape-
// relative system indices (0xF0–0xF7) through the shape's own colours, with their modification applied.
export function artColorOf(sources: ColorSources, pid: number, depth = 0): number {
	const raw = value(sources.chain, pid)

	return raw === undefined ? (DEFAULT_COLORS[pid] ?? 0) : colorRef(sources, raw, depth)
}

export function colorRef(sources: ColorSources, raw: number, depth = 0): number {
	const flags = raw >>> 24
	const red = raw & 0xff
	const green = (raw >>> 8) & 0xff
	const blue = (raw >>> 16) & 0xff

	if ((flags & 0x08) !== 0) return sources.scheme[red] ?? 0

	if ((flags & 0x10) !== 0) {
		const index = red | (green << 8)
		const source = index & 0xff
		let base: number

		if (depth > 4) base = 0
		else if (source === 0xf0 || source === 0xf7) base = artColorOf(sources, P.fillColor, depth + 1)
		else if (source === 0xf1 || source === 0xf2) base = artColorOf(sources, P.lineColor, depth + 1)
		else if (source === 0xf3) base = artColorOf(sources, P.shadowColor, depth + 1)
		else if (source === 0xf5) base = artColorOf(sources, P.fillBackColor, depth + 1)
		else if (source === 0xf6) base = artColorOf(sources, P.lineBackColor, depth + 1)
		else if (source === 0xf4) base = artColorOf(sources, P.fillColor, depth + 1)
		else base = SYSTEM_COLORS.get(index & 0xff) ?? 0x808080

		return modify(base, index & 0xff00, blue)
	}

	// A palette index names no colour this reader can know: black, as a default palette's first entry.
	if ((flags & 0x01) !== 0) return 0

	return (red << 16) | (green << 8) | blue
}

export function hex(rgb: number): string {
	return (rgb & 0xffffff).toString(16).toUpperCase().padStart(6, "0")
}

// FixedPoint 16.16 opacity → ST_PositiveFixedPercentage (1/1000 %), undefined when opaque.
export function alphaOf(raw: number | undefined): number | undefined {
	if (raw === undefined) return undefined

	const alpha = Math.round((Math.max(0, Math.min(65536, raw)) * 100000) / 65536)

	return alpha >= 100000 ? undefined : alpha
}

export function colorXml(rgb: number, alpha?: number): string {
	return alpha === undefined
		? `<a:srgbClr val="${hex(rgb)}"/>`
		: `<a:srgbClr val="${hex(rgb)}"><a:alpha val="${String(alpha)}"/></a:srgbClr>`
}
