import { attr, clamp, hexColor } from "./xml"

// DrawingML for converted pictures and shapes (ECMA-376 Part 1 §20.4 wordprocessingDrawing, §20.2 picture,
// Word 2010 wordprocessingShape).

export const EMU_PER_TWIP = 635

export interface Crop {
	// Fractions of the picture cut from each side (0–1).
	readonly left: number
	readonly top: number
	readonly right: number
	readonly bottom: number
}

export interface DrawingName {
	readonly id: number
	readonly name: string
	readonly description: string | undefined
}

function docPr(name: DrawingName): string {
	return `<wp:docPr${attr("id", name.id)}${attr("name", name.name)}${name.description === undefined ? "" : attr("descr", name.description)}/>`
}

function emu(value: number): number {
	return clamp(value, 0, 27273042316900)
}

function srcRect(crop: Crop | undefined): string {
	if (crop === undefined) return ""

	const part = (value: number): number => clamp(value * 100000, -10000000, 10000000)
	const sides: [string, number][] = [
		["l", part(crop.left)],
		["t", part(crop.top)],
		["r", part(crop.right)],
		["b", part(crop.bottom)]
	]

	if (sides.every(([, value]) => value === 0)) return ""

	return `<a:srcRect${sides.map(([name, value]) => (value === 0 ? "" : attr(name, value))).join("")}/>`
}

export interface Transform {
	// 60000ths of a degree, clockwise.
	readonly rotation?: number
	readonly flipH?: boolean
	readonly flipV?: boolean
}

// A shape's box: in the drawing's frame at the origin, or a group member's box in its group's coordinate space.
export interface Box {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

// ST_Coordinate.
function coordinate(value: number): number {
	return clamp(value, -27273042329600, 27273042316900)
}

function xfrm(box: Box, transform: Transform, children?: Box): string {
	return `<a:xfrm${transform.rotation === undefined || transform.rotation === 0 ? "" : attr("rot", transform.rotation)}${transform.flipH === true ? ' flipH="1"' : ""}${
		transform.flipV === true ? ' flipV="1"' : ""
	}><a:off${attr("x", coordinate(box.x))}${attr("y", coordinate(box.y))}/><a:ext${attr("cx", emu(box.width))}${attr("cy", emu(box.height))}/>${
		children === undefined
			? ""
			: `<a:chOff${attr("x", coordinate(children.x))}${attr("y", coordinate(children.y))}/><a:chExt${attr("cx", emu(children.width))}${attr("cy", emu(children.height))}/>`
	}</a:xfrm>`
}

function graphic(uri: string, content: string): string {
	return `<a:graphic><a:graphicData uri="${uri}">${content}</a:graphicData></a:graphic>`
}

// A pic:pic, alone in a drawing or a member of a group.
export function pictureElement(
	relationship: string,
	box: Box,
	name: DrawingName,
	crop: Crop | undefined,
	transform: Transform = {}
): string {
	return (
		"<pic:pic>" +
		`<pic:nvPicPr><pic:cNvPr id="0"${attr("name", name.name)}/><pic:cNvPicPr/></pic:nvPicPr>` +
		`<pic:blipFill><a:blip${attr("r:embed", relationship)}/>${srcRect(crop)}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
		`<pic:spPr>${xfrm(box, transform)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
		"</pic:pic>"
	)
}

export function pictureGraphic(
	relationship: string,
	width: number,
	height: number,
	name: DrawingName,
	crop: Crop | undefined,
	transform: Transform = {}
): string {
	return graphic(
		"http://schemas.openxmlformats.org/drawingml/2006/picture",
		pictureElement(relationship, { x: 0, y: 0, width, height }, name, crop, transform)
	)
}

// A preset geometry with no adjust values.
export function presetGeometry(preset: string): string {
	return `<a:prstGeom${attr("prst", preset)}><a:avLst/></a:prstGeom>`
}

export interface ShapeLook {
	// a:prstGeom or a:custGeom.
	readonly geometry: string
	// RGB, or undefined for no fill / no line.
	readonly fill: number | undefined
	readonly line: number | undefined
	// EMUs.
	readonly lineWidth: number
	readonly textBox: boolean
	// Insets of the text in EMUs: left, top, right, bottom.
	readonly insets: readonly [number, number, number, number]
}

// A wps:wsp, alone in a drawing or a member of a group (which names it).
export function shapeElement(
	box: Box,
	look: ShapeLook,
	content: string | undefined,
	transform: Transform = {},
	name?: DrawingName
): string {
	const fill = look.fill === undefined ? "<a:noFill/>" : `<a:solidFill><a:srgbClr${attr("val", hexColor(look.fill))}/></a:solidFill>`
	const line =
		look.line === undefined
			? "<a:ln><a:noFill/></a:ln>"
			: `<a:ln${attr("w", clamp(look.lineWidth, 0, 20116800))}><a:solidFill><a:srgbClr${attr("val", hexColor(look.line))}/></a:solidFill></a:ln>`
	const [left, top, right, bottom] = look.insets

	return (
		"<wps:wsp>" +
		(name === undefined
			? ""
			: `<wps:cNvPr${attr("id", name.id)}${attr("name", name.name)}${name.description === undefined ? "" : attr("descr", name.description)}/>`) +
		(look.textBox ? '<wps:cNvSpPr txBox="1"/>' : "<wps:cNvSpPr/>") +
		`<wps:spPr>${xfrm(box, transform)}${look.geometry}${fill}${line}</wps:spPr>` +
		(content === undefined ? "" : `<wps:txbx><w:txbxContent>${content}</w:txbxContent></wps:txbx>`) +
		`<wps:bodyPr${attr("lIns", emu(left))}${attr("tIns", emu(top))}${attr("rIns", emu(right))}${attr("bIns", emu(bottom))}/>` +
		"</wps:wsp>"
	)
}

export function shapeGraphic(
	width: number,
	height: number,
	look: ShapeLook,
	content: string | undefined,
	transform: Transform = {}
): string {
	return graphic(
		"http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
		shapeElement({ x: 0, y: 0, width, height }, look, content, transform)
	)
}

// A wpg:grpSp: a subgroup at `box` in its parent's coordinate space, its members in `children`'s.
export function groupElement(box: Box, children: Box, members: string, transform: Transform = {}): string {
	return `<wpg:grpSp><wpg:cNvGrpSpPr/><wpg:grpSpPr>${xfrm(box, transform, children)}</wpg:grpSpPr>${members}</wpg:grpSp>`
}

// A wpg:wgp (Word 2010 wordprocessingGroup) of the drawing's size, its members in `children`'s coordinate space.
export function groupGraphic(width: number, height: number, children: Box, members: string, transform: Transform = {}): string {
	return graphic(
		"http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
		`<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr>${xfrm({ x: 0, y: 0, width, height }, transform, children)}</wpg:grpSpPr>${members}</wpg:wgp>`
	)
}

export function inline(graphic: string, width: number, height: number, name: DrawingName): string {
	return (
		`<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent${attr("cx", emu(width))}${attr("cy", emu(height))}/>` +
		`${docPr(name)}<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>${graphic}</wp:inline></w:drawing>`
	)
}

export interface Placement {
	// FSPA bx, or posrelh (MS-ODRAW §2.3.4.20): 0 margin, 1 page, 2 column, 3 character; FSPA by, or posrelv
	// (§2.3.4.22): 0 margin, 1 page, 2 paragraph, 3 line.
	readonly relativeH: number
	readonly relativeV: number
	// EMUs from the reference edge.
	readonly x: number
	readonly y: number
	// posh / posv (§2.3.4.19, §2.3.4.21) other than absolute: the ST_AlignH / ST_AlignV the shape aligns to instead.
	readonly alignH: string | undefined
	readonly alignV: string | undefined
	// FSPA wr / wrk.
	readonly wrap: number
	readonly wrapSide: number
	readonly behindText: boolean
	// z-order among the anchored drawings.
	readonly order: number
	// Wrap distances in EMUs: top, bottom, left, right.
	readonly distances: readonly [number, number, number, number]
}

const WRAP_SIDES = ["bothSides", "left", "right", "largest"]
const RELATIVE_H = ["margin", "page", "column", "character"]
const RELATIVE_V = ["margin", "page", "paragraph", "line"]

function wrapping(placement: Placement): string {
	const side = attr("wrapText", WRAP_SIDES[placement.wrapSide] ?? "bothSides")
	const polygon =
		'<wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon>'

	switch (placement.wrap) {
		case 1:
			return "<wp:wrapTopAndBottom/>"
		case 3:
			return "<wp:wrapNone/>"
		case 4:
			return `<wp:wrapTight${side}>${polygon}</wp:wrapTight>`
		case 5:
			return `<wp:wrapThrough${side}>${polygon}</wp:wrapThrough>`
		default:
			return `<wp:wrapSquare${side}/>`
	}
}

export function anchor(graphic: string, width: number, height: number, name: DrawingName, placement: Placement): string {
	const [top, bottom, left, right] = placement.distances
	const relativeH = RELATIVE_H[placement.relativeH] ?? "margin"
	const relativeV = RELATIVE_V[placement.relativeV] ?? "margin"
	// ST_PositionOffset is a 32-bit integer.
	const offset = (value: number, align: string | undefined): string =>
		align === undefined
			? `<wp:posOffset>${String(clamp(value, -2147483648, 2147483647))}</wp:posOffset>`
			: `<wp:align>${align}</wp:align>`

	return (
		`<w:drawing><wp:anchor${attr("distT", emu(top))}${attr("distB", emu(bottom))}${attr("distL", emu(left))}${attr("distR", emu(right))} simplePos="0"${attr(
			"relativeHeight",
			clamp(placement.order, 0, 0xfffffff)
		)}${attr("behindDoc", placement.behindText ? 1 : 0)} locked="0" layoutInCell="1" allowOverlap="1">` +
		'<wp:simplePos x="0" y="0"/>' +
		`<wp:positionH${attr("relativeFrom", relativeH)}>${offset(placement.x, placement.alignH)}</wp:positionH>` +
		`<wp:positionV${attr("relativeFrom", relativeV)}>${offset(placement.y, placement.alignV)}</wp:positionV>` +
		`<wp:extent${attr("cx", emu(width))}${attr("cy", emu(height))}/>${wrapping(placement)}${docPr(name)}<wp:cNvGraphicFramePr/>${graphic}</wp:anchor></w:drawing>`
	)
}
