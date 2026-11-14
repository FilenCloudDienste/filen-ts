import type { PdfMarkupKind, PdfPoint, PdfQuad, PdfRect } from "../../../core/pdfedit/annotations"
import type { ToolPointer, ToolStep } from "./types"

// The text markup tool (highlight, underline, strikeout, squiggly): a drag over text, its quads from the host's text
// geometry while it goes, committed as one markup when the pointer lifts over some text. The geometry is whatever
// text the host already holds for the page (the engine's structured text, or the viewer's text layer); quadsFromLines
// computes it from line and character boxes, synchronously, on every move.

// The text of a page as the tool needs it.
export interface PdfTextGeometry {
	// The quads of the text between two points of `page` in reading order (one per line run), empty off text.
	quads(page: number, from: PdfPoint, to: PdfPoint): readonly PdfQuad[]
}

// One line of text: its box and the x positions of its characters' edges (n characters, n + 1 edges, ascending).
export interface PdfTextLine {
	readonly rect: PdfRect
	readonly edges: readonly number[]
}

export interface MarkupDrag {
	readonly page: number
	readonly anchor: PdfPoint
	readonly quads: readonly PdfQuad[]
}

export interface MarkupState {
	readonly kind: PdfMarkupKind
	readonly drag: MarkupDrag | null
}

export interface MarkupCommit {
	readonly kind: PdfMarkupKind
	readonly page: number
	readonly quads: readonly PdfQuad[]
}

export function markupTool(kind: PdfMarkupKind): MarkupState {
	return { kind, drag: null }
}

export function markupPointer(state: MarkupState, event: ToolPointer, geometry: PdfTextGeometry): ToolStep<MarkupState, MarkupCommit> {
	const drag = state.drag

	switch (event.type) {
		case "down":
			return { state: { ...state, drag: { page: event.page, anchor: event.point, quads: [] } } }
		case "move":
			return drag === null || drag.page !== event.page
				? { state }
				: { state: { ...state, drag: { ...drag, quads: geometry.quads(drag.page, drag.anchor, event.point) } } }
		case "up": {
			if (drag === null) return { state }

			const quads = event.page === drag.page ? geometry.quads(drag.page, drag.anchor, event.point) : drag.quads

			return {
				state: { ...state, drag: null },
				...(quads.length === 0 ? {} : { commit: { kind: state.kind, page: drag.page, quads } })
			}
		}
		case "cancel":
			return { state: { ...state, drag: null } }
	}
}

// The line under `point`: the one whose box holds it, else the vertically nearest; and the character edge nearest
// to its x.
function locate(lines: readonly PdfTextLine[], point: PdfPoint): { line: number; edge: number } | null {
	let best = -1
	let bestGap = Infinity

	for (let index = 0; index < lines.length; index++) {
		const rect = lines[index]?.rect

		if (rect === undefined) continue

		const gap = point[1] < rect[1] ? rect[1] - point[1] : point[1] > rect[3] ? point[1] - rect[3] : 0
		const horizontal = point[0] < rect[0] ? rect[0] - point[0] : point[0] > rect[2] ? point[0] - rect[2] : 0
		const score = gap * 1000 + horizontal

		if (score < bestGap) {
			bestGap = score
			best = index
		}
	}

	const line = lines[best]

	if (line === undefined) return null

	let edge = 0
	let nearest = Infinity

	for (let index = 0; index < line.edges.length; index++) {
		const gap = Math.abs((line.edges[index] ?? 0) - point[0])

		if (gap < nearest) {
			nearest = gap
			edge = index
		}
	}

	return { line: best, edge }
}

function quadOf(rect: PdfRect, x0: number, x1: number): PdfQuad {
	return [x0, rect[1], x1, rect[1], x0, rect[3], x1, rect[3]]
}

// The quads between two points over `lines` (in reading order): from the anchor's character edge to the end of its
// line, every line between whole, and the focus's line up to its edge; empty when they meet at one edge.
export function quadsFromLines(lines: readonly PdfTextLine[], from: PdfPoint, to: PdfPoint): PdfQuad[] {
	const a = locate(lines, from)
	const b = locate(lines, to)

	if (a === null || b === null) return []

	const [start, end] = a.line < b.line || (a.line === b.line && a.edge <= b.edge) ? [a, b] : [b, a]
	const out: PdfQuad[] = []

	for (let index = start.line; index <= end.line; index++) {
		const line = lines[index]

		if (line === undefined || line.edges.length < 2) continue

		const first = index === start.line ? start.edge : 0
		const last = index === end.line ? end.edge : line.edges.length - 1

		if (last > first) out.push(quadOf(line.rect, line.edges[first] ?? line.rect[0], line.edges[last] ?? line.rect[2]))
	}

	return out
}
