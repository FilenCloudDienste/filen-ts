import { EMU_PER_PX } from "../drawingml/index"
import type { PdfDocumentProperties } from "../pdfwrite/index"
import type { SlideRef } from "./model"
import type { SlideRender } from "./output"

// The pages an export prints a deck on, besides one page per slide: notes pages and handouts, and what an export reads
// of a slide beyond its render (what each layer is, for a tagged PDF's structure).
//
// Notes pages (ECMA-376 Part 1 §19.3.1.26 notes, §19.3.1.27 notesMaster): one page of the deck's notes size
// (p:notesSz) per slide, the slide's notes slide drawn on it (its own shapes and its notes master's art), and the slide
// itself drawn into its slide-image placeholder (sldImg) box, fitted with its proportions kept. A slide without a notes
// slide gets its notes master's art (the master's placeholders, prompt text, left out) and the master's sldImg box; a
// deck without a notes master gets the default notes master's box (NOTES_SLIDE_BOX, PowerPoint's 7.5 x 10 in master:
// x 1143000, y 685800, 4572000 x 3429000 EMU of 6858000 x 9144000).
//
// Handouts (our own geometry: ECMA leaves the handout master's slide placement to the application): pages of the notes
// size, a 0.5 in margin, and the slides in a grid read row by row:
//   1 per page: one cell, the page inside its margins;
//   2: one column of two rows;
//   3: three rows, the slides in the left half and ruled lines for notes in the right half (one every 0.33 in, from
//      the slide's top to its bottom);
//   4: two columns of two rows; 6: two columns of three rows; 9: three columns of three rows.
// Cells are parted by 0.25 in; each slide is fitted into its cell with its proportions kept, centred, and framed by a
// 1 px line. A page holds `perPage` slides (the last page the rest): ceil(N / perPage) pages.

export const HANDOUT_LAYOUTS = [1, 2, 3, 4, 6, 9] as const

export type HandoutsPerPage = (typeof HANDOUT_LAYOUTS)[number]

// px (96 per inch).
const INCH = 96
const MARGIN = INCH / 2
const GAP = INCH / 4
const RULE_PITCH = INCH / 3

// Columns and rows per page by slides per page.
const GRIDS: { readonly [K in HandoutsPerPage]: readonly [number, number] } = {
	1: [1, 1],
	2: [1, 2],
	3: [1, 3],
	4: [2, 2],
	6: [2, 3],
	9: [3, 3]
}

// The default notes master's slide image box, as fractions of its 6858000 x 9144000 EMU page.
export const NOTES_SLIDE_BOX = { x: 1143000 / 6858000, y: 685800 / 9144000, width: 4572000 / 6858000, height: 3429000 / 9144000 } as const

export interface Box {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

export interface Size {
	readonly cx: number
	readonly cy: number
}

// What a layer of a slide is, for the structure tree of a tagged PDF: a title (H1), body text (P, or L/LI where its
// paragraphs carry markers), a footer, date, header or slide number placeholder (pagination artifacts), a picture
// (Figure with its alt text), other content (its text P, its drawing a Figure when it has alt text), or the layout's and
// master's art (artifacts).
export type ExportLayerKind = "title" | "body" | "number" | "date" | "footer" | "header" | "picture" | "content" | "art"

// A slide as an export reads it: its render, and per layer of the render what the layer is.
export interface SlideExport {
	readonly render: SlideRender
	readonly kinds: readonly ExportLayerKind[]
}

// A slide's notes page: the notes slide (or the notes master's art alone) as rendered, in notes-page px; the page's
// size; where the slide shows (absent: nowhere), drawn after the first `slideAfter` layers of the render.
export interface NotesPageExport {
	readonly page: SlideExport
	readonly width: number
	readonly height: number
	readonly slideBox?: Box
	readonly slideAfter: number
}

// The deck as an export reads it.
export interface JobDeckInfo {
	readonly slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[]
	// EMU.
	readonly size: Size
	readonly notesSize: Size
	// The deck's title (its core properties', else its file name's), and its language when it names one.
	readonly title?: string
	readonly lang?: string
	// Its core properties' author, subject and keywords, when it names any.
	readonly properties?: PdfDocumentProperties
}

export function emuToPx(emu: number): number {
	return emu / EMU_PER_PX
}

// `content` (width x height) fitted into `box` with its proportions kept, centred.
export function fitBox(width: number, height: number, box: Box): Box {
	if (!(width > 0) || !(height > 0) || !(box.width > 0) || !(box.height > 0)) return box

	const scale = Math.min(box.width / width, box.height / height)
	const w = width * scale
	const h = height * scale

	return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h }
}

// The slide image box of a notes page drawn from the default notes master.
export function defaultNotesSlideBox(page: { readonly width: number; readonly height: number }): Box {
	return {
		x: page.width * NOTES_SLIDE_BOX.x,
		y: page.height * NOTES_SLIDE_BOX.y,
		width: page.width * NOTES_SLIDE_BOX.width,
		height: page.height * NOTES_SLIDE_BOX.height
	}
}

export interface HandoutPage {
	// px.
	readonly width: number
	readonly height: number
	// One box per slide place, in reading order (the slides fitted into their cells).
	readonly slides: readonly Box[]
	// Per slide place, its ruled lines (y of each, from x to x + width): only the 3-per-page layout has any.
	readonly rules: readonly { readonly x: number; readonly width: number; readonly ys: readonly number[] }[]
}

// The geometry of a handout page with `perPage` slides of `slide` size on a page of `page` size (EMU).
export function handoutPage(perPage: HandoutsPerPage, slide: Size, page: Size): HandoutPage {
	const width = Math.max(1, emuToPx(page.cx))
	const height = Math.max(1, emuToPx(page.cy))
	const [columns, rows] = GRIDS[perPage]
	const innerWidth = Math.max(1, width - 2 * MARGIN)
	const innerHeight = Math.max(1, height - 2 * MARGIN)
	// The 3-per-page layout keeps its right half for notes.
	const slideColumnWidth = perPage === 3 ? (innerWidth - GAP) / 2 : innerWidth
	const cellWidth = Math.max(1, (slideColumnWidth - GAP * (columns - 1)) / columns)
	const cellHeight = Math.max(1, (innerHeight - GAP * (rows - 1)) / rows)
	const slideWidth = Math.max(1, emuToPx(slide.cx))
	const slideHeight = Math.max(1, emuToPx(slide.cy))
	const slides: Box[] = []
	const rules: HandoutPage["rules"][number][] = []

	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const cell = {
				x: MARGIN + column * (cellWidth + GAP),
				y: MARGIN + row * (cellHeight + GAP),
				width: cellWidth,
				height: cellHeight
			}
			const box = fitBox(slideWidth, slideHeight, cell)

			slides.push(box)

			if (perPage === 3) {
				const x = MARGIN + slideColumnWidth + GAP
				const ys: number[] = []

				for (let y = box.y + RULE_PITCH; y <= box.y + box.height + 0.01; y += RULE_PITCH) ys.push(y)

				rules.push({ x, width: Math.max(0, width - MARGIN - x), ys })
			}
		}
	}

	return { width, height, slides, rules }
}

// Pages of an export of `count` slides: one per slide, or ceil(count / perPage) handout pages.
export function pageCount(count: number, perPage: number = 1): number {
	return Math.ceil(Math.max(0, count) / Math.max(1, perPage))
}
