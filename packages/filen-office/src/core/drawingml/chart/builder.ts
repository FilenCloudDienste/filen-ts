import { readColorIn, type DrawingTheme } from "../color"
import {
	IDENTITY,
	ItemKind,
	type DrawingList,
	type Rgba,
	type Stroke,
	type TextAnchor,
	type TextBodyProps,
	type TextParagraph
} from "../displayList"
import { NO_PAINT, fillChild, shapeFill, shapeLine, type PaintContext } from "../fill"
import { D, EMU_PER_PT, EMU_PER_PX, type DrawingReader } from "../reader"
import { resolveTypeface, type TextDefaults } from "../text"

export interface Rect {
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
}

export const PX_PER_PT = EMU_PER_PT / EMU_PER_PX

// What a chart shows where its file names nothing: an unnamed series, an automatic chart or axis title. The host
// passes its catalog's texts (plain data: it crosses to a worker); English, as Office writes them, otherwise.
export interface ChartText {
	// The name of an unnamed series, "{n}" its 1-based position.
	readonly series: string
	readonly chartTitle: string
	readonly axisTitle: string
}

export const CHART_TEXT_EN: ChartText = {
	series: "Series{n}",
	chartTitle: "Chart Title",
	axisTitle: "Axis Title"
}

// The name of the unnamed series at 1-based position `n`.
export function unnamedSeries(text: ChartText, n: number): string {
	return text.series.replaceAll("{n}", String(n))
}

// Text is never measured here. Space reserved for labels and the boxes they are placed in use these
// estimates: an average glyph advance of 0.6 em and a line height of 1.2 em.
export function estimateWidth(text: string, size: number): number {
	let longest = 0

	for (const line of text.split("\n")) longest = Math.max(longest, line.length)

	return longest * size * PX_PER_PT * 0.6
}

export function estimateHeight(size: number, lines: number = 1): number {
	return lines * size * PX_PER_PT * 1.2
}

export function labelBody(anchor: TextAnchor, rotation: number = 0): TextBodyProps {
	return {
		insets: { left: 0, top: 0, right: 0, bottom: 0 },
		anchor,
		anchorCenter: false,
		vertical: "horz",
		wrap: false,
		rotation,
		upright: false,
		columns: 1,
		columnSpacing: 0,
		autofit: "none",
		fontScale: 1,
		lineSpacingReduction: 0
	}
}

export interface LineDefault {
	readonly color: Rgba
	// px.
	readonly width: number
	readonly round: boolean
}

// Drawing helpers over the list: paths, labels and the c:spPr/c:txPr readers every chart element uses.
export class ChartBuilder {
	readonly list: DrawingList
	readonly context: PaintContext
	readonly reader: DrawingReader
	readonly theme: DrawingTheme
	readonly style: number
	readonly date1904: boolean
	// Run defaults of the whole chart (c:chartSpace/c:txPr over the built-in 10pt).
	readonly text: TextDefaults
	// Places every item: identity for a chart drawn alone, a group's transform for one inside a group.
	readonly matrix: readonly number[]
	readonly chartText: ChartText
	private commandMark = 0
	private coordMark = 0

	constructor(
		context: PaintContext,
		reader: DrawingReader,
		style: number,
		date1904: boolean,
		text: TextDefaults,
		matrix: readonly number[] = IDENTITY,
		chartText: ChartText = CHART_TEXT_EN
	) {
		this.matrix = matrix
		this.chartText = chartText
		this.list = context.list
		this.context = context
		this.reader = reader
		this.theme = context.theme
		this.style = style
		this.date1904 = date1904
		this.text = text
	}

	begin(): void {
		this.commandMark = this.list.commandCount
		this.coordMark = this.list.coordCount
	}

	// A path item from the commands since begin(); nothing when none were appended or nothing paints.
	end(fill: number, stroke: number, box: Rect, flags: number = 0, source: number = -1): void {
		const list = this.list

		if (list.commandCount === this.commandMark || (fill < 0 && stroke < 0)) {
			list.rewindPath(this.commandMark, this.coordMark)

			return
		}

		list.addItem(
			ItemKind.PATH,
			this.matrix,
			box.x,
			box.y,
			box.w,
			box.h,
			this.commandMark,
			this.coordMark,
			fill,
			stroke,
			-1,
			-1,
			flags,
			source
		)
	}

	rect(x: number, y: number, w: number, h: number): void {
		const list = this.list

		list.moveTo(x, y)
		list.lineTo(x + w, y)
		list.lineTo(x + w, y + h)
		list.lineTo(x, y + h)
		list.close()
	}

	// A rectangle with corners rounded by `radius`.
	roundRect(x: number, y: number, w: number, h: number, radius: number): void {
		const r = Math.min(radius, w / 2, h / 2)
		const k = r * 0.5522847498
		const list = this.list

		list.moveTo(x + r, y)
		list.lineTo(x + w - r, y)
		list.cubicTo(x + w - r + k, y, x + w, y + r - k, x + w, y + r)
		list.lineTo(x + w, y + h - r)
		list.cubicTo(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h)
		list.lineTo(x + r, y + h)
		list.cubicTo(x + r - k, y + h, x, y + h - r + k, x, y + h - r)
		list.lineTo(x, y + r)
		list.cubicTo(x, y + r - k, x + r - k, y, x + r, y)
		list.close()
	}

	segment(x1: number, y1: number, x2: number, y2: number): void {
		this.list.moveTo(x1, y1)
		this.list.lineTo(x2, y2)
	}

	// Appends a circular arc from angle a0 to a1 (radians, clockwise, y down), assuming the current point
	// is on the circle at a0.
	arc(cx: number, cy: number, r: number, a0: number, a1: number): void {
		const sweep = a1 - a0
		const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
		const step = sweep / segments
		const k = (4 / 3) * Math.tan(step / 4)
		let a = a0

		for (let s = 0; s < segments; s++) {
			const b = a + step
			const cosA = Math.cos(a)
			const sinA = Math.sin(a)
			const cosB = Math.cos(b)
			const sinB = Math.sin(b)

			this.list.cubicTo(
				cx + r * (cosA - k * sinA),
				cy + r * (sinA + k * cosA),
				cx + r * (cosB + k * sinB),
				cy + r * (sinB - k * cosB),
				cx + r * cosB,
				cy + r * sinB
			)
			a = b
		}
	}

	solid(color: Rgba): number {
		return this.list.paint({ kind: "solid", color })
	}

	plainStroke(color: Rgba, width: number, round: boolean = false): number {
		const stroke: Stroke = {
			width,
			paint: this.solid(color),
			dash: "solid",
			customDash: null,
			cap: round ? "round" : "flat",
			join: "round",
			miterLimit: 8,
			compound: "sng",
			inset: false
		}

		return this.list.stroke(stroke)
	}

	// The fill of a c:spPr: its own fill element, else `fallback` (undefined: nothing).
	fill(spPr: number, fallback: Rgba | undefined): number {
		const own = spPr < 0 ? undefined : shapeFill(this.context, this.reader, spPr, undefined)

		if (own === NO_PAINT) return -1
		if (own !== undefined && own >= 0) return own

		return fallback === undefined ? -1 : this.solid(fallback)
	}

	// The line of a c:spPr: its a:ln, missing parts taken from `fallback` (undefined: no line unless the
	// a:ln has a fill of its own).
	line(spPr: number, fallback: LineDefault | undefined): number {
		const reader = this.reader
		const ln = reader.child(spPr, D.A, "ln")

		if (ln < 0) return fallback === undefined ? -1 : this.plainStroke(fallback.color, fallback.width, fallback.round)

		const lineFill = fillChild(reader, ln)

		if (lineFill >= 0 && reader.local(lineFill) === "noFill") return -1

		const style = shapeLine(this.context, reader, ln, fallback === undefined ? undefined : { reader, node: -1, color: fallback.color })

		if (style === undefined) return fallback === undefined ? -1 : this.plainStroke(fallback.color, fallback.width, fallback.round)
		if (fallback === undefined || reader.attr(ln, "w") !== undefined) return style.stroke

		const stroke = this.list.strokes[style.stroke]

		return stroke === undefined ? style.stroke : this.list.stroke({ ...stroke, width: fallback.width })
	}

	// Run defaults of a c:txPr (its first paragraph's a:defRPr) over `base`.
	textProps(txPr: number, base: TextDefaults = this.text): TextDefaults {
		const reader = this.reader
		const defRPr = reader.child(reader.child(reader.child(txPr, D.A, "p"), D.A, "pPr"), D.A, "defRPr")

		if (defRPr < 0) return base

		const size = reader.number(defRPr, "sz", Number.NaN)
		const color = readColorIn(reader, reader.child(defRPr, D.A, "solidFill"), this.theme)
		const font = resolveTypeface(this.theme, reader.attr(reader.child(defRPr, D.A, "latin"), "typeface"))

		return {
			size: size > 0 ? size / 100 : base.size,
			color: color ?? base.color,
			font: font ?? base.font,
			bold: reader.attr(defRPr, "b") === undefined ? base.bold : reader.bool(defRPr, "b", false),
			italic: reader.attr(defRPr, "i") === undefined ? base.italic : reader.bool(defRPr, "i", false)
		}
	}

	// The a:bodyPr rotation of a c:txPr or c:rich in degrees, or undefined.
	textRotation(container: number): number | undefined {
		const bodyPr = this.reader.child(container, D.A, "bodyPr")

		if (bodyPr < 0 || this.reader.attr(bodyPr, "rot") === undefined) return undefined

		return this.reader.angle(bodyPr, "rot", 0)
	}

	label(paragraphs: readonly TextParagraph[], box: Rect, body: TextBodyProps, source: number = -1): void {
		const list = this.list
		const text = list.text({ kind: "body", body, paragraphs })

		list.addItem(
			ItemKind.TEXT,
			this.matrix,
			box.x,
			box.y,
			box.w,
			box.h,
			list.commandCount,
			list.coordCount,
			-1,
			-1,
			text,
			-1,
			0,
			source
		)
	}
}
