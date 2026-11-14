// Where things sit in the redaction fixtures (src/scripts/pdfRedactFixtures.ts writes them; the tests read these).
// PDF coordinates (y up) on a 612 × 792 page; `page` converts a rectangle to MuPDF page space (y down).

export const PAGE_WIDTH = 612
export const PAGE_HEIGHT = 792

export type PdfBox = readonly [number, number, number, number]

// [x0, y0, x1, y1] in PDF space to MuPDF page space.
export function page(box: PdfBox): readonly [number, number, number, number] {
	return [box[0], PAGE_HEIGHT - box[3], box[2], PAGE_HEIGHT - box[1]]
}

// The term every fixture hides somewhere.
export const SECRET = "Secret"

export const SPEC = {
	// text.pdf: text lines (Helvetica), an email and a phone number, a line and a filled shape.
	text: {
		line1: { x: 72, y: 700, size: 18, text: "Agent name: Secret Person" },
		line2: { x: 72, y: 660, size: 12, text: "Contact bob@example.com or +1 (555) 010-7788 today" },
		page2: { x: 72, y: 700, size: 18, text: "Secret again on page two" },
		// A horizontal line across the page and a filled triangle.
		line: { from: [72, 500], to: [540, 500], width: 4 },
		triangle: [
			[300, 300],
			[400, 300],
			[350, 400]
		],
		// An area over the middle of the line, and one over the triangle's apex only.
		lineArea: [250, 480, 330, 520] as PdfBox,
		apexArea: [330, 360, 370, 420] as PdfBox
	},
	// form.pdf: a Form XObject with text drawn on both pages at (100, 600), size 20.
	form: { at: [100, 600], text: "Secret Formula", size: 20, area: [90, 590, 300, 630] as PdfBox },
	// invisible.pdf: render mode 3 text over a grey box.
	invisible: { text: "Secret Invisible", x: 72, y: 600, size: 16, area: [60, 590, 260, 625] as PdfBox },
	// ocr.pdf: a 200 × 100 grey scan at (72, 500) 400 × 200 pt, with invisible OCR text over it.
	ocr: {
		image: [72, 500, 472, 700] as PdfBox,
		text: "Secret scanned words",
		x: 80,
		y: 600,
		size: 24,
		area: [70, 590, 250, 630] as PdfBox
	},
	// clipped.pdf: text clipped by a rectangle, and clipping text (mode 7) filled through.
	clipped: {
		clipped: { text: "Secret Clipped", x: 72, y: 600, size: 24 },
		clipRect: [72, 590, 140, 630] as PdfBox,
		clipping: { text: "Secret Clip", x: 72, y: 400, size: 30 },
		area: [60, 380, 400, 640] as PdfBox
	},
	// layer.pdf: text in a layer that is off, and text in a membership that is hidden while every layer is on.
	layer: {
		off: { text: "Secret Layer", x: 72, y: 600, size: 18 },
		membership: { text: "Secret Membership", x: 72, y: 500, size: 18 },
		visible: { text: "Shown layer", x: 72, y: 400, size: 18 }
	},
	// tagged.pdf: marked content with MCIDs, ActualText in the stream and in struct elements.
	tagged: {
		first: { text: "Hidden words", actual: "Secret Actual", x: 72, y: 600, size: 18 },
		second: { text: "Kept words", x: 72, y: 500, size: 18 },
		area: [60, 590, 300, 625] as PdfBox
	},
	// annotations.pdf: a note, a free text, a link and a text field over `area`; a note elsewhere.
	annotations: {
		area: [60, 560, 400, 720] as PdfBox,
		note: [80, 680, 100, 700] as PdfBox,
		freeText: [120, 650, 380, 700] as PdfBox,
		link: [80, 600, 300, 620] as PdfBox,
		field: [80, 570, 300, 595] as PdfBox,
		elsewhereNote: [500, 100, 520, 120] as PdfBox,
		text: { text: "Body text Secret", x: 72, y: 300, size: 14 }
	},
	// metadata.pdf: the term in every non-content place.
	metadata: { text: { text: "Plain page", x: 72, y: 700, size: 18 } },
	// images.pdf: an RGB image with a soft mask, a stencil mask, a CMYK image and an inline image.
	images: {
		rgb: [72, 500, 272, 700] as PdfBox,
		stencil: [320, 500, 520, 700] as PdfBox,
		cmyk: [72, 200, 272, 400] as PdfBox,
		inline: [320, 200, 520, 400] as PdfBox,
		// Over part of each image.
		areas: [
			[100, 550, 180, 650],
			[350, 550, 430, 650],
			[100, 250, 180, 350],
			[350, 250, 430, 350]
		] as PdfBox[]
	},
	// vector.pdf: a tiling pattern with text in its cell, an axial shading painted with sh, a shading pattern fill.
	vector: {
		tiled: [72, 500, 300, 700] as PdfBox,
		shading: [330, 500, 540, 700] as PdfBox,
		shadingFill: [72, 200, 300, 400] as PdfBox,
		areas: [
			[100, 550, 150, 600],
			[400, 550, 450, 600],
			[100, 250, 150, 300]
		] as PdfBox[]
	},
	// revision.pdf: the first revision shows the term; an incremental update replaces the page's content.
	revision: { original: "Secret Original", replacement: "Clean revision" }
} as const
