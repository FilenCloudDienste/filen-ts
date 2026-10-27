import type { Deck, FillProps, LineProps, ShapeNode, SlideRef, TableCell, TableModel, TextBody, Xfrm } from "../../model"
import type { DeckOp, InsertedImage } from "../ops"

// Inserting objects as PowerPoint's Insert tab does: a preset shape, a text box, a picture and a table, each one op
// (one history step) whose new shape the worker gives an id (0 asks for one). Boxes are slide EMU; with none given,
// the object takes PowerPoint's default size centred on the slide. A pptx shape takes the theme through the default
// shape style (p:style: line accent1 shaded, fill accent1, font lt1, as PowerPoint writes a new shape); ODP has no
// shape styles, so an ODP shape carries the same look as colours (ODF graphic properties take sRGB only).

const EMU_PER_INCH = 914_400
// PowerPoint's size for a shape or text box inserted with a click (no drag): 1 in square; a text box one line high.
const DEFAULT_SHAPE = EMU_PER_INCH
const TEXT_BOX_HEIGHT = 369_332
// A new table's row height (0.4 in) and its width share of the slide.
export const TABLE_ROW_HEIGHT = 370_840
const TABLE_WIDTH_SHARE = 0.8
// A picture takes its own size at 96 dpi, held to this share of the slide.
const PICTURE_SHARE = 0.9
const EMU_PER_PX = 9525

// PowerPoint's default table style (Medium Style 2 – Accent 1) and flags.
export const DEFAULT_TABLE_STYLE = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"

// The Office theme's accent 1 and its 50% shade, and the band tints of Medium Style 2 (ODP only).
const ODP_ACCENT = "4472C4"
const ODP_ACCENT_SHADE = "2F528F"
const ODP_BAND = ["CFD5EA", "E9EBF5"] as const

// The preset shapes the gallery offers (ECMA-376 Part 1 §20.1.10.56 ST_ShapeType), in PowerPoint's gallery order by
// group. Every one has an ODF draw:type the ODP writer maps.
export const SHAPE_GALLERY = {
	lines: ["line"],
	rectangles: ["rect", "roundRect"],
	basic: [
		"ellipse",
		"triangle",
		"rtTriangle",
		"parallelogram",
		"trapezoid",
		"diamond",
		"pentagon",
		"hexagon",
		"octagon",
		"plus",
		"donut",
		"frame",
		"heart",
		"smileyFace",
		"cloud"
	],
	arrows: ["rightArrow", "leftArrow", "upArrow", "downArrow"],
	stars: ["star5"]
} as const

export type ShapeGalleryGroup = keyof typeof SHAPE_GALLERY
export type GalleryPreset = (typeof SHAPE_GALLERY)[ShapeGalleryGroup][number]

const PRESET_NAMES: Readonly<Record<GalleryPreset, string>> = {
	line: "Straight Connector",
	rect: "Rectangle",
	roundRect: "Rectangle: Rounded Corners",
	ellipse: "Oval",
	triangle: "Isosceles Triangle",
	rtTriangle: "Right Triangle",
	parallelogram: "Parallelogram",
	trapezoid: "Trapezoid",
	diamond: "Diamond",
	pentagon: "Pentagon",
	hexagon: "Hexagon",
	octagon: "Octagon",
	plus: "Cross",
	donut: "Circle: Hollow",
	frame: "Frame",
	heart: "Heart",
	smileyFace: "Smiley Face",
	cloud: "Cloud",
	rightArrow: "Arrow: Right",
	leftArrow: "Arrow: Left",
	upArrow: "Arrow: Up",
	downArrow: "Arrow: Down",
	star5: "Star: 5 Points"
}

// What an insert needs of the deck (the page knows it from OpenInfo): its slide size and format.
export type InsertDeck = Pick<Deck, "size" | "format">

// The next cNvPr id of a slide from the ids the page knows (its render's layers): what the worker would give.
export function nextShapeIdOf(ids: Iterable<number>): number {
	let max = 1

	for (const id of ids) if (id > max) max = id

	return max + 1
}

function centred(deck: InsertDeck, cx: number, cy: number): Xfrm {
	return {
		x: Math.round((deck.size.cx - cx) / 2),
		y: Math.round((deck.size.cy - cy) / 2),
		cx: Math.round(cx),
		cy: Math.round(cy),
		rot: 0,
		flipH: false,
		flipV: false
	}
}

function srgb(rgb: string): FillProps {
	return { kind: "solid", color: { kind: "srgb", rgb } }
}

function emptyText(body: Partial<TextBody["bodyPr"]>, endRPr?: TextBody["paragraphs"][number]["endRPr"]): TextBody {
	return { bodyPr: body, paragraphs: [{ pPr: {}, runs: [], ...(endRPr === undefined ? {} : { endRPr }) }] }
}

// A preset shape: `box` where dragged, else 1 in square centred (a line runs across it).
export function insertShapeOp(deck: InsertDeck, slide: SlideRef, preset: GalleryPreset, id: number, box?: Xfrm): DeckOp {
	const xfrm = box ?? centred(deck, DEFAULT_SHAPE, DEFAULT_SHAPE)
	const line = preset === "line"
	const geometry = { kind: "preset" as const, preset, guides: [] }
	const odp = deck.format === "odp"
	const props: ShapeNode["props"] = odp
		? line
			? { geometry, ln: { w: 9525, fill: srgb(ODP_ACCENT) } satisfies LineProps }
			: { geometry, fill: srgb(ODP_ACCENT), ln: { w: 12_700, fill: srgb(ODP_ACCENT_SHADE) } satisfies LineProps }
		: { geometry }
	const shape: ShapeNode = {
		id,
		name: `${PRESET_NAMES[preset]} ${String(Math.max(1, id - 1))}`,
		hidden: false,
		kind: line ? "cxnSp" : "sp",
		xfrm,
		props,
		...(odp
			? {}
			: {
					style: line
						? {
								ln: { idx: 1, color: { kind: "scheme", slot: "accent1" } },
								fill: { idx: 0, color: { kind: "scheme", slot: "accent1" } },
								effect: { idx: 0, color: { kind: "scheme", slot: "accent1" } },
								font: { idx: "minor", color: { kind: "scheme", slot: "tx1" } }
							}
						: {
								ln: { idx: 2, color: { kind: "scheme", slot: "accent1", mods: [{ name: "shade", value: 50_000 }] } },
								fill: { idx: 1, color: { kind: "scheme", slot: "accent1" } },
								effect: { idx: 0, color: { kind: "scheme", slot: "accent1" } },
								font: { idx: "minor", color: { kind: "scheme", slot: "lt1" } }
							}
				}),
		...(line ? {} : { text: emptyText({ anchor: "ctr" }, odp ? { fill: srgb("FFFFFF") } : undefined) })
	}

	return { family: "shape", kind: "insert", slide, shape }
}

// A text box: `box` where dragged (its width wraps the text), else one line high at PowerPoint's default width,
// centred; it grows with its text (spAutoFit).
export function insertTextBoxOp(deck: InsertDeck, slide: SlideRef, id: number, box?: Xfrm): DeckOp {
	const xfrm = box ?? centred(deck, Math.min(deck.size.cx, 2_743_200), TEXT_BOX_HEIGHT)
	const shape: ShapeNode = {
		id,
		name: `TextBox ${String(Math.max(1, id - 1))}`,
		hidden: false,
		kind: "sp",
		txBox: true,
		xfrm,
		props: { geometry: { kind: "preset", preset: "rect", guides: [] }, ...(deck.format === "odp" ? { fill: "none", ln: "none" } : {}) },
		text: emptyText({ wrap: true, autofit: "shape" })
	}

	return { family: "shape", kind: "insert", slide, shape }
}

// The box a picture takes: its pixels at 96 dpi, scaled down to fit the slide (keeping its proportions), centred.
export function pictureBox(deck: InsertDeck, width: number, height: number): Xfrm {
	let cx = width * EMU_PER_PX
	let cy = height * EMU_PER_PX
	const scale = Math.min(1, (deck.size.cx * PICTURE_SHARE) / cx, (deck.size.cy * PICTURE_SHARE) / cy)

	cx *= scale
	cy *= scale

	return centred(deck, Math.max(1, cx), Math.max(1, cy))
}

export function insertPictureOp(deck: InsertDeck, slide: SlideRef, image: InsertedImage, id: number, name?: string, box?: Xfrm): DeckOp {
	const shape: ShapeNode = {
		id,
		name: `Picture ${String(Math.max(1, id - 1))}`,
		hidden: false,
		kind: "pic",
		xfrm: box ?? pictureBox(deck, image.width, image.height),
		...(name === undefined || name === "" ? {} : { alt: { descr: name } })
	}

	return { family: "picture", kind: "insert", slide, shape, image }
}

// An ODP cell of the Medium Style 2 look, as properties: the header row accent with white bold text, the body rows
// banded in its tints, white borders.
function odpCell(row: number): TableCell {
	const header = row === 0
	const border: LineProps = { w: 12_700, fill: srgb("FFFFFF") }

	return {
		text: emptyText({}, header ? { b: true, fill: srgb("FFFFFF") } : undefined),
		props: {
			fill: srgb(header ? ODP_ACCENT : (ODP_BAND[(row - 1) % 2] as string)),
			borders: { l: border, r: border, t: border, b: border }
		}
	}
}

// A rows × cols table: 80% of the slide's width in equal columns, 0.4 in rows, centred; PowerPoint's default style
// and flags in pptx, the same look as cell properties in ODP.
export function newTable(deck: InsertDeck, rows: number, cols: number): TableModel {
	const width = Math.round((deck.size.cx * TABLE_WIDTH_SHARE) / cols)
	const odp = deck.format === "odp"

	return {
		grid: Array.from({ length: cols }, () => width),
		rows: Array.from({ length: rows }, (_, r) => ({
			h: TABLE_ROW_HEIGHT,
			cells: Array.from({ length: cols }, () => (odp ? odpCell(r) : { text: emptyText({}) }))
		})),
		...(odp ? {} : { styleId: DEFAULT_TABLE_STYLE }),
		flags: { firstRow: true, lastRow: false, firstCol: false, lastCol: false, bandRow: true, bandCol: false }
	}
}

export const MAX_INSERT_ROWS = 75
export const MAX_INSERT_COLS = 75

export function insertTableOp(deck: InsertDeck, slide: SlideRef, rows: number, cols: number, id: number): DeckOp | undefined {
	if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > MAX_INSERT_ROWS || cols > MAX_INSERT_COLS)
		return undefined

	const table = newTable(deck, rows, cols)
	const cx = table.grid.reduce((sum, width) => sum + width, 0)
	const shape: ShapeNode = {
		id,
		name: `Table ${String(Math.max(1, id - 1))}`,
		hidden: false,
		kind: "frame",
		xfrm: centred(deck, cx, rows * TABLE_ROW_HEIGHT),
		frame: { kind: "table", table }
	}

	return { family: "shape", kind: "insert", slide, shape }
}
