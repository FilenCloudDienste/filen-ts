import { paintDrawingPdf, pictureKey, pictureSource, type PdfDrawingData } from "../../core/drawingml/pdf"
import {
	ITEM_FLOATS,
	ITEM_INTS,
	ItemFloat,
	ItemInt,
	ItemKind,
	MISSING_IMAGE,
	imageFormat,
	imageHandling,
	type DrawingData,
	type DrawingImage
} from "../../core/drawingml/index"
import { DocxPagePainter, type DocxPdfRefusal, type PagePaintContext } from "../../core/docx/pdf/paint"
import type { DocxPdfDocument, DocxPdfLinkTarget, DocxPdfRole, DocxPdfStyle } from "../../core/docx/pdf/types"
import type { DocxLinkTarget, DocxTextStyle } from "../../core/docx/layout/index"
import { NO_HINTS, SUBSTITUTIONS, fallbackFor, type BundledFamily } from "../../core/fonts/substitutes"
import { readSfnt } from "../../core/fonts/sfnt"
import type { PdfFaceSource } from "../../core/fonts/manager"
import type { PdfSecurityKey } from "../../core/pdfwrite/crypto"
import { PdfFontSet, type PdfFontAssets, type PdfFontFaceRequest } from "../../core/pdfwrite/fonts/index"
import {
	PdfWriteError,
	PdfWriter,
	type Matrix,
	type PdfAbortSignal,
	type PdfDecodedImage,
	type PdfDeflate,
	type PdfDocumentProperties,
	type PdfImage,
	type PdfImageDecoder,
	type PdfOutput,
	type PdfPage,
	type RandomBytes
} from "../../core/pdfwrite/index"
import type { Action, SlideRef } from "../../core/presentation/model"
import type { SlideLayer, TextPage } from "../../core/presentation/output"
import {
	fitBox,
	type Box,
	type ExportLayerKind,
	type HandoutPage,
	type NotesPageExport,
	type SlideExport
} from "../../core/presentation/pages"
import { PICTURE_BULLET_OBJECT, toDocxPdfPage } from "../../core/presentation/text/page"
import type { Slicing } from "../../core/slicing"
import type { DocxFontFace } from "../docx/protocol"

// A deck as a tagged PDF (PDF 1.7, ISO 14289-1 PDF/UA-1): slides one per page, notes pages, or handouts, each page
// written as it is painted. A slide is its background, then each layer: its drawing by paintDrawingPdf under the
// layer's matrix, its text by the docx engine's DocxPagePainter wrapped in q … cm … Q under the text matrix (the
// painter draws in the text page's own px), its picture bullets over their places. The fonts are the faces the
// session's text was laid out in (bundled families embedded subset; installed fonts drawn by their bundled substitute).
//
// Structure: a Sect per slide; its title H1, its text P (L/LI/LBody for paragraphs the layout gave a marker), tables
// as Table/TR/TH/TD, pictures (and other drawings with alt text) Figure with that text; layout and master art,
// backgrounds, the drawings of text shapes and the slide number, date, footer and header placeholders are artifacts.
// Links: http, https and mailto URLs, and jumps to slides of the export (a slide, first, last, next, previous); any
// other action is written as nothing (§ link policy).

export interface PresentationPdfOptions {
	readonly assets: PdfFontAssets
	readonly title: string
	// The deck's core properties' author, subject and keywords.
	readonly properties?: PdfDocumentProperties
	// BCP 47 (a tagged PDF must give one).
	readonly lang: string
	// AES-256 under the source's password, made where the password is (the presentation worker).
	readonly securityKey?: PdfSecurityKey
	readonly deterministic?: boolean
	readonly signal?: PdfAbortSignal
	readonly slicing?: Slicing
	readonly deflate?: PdfDeflate | null
	readonly decoder?: PdfImageDecoder
	readonly random?: RandomBytes
}

export interface PresentationPdfSources {
	// The faces the session's text was laid out in ("fonts" events' faces).
	readonly faces: readonly DocxFontFace[]
	// A picture part's bytes; null when the package has none.
	image(part: string): Promise<{ readonly bytes: Uint8Array; readonly type: string } | null>
	// An SVG picture's part drawn as straight RGBA, at most `maxSide` px on its longer side (the PDF has no SVG of its
	// own); undefined where it cannot be drawn. Without it, an SVG without a raster fallback is left out.
	svg?(part: string, maxSide: number): Promise<PdfDecodedImage | undefined>
}

// Drawn approximately or left out, by kind: the docx painter's, and pictures the PDF cannot carry (SVG without a
// raster fallback, metafiles not converted).
export type PresentationPdfRefusal = DocxPdfRefusal | "picture"

export interface PresentationPdfReport {
	// Characters drawn as .notdef because no face has them, by ISO 15924 script.
	readonly missing: ReadonlyMap<string, number>
	readonly refused: ReadonlyMap<PresentationPdfRefusal, number>
}

export interface PresentationPdfResult extends PdfOutput {
	readonly report: PresentationPdfReport
}

// Requests for the text's faces name them by index under this prefix (no document family starts with it).
const FACE_PREFIX = "\u0001face:"
// OS/2 fsType's restricted-license bit: what an unreadable face is taken to have.
const RESTRICTED_LICENSE = 0x0002
const DRAWING_FAMILY = "Calibri"
const BLACK = 0x000000ff
const FRAME = 0x808080ff
const HEX = /^[0-9A-Fa-f]{6}$/u
// cssFont (core/fonts/manager.ts): [italic ]weight sizepx ["alias", ]generic.
const CSS_FONT = /^(italic )?(\d+) ([\d.]+)px (?:"([^"]*)", )?([a-z-]+)$/u
const BUNDLED: readonly BundledFamily[] = ["carlito", "caladea", "arimo", "tinos", "cousine", "gelasio", "selawik"]
const ALLOWED_SCHEMES = /^(?:https?:|mailto:)/iu
// An SVG picture is drawn at 2 pixels per px of the page it lands on (192 dpi at 100 %, as the image export's
// pictures), its side rounded up to a step so near sizes share one raster, and at most the page rasteriser's side.
const SVG_PIXELS_PER_PX = 2
const SVG_SIDE_STEP = 128
const MAX_SVG_SIDE = 4096

const PARAGRAPH: DocxPdfRole = { kind: "paragraph", level: 0, list: -1, cells: [] }
const HEADING: DocxPdfRole = { kind: "heading", level: 1, list: -1, cells: [] }
const FOOTER: DocxPdfRole = { kind: "artifact", level: 0, list: -1, cells: [], artifact: "Footer" }
const HEADER: DocxPdfRole = { kind: "artifact", level: 0, list: -1, cells: [], artifact: "Header" }
const ART: DocxPdfRole = { kind: "artifact", level: 0, list: -1, cells: [] }

function times(m1: readonly number[], m2: readonly number[]): Matrix {
	const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = m1
	const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = m2

	return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1]
}

// How much `matrix` enlarges a length (its larger axis scale).
function scaleOf(matrix: Matrix): number {
	return Math.max(Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3]))
}

// The page box (px) of `box` under `matrix`.
function mapBox(matrix: readonly number[], x: number, y: number, width: number, height: number): [number, number, number, number] {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix
	const xs = [x, x + width, x, x + width]
	const ys = [y, y, y + height, y + height]
	let minX = Number.POSITIVE_INFINITY
	let minY = Number.POSITIVE_INFINITY
	let maxX = Number.NEGATIVE_INFINITY
	let maxY = Number.NEGATIVE_INFINITY

	for (let k = 0; k < 4; k++) {
		const px = a * (xs[k] ?? 0) + c * (ys[k] ?? 0) + e
		const py = b * (xs[k] ?? 0) + d * (ys[k] ?? 0) + f

		minX = Math.min(minX, px)
		minY = Math.min(minY, py)
		maxX = Math.max(maxX, px)
		maxY = Math.max(maxY, py)
	}

	return [minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY)]
}

function bundledFamily(alias: string): BundledFamily | undefined {
	return BUNDLED.find(family => alias === family || alias.endsWith(`-${family}`))
}

function genericFamily(generic: string): BundledFamily {
	return generic === "monospace" ? "cousine" : generic === "serif" ? "tinos" : "arimo"
}

function substituteOf(name: string, generic: string): BundledFamily {
	return SUBSTITUTIONS.get(name.toLowerCase())?.family ?? fallbackFor(name, NO_HINTS, true).family ?? genericFamily(generic)
}

// Families without a face of the session's own (a chart's or WordArt's text): the bundled substitute.
function drawingSource(request: PdfFontFaceRequest): PdfFaceSource {
	const substitution = SUBSTITUTIONS.get(request.family.toLowerCase())
	const family = substitution?.family ?? fallbackFor(request.family, NO_HINTS, true).family ?? "arimo"

	return { kind: "bundled", family, weight: request.bold ? 700 : (substitution?.weight ?? 400), italic: request.italic }
}

interface FaceChoice {
	readonly source: PdfFaceSource
	// Drawn by a substitute fitted to what the layout measured with another face (an installed font).
	readonly fitted: boolean
}

// What one TextPage needs painted: its page, styles and font requests as the docx painter reads them.
interface PreparedText {
	readonly doc: DocxPdfDocument
	readonly requests: readonly PdfFontFaceRequest[]
}

function abortError(signal: PdfAbortSignal): unknown {
	return signal.reason ?? Object.assign(new Error("The PDF export was aborted"), { name: "AbortError" })
}

// Where links lead: the slides of the export (by ref, in order).
interface SlideTargets {
	readonly order: readonly SlideRef[]
	readonly index: ReadonlyMap<SlideRef, number>
}

export class PresentationPdf {
	private readonly writer: PdfWriter
	private readonly fonts: PdfFontSet
	private readonly sources: PresentationPdfSources
	private readonly options: PresentationPdfOptions
	private readonly faceSources: PdfFaceSource[] = []
	private readonly faceKeys = new Map<string, number>()
	private readonly choices = new Map<string, FaceChoice>()
	private readonly images = new Map<string, Promise<PdfImage | undefined>>()
	// SVG pictures by part: the largest raster made so far (its side in pixels) and its image.
	private readonly svgs = new Map<string, { readonly side: number; readonly image: Promise<PdfImage | undefined> }>()
	// The page px the drawing being painted puts each SVG part at, on its longer side.
	private readonly svgNeeds = new Map<string, number>()
	private readonly refused = new Map<PresentationPdfRefusal, number>()
	private readonly seen = new Set<string>()
	private targets: SlideTargets = { order: [], index: new Map() }
	private texts = 0
	private closed = false

	private constructor(writer: PdfWriter, fonts: PdfFontSet, sources: PresentationPdfSources, options: PresentationPdfOptions) {
		this.writer = writer
		this.fonts = fonts
		this.sources = sources
		this.options = options
	}

	static async create(options: PresentationPdfOptions, sources: PresentationPdfSources): Promise<PresentationPdf> {
		const holder: { pdf?: PresentationPdf } = {}
		const fonts = new PdfFontSet({
			assets: options.assets,
			resolve: request => {
				if (request.family.startsWith(FACE_PREFIX)) {
					const source = holder.pdf?.faceSources[Number(request.family.slice(FACE_PREFIX.length))]

					if (source !== undefined) return source
				}

				return drawingSource(request)
			},
			deterministic: options.deterministic === true,
			...(options.signal === undefined ? {} : { signal: options.signal })
		})

		try {
			const writer = await PdfWriter.create({
				tagged: true,
				deterministic: options.deterministic === true,
				title: options.title,
				...(options.properties === undefined ? {} : { properties: options.properties }),
				lang: options.lang,
				...(options.securityKey === undefined ? {} : { securityKey: options.securityKey }),
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.slicing === undefined ? {} : { slicing: options.slicing }),
				...(options.deflate === undefined ? {} : { deflate: options.deflate }),
				...(options.decoder === undefined ? {} : { decoder: options.decoder }),
				...(options.random === undefined ? {} : { random: options.random })
			})

			holder.pdf = new PresentationPdf(writer, fonts, sources, options)

			return holder.pdf
		} catch (error) {
			fonts.close()

			throw error
		}
	}

	// The slides of the export in order, and where each is (its page, its top in px there): link targets.
	declareSlides(order: readonly SlideRef[], place: (index: number) => { readonly page: number; readonly y: number }): void {
		this.targets = { order, index: new Map(order.map((ref, index) => [ref, index])) }

		order.forEach((ref, index) => {
			const at = place(index)

			this.writer.destination(`slide:${String(ref)}`, { page: at.page, y: at.y })
		})
	}

	// One slide on a page of its own size.
	async slidePage(slide: SlideExport): Promise<void> {
		const { width, height } = slide.render.background
		const page = this.writer.beginPage(Math.max(1, width), Math.max(1, height))

		await this.paintSlide(page, slide, [1, 0, 0, 1, 0, 0], undefined)
		await this.endPage(page)
	}

	// A notes page: the notes slide (or its master's art), the slide in its box.
	async notesPage(notes: NotesPageExport, slide: SlideExport): Promise<void> {
		const page = this.writer.beginPage(Math.max(1, notes.width), Math.max(1, notes.height))
		const render = notes.page.render
		const background = render.background

		page.beginArtifact({ type: "Background" })
		await this.drawing(page, background, [
			background.width > 0 ? notes.width / background.width : 1,
			0,
			0,
			background.height > 0 ? notes.height / background.height : 1,
			0,
			0
		])
		page.endArtifact()

		const section = this.writer.open("Sect")
		const box = notes.slideBox
		const paintSlide = async (): Promise<void> => {
			if (box === undefined) return

			const fitted = fitBox(slide.render.background.width, slide.render.background.height, box)
			const scale = slide.render.background.width > 0 ? fitted.width / slide.render.background.width : 1

			await this.paintSlide(page, slide, [scale, 0, 0, scale, fitted.x, fitted.y], fitted)
		}
		let painted = false

		for (let k = 0; k < render.layers.length; k++) {
			if (k === notes.slideAfter) {
				await paintSlide()
				painted = true
			}

			const layer = render.layers[k]

			if (layer !== undefined) await this.layer(page, layer, notes.page.kinds[k] ?? "art", [1, 0, 0, 1, 0, 0], notes.page)
		}

		if (!painted) await paintSlide()

		this.writer.close(section)
		await this.endPage(page)
	}

	// A handout page: its slides in their boxes, framed, and the ruled lines of the 3-per-page layout.
	async handoutPage(geometry: HandoutPage, slides: readonly SlideExport[]): Promise<void> {
		const page = this.writer.beginPage(geometry.width, geometry.height)

		for (let k = 0; k < slides.length; k++) {
			const slide = slides[k]
			const box = geometry.slides[k]

			if (slide === undefined || box === undefined) continue

			const scale = slide.render.background.width > 0 ? box.width / slide.render.background.width : 1

			await this.paintSlide(page, slide, [scale, 0, 0, scale, box.x, box.y], box)
			page.beginArtifact({ type: "Layout" })
			page.saveState()
			page.strokeColor(FRAME).lineWidth(1).rect(box.x, box.y, box.width, box.height).stroke()

			const rules = geometry.rules[k]

			if (rules !== undefined) {
				for (const y of rules.ys)
					page.moveTo(rules.x, y)
						.lineTo(rules.x + rules.width, y)
						.stroke()
			}

			page.restoreState()
			page.endArtifact()
		}

		await this.endPage(page)
	}

	async finish(): Promise<PresentationPdfResult> {
		const output = await this.writer.finish()
		const unshaped = this.fonts.unshaped()

		if (unshaped > 0) this.refuse("shaping", unshaped)

		return { ...output, report: { missing: new Map(this.fonts.missing()), refused: new Map(this.refused) } }
	}

	close(): void {
		if (this.closed) return

		this.closed = true
		this.fonts.close()
		this.images.clear()
		this.svgs.clear()
	}

	private refuse(kind: PresentationPdfRefusal, count = 1): void {
		this.refused.set(kind, (this.refused.get(kind) ?? 0) + count)
	}

	private checkAbort(): void {
		const signal = this.options.signal

		if (signal?.aborted === true) throw abortError(signal)
	}

	private async endPage(page: PdfPage): Promise<void> {
		await this.writer.endPage(page)
		this.checkAbort()
	}

	// A slide under `placement` (slide px → page px), clipped to `clip` (page px) when given.
	private async paintSlide(page: PdfPage, slide: SlideExport, placement: Matrix, clip: Box | undefined): Promise<void> {
		const render = slide.render
		const section = this.writer.open("Sect")

		if (clip !== undefined) {
			page.saveState()
			page.rect(clip.x, clip.y, clip.width, clip.height).clip().endPath()
		}

		page.beginArtifact({ type: "Background" })
		await this.drawing(page, render.background, placement)
		page.endArtifact()

		const tables = new Map<string, SlideLayer[]>()

		for (const layer of render.layers) {
			if (layer.cell === undefined) continue

			const key = `${String(layer.shape.slide)}:${String(layer.shape.id)}`
			const list = tables.get(key)

			if (list === undefined) tables.set(key, [layer])
			else list.push(layer)
		}

		for (let k = 0; k < render.layers.length; k++) {
			const layer = render.layers[k]

			if (layer === undefined || layer.cell !== undefined) continue

			if (layer.table !== undefined) {
				await this.table(page, layer, tables.get(`${String(layer.shape.slide)}:${String(layer.shape.id)}`) ?? [], placement)
				continue
			}

			await this.layer(page, layer, slide.kinds[k] ?? "content", placement, slide)
			await this.writer.yieldIfDue()
		}

		if (clip !== undefined) page.restoreState()

		this.writer.close(section)
	}

	private async layer(page: PdfPage, layer: SlideLayer, kind: ExportLayerKind, placement: Matrix, slide: SlideExport): Promise<void> {
		const matrix = times(placement, layer.matrix)
		const text = layer.text
		const alt = layer.alt?.trim() ?? ""
		const figure = kind !== "art" && (kind === "picture" || text === undefined) && alt.length > 0

		if (figure) {
			const node = this.writer.open("Figure", { alt, bbox: mapBox(matrix, 0, 0, layer.drawing.width, layer.drawing.height) })

			page.beginContent(node)
			await this.drawing(page, layer.drawing, matrix)
			page.endContent()
			this.writer.close(node)
		} else {
			page.beginArtifact({ type: kind === "art" ? "Background" : "Layout" })
			await this.drawing(page, layer.drawing, matrix)
			page.endArtifact()
		}

		if (text !== undefined && text.page.lineCount > 0)
			await this.text(page, text, times(placement, layer.textMatrix ?? layer.matrix), this.rolesOf(text, kind), slide.render.ref)

		this.action(page, layer, matrix, slide.render.ref)
	}

	// The structure role of each paragraph of a text page.
	private rolesOf(text: TextPage, kind: ExportLayerKind): DocxPdfRole[] {
		const roles: DocxPdfRole[] = []
		const markers = (text as TextPage & { readonly markers?: Int32Array }).markers
		const list = this.texts

		for (let source = 0; source < text.page.sourceCount; source++) {
			switch (kind) {
				case "title":
					roles.push(HEADING)
					break
				case "number":
				case "date":
				case "footer":
					roles.push(FOOTER)
					break
				case "header":
					roles.push(HEADER)
					break
				case "art":
					roles.push(ART)
					break
				default:
					roles.push((markers?.[source] ?? 0) > 0 ? { kind: "listItem", level: 0, list, cells: [] } : PARAGRAPH)
			}
		}

		return roles
	}

	// A table frame: its fills and borders (the base layer's drawing) as artifacts, then a Table element, a row per
	// row and a cell per merged area (TH in a header row), each cell's text inside.
	private async table(page: PdfPage, base: SlideLayer, cells: readonly SlideLayer[], placement: Matrix): Promise<void> {
		const matrix = times(placement, base.matrix)
		const structure = base.table

		page.beginArtifact({ type: "Layout" })
		await this.drawing(page, base.drawing, matrix)
		page.endArtifact()

		if (structure === undefined) return

		const byCell = new Map<string, SlideLayer>()

		for (const cell of cells) if (cell.cell !== undefined) byCell.set(`${String(cell.cell[0])}:${String(cell.cell[1])}`, cell)

		const tableNode = this.writer.open("Table", { bbox: mapBox(matrix, 0, 0, base.drawing.width, base.drawing.height) })
		let rowNode: number | undefined
		let row = -1
		const header = structure.flags.firstRow === true

		for (let k = 0; k + 3 < structure.areas.length; k += 4) {
			const r = structure.areas[k] ?? 0
			const c = structure.areas[k + 1] ?? 0
			const rows = structure.areas[k + 2] ?? 1
			const cols = structure.areas[k + 3] ?? 1

			if (r !== row) {
				if (rowNode !== undefined) this.writer.close(rowNode)

				rowNode = this.writer.open("TR")
				row = r
			}

			const isHeader = header && r === 0
			const cellNode = this.writer.open(isHeader ? "TH" : "TD", {
				...(isHeader ? { scope: "Column" as const } : {}),
				...(rows > 1 ? { rowSpan: rows } : {}),
				...(cols > 1 ? { colSpan: cols } : {})
			})
			const layer = byCell.get(`${String(r)}:${String(c)}`)

			if (layer !== undefined) {
				const cellMatrix = times(placement, layer.matrix)

				page.beginArtifact({ type: "Layout" })
				await this.drawing(page, layer.drawing, cellMatrix)
				page.endArtifact()

				if (layer.text !== undefined && layer.text.page.lineCount > 0)
					await this.text(
						page,
						layer.text,
						times(placement, layer.textMatrix ?? layer.matrix),
						this.rolesOf(layer.text, "body"),
						undefined
					)
			}

			this.writer.close(cellNode)
		}

		if (rowNode !== undefined) this.writer.close(rowNode)

		this.writer.close(tableNode)
	}

	// A shape's click action as a link over its box: a URL of an allowed scheme, or a jump to a slide of the export.
	// Its description: the shape's alt text, else its text, else the URL or the slide's number.
	private action(page: PdfPage, layer: SlideLayer, matrix: Matrix, from: SlideRef): void {
		const click = layer.actions?.click

		if (click === undefined || layer.cell !== undefined) return

		const target = this.actionTarget(click, from)

		if (target === undefined) return

		const box = mapBox(matrix, 0, 0, layer.drawing.width, layer.drawing.height)

		if (!(box[2] > 0 && box[3] > 0)) return

		const own = (layer.alt ?? layer.text?.page.sourceTexts.join(" ") ?? "").trim()
		const contents =
			own.length > 0
				? own
				: target.kind === "external"
					? target.href
					: String((this.targets.index.get(Number(target.anchor.slice(6)) as SlideRef) ?? 0) + 1)

		page.link(box, target.kind === "external" ? { uri: target.href } : { dest: target.anchor }, { contents })
	}

	private actionTarget(action: Action, from: SlideRef): DocxPdfLinkTarget | undefined {
		switch (action.kind) {
			case "url":
				return ALLOWED_SCHEMES.test(action.href) ? { kind: "external", href: action.href } : undefined
			case "slide":
				return this.targets.index.has(action.slide) ? { kind: "internal", anchor: `slide:${String(action.slide)}` } : undefined
			case "internal": {
				const ref = this.jump(action.jump, from)

				return ref === undefined ? undefined : { kind: "internal", anchor: `slide:${String(ref)}` }
			}
			default:
				return undefined
		}
	}

	private jump(jump: Extract<Action, { kind: "internal" }>["jump"], from: SlideRef): SlideRef | undefined {
		const order = this.targets.order
		const at = this.targets.index.get(from)

		switch (jump) {
			case "first":
				return order[0]
			case "last":
				return order[order.length - 1]
			case "next":
				return at === undefined ? undefined : order[at + 1]
			case "previous":
				return at === undefined ? undefined : order[at - 1]
			default:
				return undefined
		}
	}

	// A text page's link table as the painter writes it: allowed URLs, jumps to slides of the export; any other link
	// an empty anchor (the painter writes none).
	private links(links: readonly DocxLinkTarget[], from: SlideRef | undefined): DocxPdfLinkTarget[] {
		return links.map((link): DocxPdfLinkTarget => {
			if (link.kind === "external")
				return ALLOWED_SCHEMES.test(link.href) ? { kind: "external", href: link.href } : { kind: "internal", anchor: "" }

			const anchor = link.anchor

			if (anchor.startsWith("slide:")) {
				const ref = Number(anchor.slice(6)) as SlideRef

				return { kind: "internal", anchor: this.targets.index.has(ref) ? `slide:${String(ref)}` : "" }
			}

			if (anchor.startsWith("jump:") && from !== undefined) {
				const ref = this.jump(anchor.slice(5) as Extract<Action, { kind: "internal" }>["jump"], from)

				return { kind: "internal", anchor: ref === undefined ? "" : `slide:${String(ref)}` }
			}

			return { kind: "internal", anchor: "" }
		})
	}

	private async drawing(page: PdfPage, drawing: DrawingData, matrix: Matrix): Promise<void> {
		if (drawing.itemCount <= 0) return

		this.measureSvgs(drawing, matrix)
		await paintDrawingPdf(
			{ page, fonts: this.fonts, image: image => this.image(image), defaultFamily: DRAWING_FAMILY },
			pdfDrawing(drawing),
			matrix
		)
	}

	// Where `drawing` under `matrix` draws its SVG pictures (page px on the longer side), so each is rasterised at the
	// size it lands at: pictures, and picture fills over their shapes' boxes.
	private measureSvgs(drawing: DrawingData, matrix: Matrix): void {
		this.svgNeeds.clear()

		if (this.sources.svg === undefined || !drawing.images.some(image => image.format === "svg")) return

		const ints = drawing.itemInts
		const floats = drawing.itemFloats

		for (let item = 0; item < drawing.itemCount; item++) {
			const i = item * ITEM_INTS
			const f = item * ITEM_FLOATS
			const kind = ints[i + ItemInt.KIND]
			let ref = -1

			if (kind === ItemKind.IMAGE) {
				ref = ints[i + ItemInt.REF] ?? -1
			} else if (kind === ItemKind.PATH) {
				const paint = drawing.paints[ints[i + ItemInt.FILL] ?? -1]

				if (paint?.kind === "image") ref = paint.image
			}

			const image = drawing.images[ref]

			if (image?.format !== "svg" || image.partName === undefined) continue

			const m = times(matrix, [
				floats[f + ItemFloat.A] ?? 1,
				floats[f + ItemFloat.B] ?? 0,
				floats[f + ItemFloat.C] ?? 0,
				floats[f + ItemFloat.D] ?? 1,
				0,
				0
			])
			const side = Math.max(
				Math.abs(floats[f + ItemFloat.WIDTH] ?? 0) * Math.hypot(m[0], m[1]),
				Math.abs(floats[f + ItemFloat.HEIGHT] ?? 0) * Math.hypot(m[2], m[3])
			)

			if (Number.isFinite(side)) this.svgNeeds.set(image.partName, Math.max(this.svgNeeds.get(image.partName) ?? 0, side))
		}
	}

	// A picture, written once per export; one the PDF cannot carry is counted, not drawn. `side`: the page px an SVG
	// lands at on its longer side, when the drawing did not say.
	private image(image: DrawingImage, side?: number): Promise<PdfImage | undefined> {
		if (image.format === "svg" && image.partName !== undefined && this.sources.svg !== undefined)
			return this.svgImage(image.partName, side ?? this.svgNeeds.get(image.partName) ?? 0)

		if (image.handling === "placeholder" || image.handling === "metafile" || image.format === "svg") {
			if (image.partName !== undefined || image.bytes !== undefined) this.refuse("picture")

			return Promise.resolve(undefined)
		}

		const inline = image.bytes

		if (image.partName === undefined) {
			if (inline === undefined) return Promise.resolve(undefined)

			return this.write(image, inline, image.bytesKey)
		}

		const part = image.partName
		const key = pictureKey(image, part)
		const held = this.images.get(key)

		if (held !== undefined) return held

		const made = this.sources.image(part).then(found => {
			if (found === null) {
				this.refuse("picture")

				return undefined
			}

			return this.write(image, found.bytes, part)
		})

		this.images.set(key, made)

		return made
	}

	// An SVG picture rasterised for the page: once per part, again only where it lands larger than before.
	private svgImage(part: string, landed: number): Promise<PdfImage | undefined> {
		const wanted = Math.max(1, landed) * SVG_PIXELS_PER_PX
		const side = Math.min(MAX_SVG_SIDE, Math.ceil(wanted / SVG_SIDE_STEP) * SVG_SIDE_STEP)
		const held = this.svgs.get(part)

		if (held !== undefined && held.side >= side) return held.image

		const svg = this.sources.svg
		const image = (async (): Promise<PdfImage | undefined> => {
			const pixels = svg === undefined ? undefined : await svg(part, side)

			if (pixels === undefined) {
				this.refuse("picture")

				return undefined
			}

			try {
				return await this.writer.pixels({ ...pixels, key: `svg:${part}@${String(side)}`, interpolate: true })
			} catch (error) {
				if (!(error instanceof PdfWriteError)) throw error

				this.refuse("image")

				return undefined
			}
		})()

		this.svgs.set(part, { side, image })

		return image
	}

	private async write(image: DrawingImage, bytes: Uint8Array, key: string | undefined): Promise<PdfImage | undefined> {
		try {
			return await this.writer.image(pictureSource(image, bytes, key))
		} catch (error) {
			if (!(error instanceof PdfWriteError)) throw error

			this.refuse("image")

			return undefined
		}
	}

	// The face a style's CSS font draws with: the session face of its alias (a bundled family, or an installed font's
	// bundled substitute), else the generic family's.
	private faceOf(font: string): { readonly index: number; readonly weight: number; readonly italic: boolean; readonly fitted: boolean } {
		const match = CSS_FONT.exec(font)
		const italic = match?.[1] !== undefined
		const weight = Number(match?.[2] ?? 400)
		const alias = match?.[4]
		const generic = match?.[5] ?? "sans-serif"
		const key = `${alias ?? ""}|${generic}|${String(weight)}|${italic ? 1 : 0}`
		let choice = this.choices.get(key)

		if (choice === undefined) {
			choice = this.choose(alias, generic, weight, italic)
			this.choices.set(key, choice)
		}

		const sourceKey =
			choice.source.kind === "bundled"
				? `b:${choice.source.family}:${String(choice.source.weight)}:${choice.source.italic ? 1 : 0}`
				: `e:${choice.source.key}`
		let index = this.faceKeys.get(sourceKey)

		if (index === undefined) {
			index = this.faceSources.push(choice.source) - 1
			this.faceKeys.set(sourceKey, index)
		}

		return { index, weight, italic, fitted: choice.fitted }
	}

	private choose(alias: string | undefined, generic: string, weight: number, italic: boolean): FaceChoice {
		const faces = alias === undefined ? [] : this.sources.faces.filter(face => face.face.family === alias)
		const face =
			faces.find(entry => entry.face.weight === weight && entry.face.italic === italic) ??
			faces.find(entry => entry.face.italic === italic) ??
			faces[0]

		if (face?.kind === "local")
			return { source: { kind: "bundled", family: substituteOf(face.name, generic), weight, italic }, fitted: true }

		const family = alias === undefined ? undefined : bundledFamily(alias)

		// A face of the deck's own (an embedded font, decoded): embedded in its own right, unless its licence forbids it
		// (then its bundled stand-in for the generic family draws).
		if (face?.kind === "bytes" && family === undefined) {
			const bytes = face.bytes
			let fsType: number

			try {
				fsType = readSfnt(bytes).fsType
			} catch {
				fsType = RESTRICTED_LICENSE
			}

			const faceWeight = typeof face.face.weight === "number" ? face.face.weight : face.face.weight[0]

			return {
				source: {
					kind: "embedded",
					key: `${alias ?? ""}:${String(faceWeight)}:${face.face.italic ? 1 : 0}`,
					read: () => Promise.resolve(bytes),
					fsType,
					weight: faceWeight,
					italic: face.face.italic,
					substitute: genericFamily(generic)
				},
				fitted: false
			}
		}

		if (family !== undefined) return { source: { kind: "bundled", family, weight, italic }, fitted: false }

		return { source: { kind: "bundled", family: genericFamily(generic), weight, italic }, fitted: false }
	}

	private prepare(text: TextPage, roles: readonly DocxPdfRole[], from: SlideRef | undefined): PreparedText {
		const styles: DocxPdfStyle[] = []
		const requests: PdfFontFaceRequest[] = []

		for (const style of text.styles) {
			const face = this.faceOf(style.font)

			styles.push(pdfStyle(style, face))
			requests.push({ family: `${FACE_PREFIX}${String(face.index)}`, bold: face.weight >= 700, italic: face.italic, slot: "ascii" })
		}

		const layer = this.texts++
		const base = toDocxPdfPage(text)
		const page = { ...base, roles, keys: base.keys.map(key => `t${String(layer)}:${key}`) }
		const doc: DocxPdfDocument = {
			pages: [page],
			styles,
			faces: [],
			decorations: text.decorations,
			links: this.links(text.links, from),
			objects: new Map(),
			media: new Map(),
			destinations: new Map(),
			outline: [],
			lang: undefined,
			title: this.options.title,
			paints: text.paints,
			strokes: text.strokes,
			textEffects: text.textEffects
		}

		return { doc, requests }
	}

	// A text page under `matrix` (its px → page px): the painter in its own space, its links mapped onto the page,
	// then its picture bullets.
	private async text(
		page: PdfPage,
		text: TextPage,
		matrix: Matrix,
		roles: readonly DocxPdfRole[],
		from: SlideRef | undefined
	): Promise<void> {
		const prepared = this.prepare(text, roles, from)
		const data = prepared.doc.pages[0]

		if (data === undefined) return

		const mapped = linkMapped(page, matrix)
		const context: PagePaintContext = {
			writer: this.writer,
			fonts: this.fonts,
			doc: prepared.doc,
			requests: prepared.requests,
			// The text styles carry no language of their own.
			langs: [],
			media: prepared.doc.media,
			seen: this.seen,
			heading: 0,
			refused: this.refused as Map<DocxPdfRefusal, number>,
			yieldIfDue: () => this.writer.yieldIfDue()
		}

		page.saveState()
		page.concat(matrix)

		const painter = new DocxPagePainter(context, mapped, data)

		await painter.paint()
		painter.closeAll()
		await this.bullets(page, text, matrix)
		page.restoreState()
	}

	// Picture bullets over their places (artifacts: the marker's text is the paragraph's own).
	private async bullets(page: PdfPage, text: TextPage, matrix: Matrix): Promise<void> {
		const data = text.page

		for (let k = 0; k < data.objectCount; k++) {
			if (data.objectKinds[k] !== PICTURE_BULLET_OBJECT) continue

			const part = text.images?.[data.objectInts[k * 3] ?? -1]

			if (part === undefined) continue

			const image = await this.image(
				bulletImage(part),
				Math.max(data.objectFloats[k * 4 + 2] ?? 0, data.objectFloats[k * 4 + 3] ?? 0) * scaleOf(matrix)
			)

			if (image === undefined) continue

			page.beginArtifact({ type: "Layout" })
			page.drawImage(
				image,
				data.objectFloats[k * 4] ?? 0,
				data.objectFloats[k * 4 + 1] ?? 0,
				data.objectFloats[k * 4 + 2] ?? 0,
				data.objectFloats[k * 4 + 3] ?? 0
			)
			page.endArtifact()
		}
	}
}

// The painter's view of a drawing (its tables as arrays of their own; the data itself is shared).
function pdfDrawing(drawing: DrawingData): PdfDrawingData {
	return {
		width: drawing.width,
		height: drawing.height,
		commands: drawing.commands,
		coords: drawing.coords,
		itemCount: drawing.itemCount,
		itemFloats: drawing.itemFloats,
		itemInts: drawing.itemInts,
		paints: [...drawing.paints],
		strokes: [...drawing.strokes],
		images: [...drawing.images],
		texts: [...drawing.texts],
		...(drawing.clips === undefined ? {} : { clips: [...drawing.clips] }),
		...(drawing.itemClips === undefined ? {} : { itemClips: drawing.itemClips }),
		...(drawing.background === undefined ? {} : { background: drawing.background })
	}
}

// The picture a picture bullet shows, as a drawing image of its part.
function bulletImage(part: string): DrawingImage {
	const format = imageFormat(part, undefined)

	return { ...MISSING_IMAGE, partName: part, format, handling: imageHandling(format) }
}

function pdfStyle(
	style: DocxTextStyle,
	face: { readonly index: number; readonly weight: number; readonly italic: boolean; readonly fitted: boolean }
): DocxPdfStyle {
	const size = Number(CSS_FONT.exec(style.font)?.[3] ?? 0)

	return {
		face: face.index,
		bold: face.weight >= 700,
		italic: face.italic,
		slot: "ascii",
		language: undefined,
		size: Number.isFinite(size) ? size : 0,
		color: HEX.test(style.color) ? (Number.parseInt(style.color, 16) * 256 + 255) >>> 0 : BLACK,
		letterSpacing: style.letterSpacing,
		scaleX: style.scaleX,
		shift: style.shift,
		fit: face.fitted ? "scale" : "spread",
		...(style.paint === undefined ? {} : { paint: style.paint }),
		...(style.alpha === undefined ? {} : { alpha: style.alpha }),
		...(style.outline === undefined ? {} : { outline: style.outline }),
		...(style.effects === undefined ? {} : { effects: style.effects })
	}
}

// The page as the docx painter sees it inside a q … cm … Q: its link annotations (written in default user space,
// which the content's matrix does not move) placed where the matrix puts their boxes.
function linkMapped(page: PdfPage, matrix: Matrix): PdfPage {
	return new Proxy(page, {
		get(target, property) {
			if (property === "link") {
				return (
					box: readonly [number, number, number, number],
					...rest: Parameters<PdfPage["link"]> extends [unknown, ...infer R] ? R : never
				) => target.link(mapBox(matrix, box[0], box[1], box[2], box[3]), ...rest)
			}

			const value: unknown = Reflect.get(target, property, target)

			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value
		}
	})
}
