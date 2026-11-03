import type { SheetBorderLine, SheetBorderStyle } from "../../../core/sheet/protocol"
import { rgb, type GridCanvas } from "./canvas"

// Cell borders as Excel draws them: every ECMA-376 §18.18.3 line style, centred on the gridline between two
// cells. Where two cells name different lines for the edge they share, the heavier one is drawn (by the weight
// below; on a tie, the right or lower cell's), so an edge is drawn once.

// An automatic line on a fill: black, as on paper.
const PAPER_LINE = "#000000"

interface LineSpec {
	readonly width: number
	readonly dash: readonly number[]
	readonly weight: number
	readonly double?: boolean
}

// Dash lengths in pixels at 100 %, after Excel's on-screen rendering of each style.
const LINES: Record<SheetBorderStyle, LineSpec> = {
	hair: { width: 1, dash: [1, 1], weight: 1 },
	dotted: { width: 1, dash: [1, 2], weight: 2 },
	dashDotDot: { width: 1, dash: [9, 3, 3, 3, 3, 3], weight: 3 },
	dashDot: { width: 1, dash: [9, 3, 3, 3], weight: 4 },
	dashed: { width: 1, dash: [3, 1], weight: 5 },
	thin: { width: 1, dash: [], weight: 6 },
	mediumDashDotDot: { width: 2, dash: [9, 3, 3, 3, 3, 3], weight: 7 },
	slantDashDot: { width: 2, dash: [11, 1, 5, 1], weight: 8 },
	mediumDashDot: { width: 2, dash: [9, 3, 3, 3], weight: 9 },
	mediumDashed: { width: 2, dash: [9, 3], weight: 10 },
	medium: { width: 2, dash: [], weight: 11 },
	thick: { width: 3, dash: [], weight: 12 },
	double: { width: 1, dash: [], weight: 13, double: true }
}

// The line drawn where `first` (left or upper cell) and `second` meet.
export function strongerLine(first: SheetBorderLine | undefined, second: SheetBorderLine | undefined): SheetBorderLine | undefined {
	if (first === undefined) return second
	if (second === undefined) return first

	return LINES[first.style].weight > LINES[second.style].weight ? first : second
}

export class BorderPainter {
	private style = ""
	private width = -1
	private dash: readonly number[] | null = null

	private readonly canvas: GridCanvas

	constructor(canvas: GridCanvas) {
		this.canvas = canvas
	}

	// Automatic (black) lines take the theme's border colour, so they stay seen on a dark grid; next to a fill the file
	// chose they stay black, as its text there does (the file drew them for paper).
	private automatic = "#000000"

	reset(automatic?: string): void {
		this.style = ""
		this.width = -1
		this.dash = null

		if (automatic !== undefined) this.automatic = automatic
	}

	private use(line: SheetBorderLine, width: number, dash: readonly number[], onFill: boolean): void {
		const style = line.color !== 0 ? rgb(line.color) : onFill ? PAPER_LINE : this.automatic

		if (style !== this.style) {
			this.canvas.strokeStyle = style
			this.style = style
		}

		if (width !== this.width) {
			this.canvas.lineWidth = width
			this.width = width
		}

		if (dash !== this.dash) {
			this.canvas.setLineDash(dash as number[])
			this.dash = dash
		}
	}

	private segment(x1: number, y1: number, x2: number, y2: number): void {
		this.canvas.beginPath()
		this.canvas.moveTo(x1, y1)
		this.canvas.lineTo(x2, y2)
		this.canvas.stroke()
	}

	// A horizontal edge at y (the gridline's pixel centre) from x1 to x2, or a vertical one. `onFill`: a cell on
	// either side has a fill.
	edge(line: SheetBorderLine, horizontal: boolean, at: number, from: number, to: number, scale: number, onFill = false): void {
		const spec = LINES[line.style]
		const width = Math.max(1, Math.round(spec.width * scale))
		const dash = spec.dash.length === 0 ? spec.dash : spec.dash.map(length => length * Math.max(1, scale))
		// Odd widths sit on the pixel centre, even ones on the pixel edge, so both draw crisp.
		const centre = width % 2 === 1 ? at : at + 0.5

		this.use(line, width, dash, onFill)

		if (spec.double === true) {
			const gap = Math.max(1, Math.round(scale))

			for (const offset of [-gap, gap]) {
				if (horizontal) this.segment(from, centre + offset, to, centre + offset)
				else this.segment(centre + offset, from, centre + offset, to)
			}

			return
		}

		if (horizontal) this.segment(from, centre, to, centre)
		else this.segment(centre, from, centre, to)
	}

	// A diagonal across the box: "up" from its lower left to its upper right, "down" from upper left to lower right.
	diagonal(
		line: SheetBorderLine,
		direction: "up" | "down",
		x: number,
		y: number,
		width: number,
		height: number,
		scale: number,
		onFill = false
	): void {
		const spec = LINES[line.style]
		const lineWidth = Math.max(1, Math.round(spec.width * scale))

		this.use(line, lineWidth, spec.dash.length === 0 ? spec.dash : spec.dash.map(length => length * Math.max(1, scale)), onFill)

		const [x1, y1, x2, y2] = direction === "up" ? [x, y + height, x + width, y] : [x, y, x + width, y + height]

		if (spec.double === true) {
			this.segment(x1 - 1, y1, x2 - 1, y2)
			this.segment(x1 + 1, y1, x2 + 1, y2)
		} else {
			this.segment(x1, y1, x2, y2)
		}
	}
}
