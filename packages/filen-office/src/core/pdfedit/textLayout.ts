import { BidiResolver } from "../text/bidi"
import { BREAK_ALLOWED, BREAK_MANDATORY, BreakFinder } from "../text/lineBreak"
import { PdfFontSet, type PdfFontAssets, type PdfFontFaceRequest, type PdfShapedText } from "../pdfwrite/fonts"
import { PdfWriter, type PdfAbortSignal } from "../pdfwrite/writer"
import type { PdfFontMatch } from "./fontMatch"

// New text for a PDF page, laid out into a one-page PDF of its own (the overlay that dom/pdfedit/overlay.ts grafts):
// shaped with the bundled fonts (GSUB/GPOS, Indic), per-script Noto fallback, bidi per line, wrapped at UAX #14
// opportunities to a width. Coordinates are the target page's display space (points, y down, origin at the top-left
// of the page as shown, after /Rotate): the overlay page has the display size, so it grafts with the identity.

export interface TextOverlayFrame {
	// The first line's baseline at the frame's start edge (left edge of the frame for left-to-right text, also for
	// right-to-left text, which is aligned to the far edge when the frame has a width).
	readonly origin: readonly [number, number]
	// Unit vector along the baseline (1, 0 for horizontal text).
	readonly direction: readonly [number, number]
	// Wrap width along the baseline; null: no wrapping, only the text's own line breaks.
	readonly width: number | null
	// Baseline to baseline.
	readonly lineHeight: number
}

export interface TextOverlayStyle {
	readonly font: PdfFontMatch
	// Points per em.
	readonly size: number
	// 0xRRGGBB.
	readonly color: number
	// BCP 47; picks the CJK fallback face and the OpenType language system.
	readonly language?: string
}

export interface TextOverlayRequest {
	// The target page's display size, points.
	readonly pageWidth: number
	readonly pageHeight: number
	readonly frame: TextOverlayFrame
	readonly style: TextOverlayStyle
	// Line feeds are hard breaks.
	readonly text: string
	readonly assets: PdfFontAssets
	readonly signal?: PdfAbortSignal
}

export interface TextOverlay {
	readonly bytes: Uint8Array
	readonly lines: number
	// The widest line, points.
	readonly width: number
	// Characters no bundled face can draw (shown as .notdef).
	readonly missing: number
}

// pdfwrite pages are in CSS px (96 per inch, y down); PDF points are 3/4 px.
const PX_PER_PT = 4 / 3
const FAUX_ITALIC = 0.21

interface Line {
	readonly start: number
	readonly end: number
	readonly level: number
}

export async function layoutTextOverlay(request: TextOverlayRequest): Promise<TextOverlay> {
	const { frame, style, text } = request
	const fonts = new PdfFontSet({
		assets: request.assets,
		deterministic: true,
		...(request.signal === undefined ? {} : { signal: request.signal })
	})

	try {
		const face: PdfFontFaceRequest = {
			family: style.font.label,
			bold: style.font.bold,
			italic: style.font.italic,
			slot: "hAnsi",
			...(style.language === undefined ? {} : { language: style.language })
		}
		const pending = fonts.prepare(text, 0, text.length, face)

		if (pending !== undefined) await pending

		const lines = breakLines(fonts, face, text, style.size, frame.width)
		const writer = await PdfWriter.create({ deterministic: true, ...(request.signal === undefined ? {} : { signal: request.signal }) })
		const page = writer.beginPage(request.pageWidth * PX_PER_PT, request.pageHeight * PX_PER_PT)
		const [dx, dy] = frame.direction
		const size = style.size * PX_PER_PT
		let widest = 0

		lines.forEach((line, index) => {
			const shaped = shapeLine(fonts, face, text, line)
			const width = (shaped.width * style.size) / 1000

			widest = Math.max(widest, width)

			if (shaped.runs.length === 0) return

			// Right-to-left paragraphs align to the frame's far edge when there is one.
			const along = frame.width !== null && (line.level & 1) === 1 ? Math.max(0, frame.width - width) : 0
			const across = index * frame.lineHeight
			const x = frame.origin[0] + along * dx - across * dy
			const y = frame.origin[1] + along * dy + across * dx
			const first = shaped.runs[0]
			const shear = first?.fauxItalic === true ? FAUX_ITALIC : 0

			page.text(shaped.runs, {
				x: x * PX_PER_PT,
				y: y * PX_PER_PT,
				size,
				color: ((style.color & 0xffffff) * 256 + 255) >>> 0,
				text: text.slice(line.start, line.end),
				...(dx !== 1 || shear !== 0 ? { transform: [dx, dy, -shear * dx - dy, dx - shear * dy] as const } : {}),
				...(first?.fauxBold === true ? { render: "fillStroke" as const, strokeWidth: size / 30 } : {})
			})
		})

		await writer.endPage(page)

		const output = await writer.finish()
		const bytes = new Uint8Array(output.size)
		let at = 0

		for (const part of output.parts) {
			if (!(part instanceof Uint8Array)) throw new Error("The text overlay has a part that is not bytes")

			bytes.set(part, at)
			at += part.length
		}

		let missing = 0

		for (const count of fonts.missing().values()) missing += count

		return { bytes, lines: lines.length, width: widest, missing }
	} finally {
		fonts.close()
	}
}

function shapeLine(fonts: PdfFontSet, face: PdfFontFaceRequest, text: string, line: Line): PdfShapedText {
	return fonts.shape(text, line.start, line.end, face, { level: line.level, flags: 0, bidi: true })
}

// Hard breaks at line feeds; within a paragraph, greedy filling at UAX #14 opportunities, trailing spaces hanging.
// A piece wider than the frame gets a line of its own.
function breakLines(fonts: PdfFontSet, face: PdfFontFaceRequest, text: string, size: number, width: number | null): Line[] {
	const lines: Line[] = []
	const finder = new BreakFinder()
	const bidi = new BidiResolver()
	let paragraphStart = 0

	while (paragraphStart <= text.length) {
		const newline = text.indexOf("\n", paragraphStart)
		const paragraphEnd = newline === -1 ? text.length : newline
		const end = paragraphEnd > paragraphStart && text.charCodeAt(paragraphEnd - 1) === 0x0d ? paragraphEnd - 1 : paragraphEnd
		const count = end - paragraphStart
		const level = count === 0 ? 0 : bidi.resolve(text, paragraphStart, end, "auto", new Uint8Array(count))

		if (width === null || count === 0) {
			lines.push({ start: paragraphStart, end, level })
		} else {
			const breaks = new Uint8Array(count + 1)

			finder.find(text, paragraphStart, end, breaks)

			let lineStart = paragraphStart
			let pieceStart = paragraphStart
			let lineWidth = 0

			for (let k = 1; k <= count; k++) {
				const kind = breaks[k] ?? 0

				if (kind !== BREAK_ALLOWED && kind !== BREAK_MANDATORY) continue

				const pieceEnd = paragraphStart + k
				const visibleEnd = trimEnd(text, pieceStart, pieceEnd)
				const pieceWidth = measure(fonts, face, text, pieceStart, pieceEnd, level, size)
				const visibleWidth = visibleEnd === pieceEnd ? pieceWidth : measure(fonts, face, text, pieceStart, visibleEnd, level, size)

				if (lineWidth + visibleWidth > width && lineStart < pieceStart) {
					lines.push({ start: lineStart, end: trimEnd(text, lineStart, pieceStart), level })
					lineStart = pieceStart
					lineWidth = 0
				}

				lineWidth += pieceWidth
				pieceStart = pieceEnd
			}

			lines.push({ start: lineStart, end: trimEnd(text, lineStart, end), level })
		}

		if (newline === -1) break

		paragraphStart = newline + 1
	}

	return lines
}

function measure(
	fonts: PdfFontSet,
	face: PdfFontFaceRequest,
	text: string,
	start: number,
	end: number,
	level: number,
	size: number
): number {
	return end <= start ? 0 : (fonts.shape(text, start, end, face, { level, flags: 0, bidi: true }).width * size) / 1000
}

function trimEnd(text: string, start: number, end: number): number {
	let at = end

	while (at > start && /\s/u.test(text.charAt(at - 1))) at--

	return at
}
