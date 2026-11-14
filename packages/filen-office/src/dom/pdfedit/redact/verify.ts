import type * as Mupdf from "mupdf"
import { contentStrings } from "../../../core/pdfedit/contentStream"
import {
	concatMatrix,
	forEachCoveredPixel,
	foldCase,
	glyphCore,
	intersectRects,
	invertMatrix,
	matchTerm,
	pdfTextString,
	quadBounds,
	quadOverlapsRect,
	rectsOverlap,
	segmentCrossesRect,
	streamReadings,
	transformPoint,
	transformRect,
	transformRectQuad,
	type RedactionFailure,
	type RedactionManifest,
	type RedactionPlace,
	type RedactionRegion,
	type RedactionTerm,
	type RedactionVerdict,
	type RedactMatrix,
	type RedactQuad,
	type RedactRect
} from "../../../core/pdfedit/redactVerify"
import type { MupdfModule } from "../protocol"
import { removeAlternates } from "./content"
import { pageText } from "./find"

// The redaction verifier, run on the saved file (opened read-only in its own engine, so it may change the open
// document in memory: it enables every optional content group and unhides every annotation, and never saves). All
// must hold, else the first failure is returned:
// - one revision; with sanitize, no metadata, attachments, scripts or page pieces; on redacted pages, no thumbnails
//   or alternate images;
// - no searched term in any page's text (all layers on) nor in any decoded string, name or non-image stream of any
//   object (annotations, fields, bookmarks, destinations, URIs, tags, page labels, XMP, attachment names, …);
// - no glyph (filled, stroked, clipping or invisible; in forms, patterns and annotation appearances) inside a mark;
// - every pixel of every image drawn over a mark is the redaction fill (white, opaque; unpainted for stencils);
// - under area and page marks, no drawing or shading that touches the mark.

type Fail = (failure: RedactionFailure) => void

const ANNOTATION_TYPES = new Set([
	"Text",
	"Link",
	"FreeText",
	"Line",
	"Square",
	"Circle",
	"Polygon",
	"PolyLine",
	"Highlight",
	"Underline",
	"Squiggly",
	"StrikeOut",
	"Redact",
	"Stamp",
	"Caret",
	"Ink",
	"Popup",
	"FileAttachment",
	"Sound",
	"Movie",
	"RichMedia",
	"Screen",
	"PrinterMark",
	"TrapNet",
	"Watermark",
	"3D",
	"Projection"
])
const HIDDEN_FLAGS = 1 | 2 | 32
const SCRIPT_ACTIONS = new Set(["JavaScript", "Launch", "SubmitForm", "ImportData", "ResetForm", "Rendition", "RichMediaExecute"])

interface Scan {
	readonly terms: readonly RedactionTerm[]
	readonly sanitized: boolean
	// Object number of each page's content streams, to name the page a term was found on.
	readonly contentPages: ReadonlyMap<number, number>
	readonly infoNumber: number
	readonly fail: Fail
	failed: () => boolean
}

function placeOf(dict: Mupdf.PDFObject, infoNumber: number, number: number): RedactionPlace {
	if (number !== 0 && number === infoNumber) return "metadata"

	const type = dict.get("Type").asName()
	const subtype = dict.get("Subtype").asName()

	if (type === "Metadata") return "metadata"
	if (type === "Filespec" || type === "EmbeddedFile" || !dict.get("EF").isNull()) return "attachment"
	if (type === "StructElem" || type === "StructTreeRoot" || type === "MCR" || type === "OBJR") return "tags"
	if (subtype === "Widget" || !dict.get("FT").isNull() || (!dict.get("T").isNull() && !dict.get("Kids").isNull())) return "field"
	if (ANNOTATION_TYPES.has(subtype) && !dict.get("Rect").isNull()) return "annotation"
	if (type === "Outlines" || (!dict.get("Title").isNull() && (!dict.get("Parent").isNull() || !dict.get("First").isNull())))
		return "bookmark"

	return "file"
}

function hasTerm(text: string, terms: readonly RedactionTerm[]): RedactionTerm | null {
	if (text.length === 0) return null

	const folded = foldCase(text)

	return terms.find(term => matchTerm(text, term, folded).length > 0) ?? null
}

// Strings, names and keys of a direct object tree (indirect references are scanned as their own objects).
function scanValue(value: Mupdf.PDFObject, scan: Scan, place: RedactionPlace, depth: number): void {
	if (scan.failed() || depth > 64 || value.isIndirect()) return

	let text: string | null = null

	if (value.isString()) text = `${value.asString()}\n${pdfTextString(value.asByteString())}`
	else if (value.isName()) text = value.asName()

	if (text !== null) {
		const term = hasTerm(text, scan.terms)

		if (term !== null) scan.fail({ code: "term", term: term.text, place })

		return
	}

	if (value.isDictionary() || value.isArray()) {
		value.forEach((child, key) => {
			if (typeof key === "string") {
				const term = hasTerm(key, scan.terms)

				if (term !== null) scan.fail({ code: "term", term: term.text, place })
			}

			scanValue(child, scan, place, depth + 1)
		})
	}
}

// Rules on a dictionary that apply whatever its strings say.
function checkDict(dict: Mupdf.PDFObject, scan: Scan): void {
	if (!scan.sanitized) return

	const type = dict.get("Type").asName()

	if (type === "Metadata" || !dict.get("Metadata").isNull()) scan.fail({ code: "metadata", what: "xmp" })
	else if (!dict.get("PieceInfo").isNull()) scan.fail({ code: "metadata", what: "pieceInfo" })
	else if (
		type === "EmbeddedFile" ||
		!dict.get("EF").isNull() ||
		!dict.get("EmbeddedFiles").isNull() ||
		dict.get("Subtype").asName() === "FileAttachment"
	)
		scan.fail({ code: "metadata", what: "attachments" })
	else if (
		!dict.get("AA").isNull() ||
		!dict.get("JS").isNull() ||
		!dict.get("JavaScript").isNull() ||
		SCRIPT_ACTIONS.has(dict.get("S").asName())
	)
		scan.fail({ code: "metadata", what: "scripts" })
}

function scanDicts(value: Mupdf.PDFObject, scan: Scan, depth: number): void {
	if (scan.failed() || depth > 64 || value.isIndirect()) return
	if (value.isDictionary()) checkDict(value, scan)
	if (value.isDictionary() || value.isArray()) {
		value.forEach(child => {
			scanDicts(child, scan, depth + 1)
		})
	}
}

// Streams that hold no text a person wrote: pictures, font programs, colour profiles, sampled functions, and the
// file's own cross-reference and object streams (whose objects are scanned one by one). Reading their binary as
// text would only find short terms by chance.
function isBinaryStream(stream: Mupdf.PDFObject): boolean {
	const type = stream.get("Type").asName()
	const subtype = stream.get("Subtype").asName()

	return (
		subtype === "Image" ||
		subtype === "Type1C" ||
		subtype === "CIDFontType0C" ||
		subtype === "OpenType" ||
		type === "XRef" ||
		type === "ObjStm" ||
		!stream.get("Length1").isNull() ||
		!stream.get("Length2").isNull() ||
		!stream.get("FunctionType").isNull() ||
		(!stream.get("N").isNull() && type === "") ||
		(!stream.get("Width").isNull() && !stream.get("Height").isNull())
	)
}

function scanStream(stream: Mupdf.PDFObject, number: number, scan: Scan, place: RedactionPlace): void {
	if (scan.terms.length === 0 || isBinaryStream(stream)) return

	let bytes: Uint8Array

	try {
		bytes = stream.readStream().asUint8Array()
	} catch {
		bytes = stream.readRawStream().asUint8Array()
	}

	const page = scan.contentPages.get(number)
	const where: RedactionPlace = page === undefined ? place : "page"
	const report = (term: RedactionTerm): void => {
		scan.fail(
			page === undefined
				? { code: "term", term: term.text, place: where }
				: { code: "term", term: term.text, place: where, page: page + 1 }
		)
	}

	for (const reading of streamReadings(bytes)) {
		const term = hasTerm(reading, scan.terms)

		if (term !== null) return report(term)
	}

	for (const string of contentStrings(bytes)) {
		const term = hasTerm(pdfTextString(string), scan.terms)

		if (term !== null) return report(term)
	}
}

function scanObjects(document: Mupdf.PDFDocument, scan: Scan): void {
	const trailer = document.getTrailer()
	const info = trailer.get("Info")

	if (scan.sanitized && info.isDictionary() && info.length > 0) {
		scan.fail({ code: "metadata", what: "info" })

		return
	}

	// The encryption dictionary and the file identifier are binary.
	const encryption = trailer.get("Encrypt").asIndirect()
	// `reference` answers stream questions (a resolved object no longer knows it is a stream); `object` is walked.
	const visit = (object: Mupdf.PDFObject, reference: Mupdf.PDFObject, number: number): void => {
		if (scan.failed() || (number !== 0 && number === encryption)) return
		if (!(object.isDictionary() || object.isArray() || object.isString() || object.isName())) return

		const place = object.isDictionary() ? placeOf(object, scan.infoNumber, number) : "file"

		scanDicts(object, scan, 0)
		if (scan.terms.length > 0) scanValue(object, scan, place, 0)
		if (reference.isStream()) scanStream(reference, number, scan, place)
	}

	if (info.isDictionary() && !info.isIndirect()) visit(info, info, 0)

	for (let number = 1; number < document.countObjects() && !scan.failed(); number++) {
		const reference = document.newIndirect(number)

		visit(reference.resolve(), reference, number)
	}
}

// ——— Pages ———

function each(object: Mupdf.PDFObject, visit: (value: Mupdf.PDFObject) => void, depth = 0): void {
	if (depth > 64) return

	visit(object)

	if (object.isDictionary() || object.isArray()) {
		object.forEach(child => {
			if (!child.isIndirect()) each(child, visit, depth + 1)
		})
	}
}

// Every optional content group and membership dictionary made into a plain dictionary: MuPDF then treats all
// optional content as visible (an OCG list can be ON while a membership expression still hides content).
function enableAllContent(document: Mupdf.PDFDocument): void {
	const neutralize = (value: Mupdf.PDFObject): void => {
		if (!value.isDictionary()) return

		const type = value.get("Type").asName()

		if (type === "OCG" || type === "OCMD") value.put("Type", document.newName("Visible"))
	}

	document.getTrailer().get("Root").delete("OCProperties")

	for (let number = 1; number < document.countObjects(); number++) each(document.newIndirect(number).resolve(), neutralize)
}

interface Tile {
	readonly ctm: RedactMatrix
	readonly xstep: number
	readonly ystep: number
	readonly area: RedactRect
}

interface PageCheck {
	readonly regions: readonly RedactionRegion[]
	readonly areas: readonly RedactRect[]
	readonly textRects: readonly RedactRect[]
	readonly fail: (code: "text" | "image" | "drawing" | "unreadable") => void
	failed: () => boolean
}

// Whether a quad drawn inside a tiling pattern cell overlaps a region in any repetition of the cell over the
// pattern's area.
function tiledOverlaps(quad: RedactQuad, tile: Tile, regions: readonly RedactRect[]): boolean {
	const inverse = invertMatrix(tile.ctm)

	if (inverse === null || tile.xstep === 0 || tile.ystep === 0) return regions.some(region => rectsOverlap(quadBounds(quad), region))

	const local = quadBounds([
		...transformPoint(inverse, quad[0], quad[1]),
		...transformPoint(inverse, quad[2], quad[3]),
		...transformPoint(inverse, quad[4], quad[5]),
		...transformPoint(inverse, quad[6], quad[7])
	])

	for (const region of regions) {
		const target = intersectRects(region, tile.area)

		if (target === null) continue

		const box = transformRect(inverse, target)
		const xs = Math.abs(tile.xstep)
		const ys = Math.abs(tile.ystep)
		const fromI = Math.floor((box[0] - local[2]) / xs)
		const toI = Math.ceil((box[2] - local[0]) / xs)
		const fromJ = Math.floor((box[1] - local[3]) / ys)
		const toJ = Math.ceil((box[3] - local[1]) / ys)

		for (let i = fromI; i <= toI; i++) {
			for (let j = fromJ; j <= toJ; j++) {
				const shifted = transformRectQuad(tile.ctm, [local[0] + i * xs, local[1] + j * ys, local[2] + i * xs, local[3] + j * ys])

				if (quadOverlapsRect(shifted, target)) return true
				// A huge number of cells only means the region is covered many times over.
				if ((toI - fromI) * (toJ - fromJ) > 4096) return true
			}
		}
	}

	return false
}

// "white": the redaction fill of a picture (white, opaque). "opaque": a soft mask under a fill. "unpainted": a
// stencil drawn through a mark. "uniform": an image used as a clip, which must hold no shape inside a mark.
type PixelRule = "white" | "opaque" | "unpainted" | "uniform"

function pixelsAre(pixmap: Mupdf.Pixmap, mupdf: MupdfModule, rule: PixelRule): (column: number, row: number) => boolean {
	let target = pixmap
	const type = pixmap.getColorSpace()?.getType()

	if (rule === "white" && type !== "Gray" && type !== "RGB" && type !== "BGR" && type !== "CMYK" && type !== undefined) {
		target = pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false)
	}

	const width = target.getWidth()
	const stride = target.getStride()
	const components = target.getNumberOfComponents()
	const alpha = target.getAlpha()
	const n = stride / Math.max(1, width)
	const pixels = target.getPixels()
	const subtractive = target.getColorSpace()?.getType() === "CMYK"
	let first: number | null = null

	return (column, row) => {
		const at = row * stride + column * n
		const last = pixels[at + n - 1] ?? -1

		if (rule === "unpainted") return last === 0
		if (rule === "opaque") return last === 255
		if (rule === "uniform") {
			first ??= last

			return last === first
		}
		if (alpha === 1 && last !== 255) return false

		for (let component = 0; component < components; component++) {
			const value = pixels[at + component] ?? 0

			if (subtractive ? value !== 0 : value < 254) return false
		}

		return true
	}
}

// Whether every pixel of an image (and of its soft mask) that a region covers is the fill.
function checkImage(mupdf: MupdfModule, image: Mupdf.Image, ctm: RedactMatrix, regions: readonly RedactRect[], rule: PixelRule): boolean {
	const placed = transformRectQuad(ctm, [0, 0, 1, 1])
	const hit = regions.filter(region => quadOverlapsRect(placed, region))

	if (hit.length === 0) return true

	const check = (subject: Mupdf.Image, subjectRule: PixelRule): boolean => {
		const pixmap = subject.toPixmap()
		const test = pixelsAre(pixmap, mupdf, subjectRule)
		let ok = true

		for (const region of hit) {
			forEachCoveredPixel(ctm, pixmap.getWidth(), pixmap.getHeight(), region, (column, row) => {
				ok = test(column, row)

				return ok
			})

			if (!ok) break
		}

		pixmap.destroy()

		return ok
	}
	const mask = rule === "white" ? image.getMask() : null

	return check(image, rule) && (mask === null || check(mask, "opaque"))
}

function isRectanglePath(path: Mupdf.Path, ctm: RedactMatrix): RedactRect | null {
	const points: (readonly [number, number])[] = []
	let curved = false

	path.walk({
		moveTo: (x, y) => points.push(transformPoint(ctm, x, y)),
		lineTo: (x, y) => points.push(transformPoint(ctm, x, y)),
		curveTo: () => {
			curved = true
		}
	})

	if (curved || points.length < 4 || points.length > 5) return null

	const xs = new Set(points.map(([x]) => Math.round(x * 20)))
	const ys = new Set(points.map(([, y]) => Math.round(y * 20)))

	if (xs.size !== 2 || ys.size !== 2) return null

	return [
		Math.min(...points.map(([x]) => x)),
		Math.min(...points.map(([, y]) => y)),
		Math.max(...points.map(([x]) => x)),
		Math.max(...points.map(([, y]) => y))
	]
}

const rectContains = (rect: RedactRect, [x, y]: readonly [number, number]): boolean =>
	x > rect[0] && x < rect[2] && y > rect[1] && y < rect[3]
const close = (left: RedactRect, right: RedactRect): boolean => left.every((value, index) => Math.abs(value - (right[index] ?? 0)) < 0.05)
const inside = (inner: RedactRect, outer: RedactRect): boolean =>
	inner[0] >= outer[0] - 0.05 && inner[1] >= outer[1] - 0.05 && inner[2] <= outer[2] + 0.05 && inner[3] <= outer[3] + 0.05

// Whether a path (page space through `ctm`) touches a rectangle: a segment crosses it (strokes widened by half the
// line width), or, for fills, the rectangle's centre lies inside the path.
function pathTouches(path: Mupdf.Path, ctm: RedactMatrix, rect: RedactRect, halfWidth: number, fill: boolean, evenOdd: boolean): boolean {
	const grown: RedactRect = [rect[0] - halfWidth, rect[1] - halfWidth, rect[2] + halfWidth, rect[3] + halfWidth]
	const cx = (rect[0] + rect[2]) / 2
	const cy = (rect[1] + rect[3]) / 2
	let touched = false
	let winding = 0
	let crossings = 0
	let start: readonly [number, number] | null = null
	let current: readonly [number, number] = [0, 0]
	const segment = (to: readonly [number, number]): void => {
		if ((to[0] !== current[0] || to[1] !== current[1]) && segmentCrossesRect(current[0], current[1], to[0], to[1], grown))
			touched = true
		// Ray to +x from the centre, for the inside test.
		if (current[1] <= cy !== to[1] <= cy) {
			const x = current[0] + ((cy - current[1]) * (to[0] - current[0])) / (to[1] - current[1])

			if (x > cx) {
				crossings++
				winding += to[1] > current[1] ? 1 : -1
			}
		}

		current = to
	}
	// Fills close every subpath; strokes only those closed explicitly.
	const endSubpath = (): void => {
		if (start !== null && fill) segment(start)
	}
	const point = (x: number, y: number): readonly [number, number] => {
		const mapped = transformPoint(ctm, x, y)

		// A lone point still marks where a dot is drawn.
		if (start === null) {
			start = mapped
			current = mapped
		}

		return mapped
	}

	path.walk({
		moveTo: (x, y) => {
			endSubpath()
			start = null
			point(x, y)
			if (rectContains(grown, current)) touched = true
		},
		lineTo: (x, y) => {
			segment(point(x, y))
		},
		curveTo: (x1, y1, x2, y2, x3, y3) => {
			const from = current
			const p1 = transformPoint(ctm, x1, y1)
			const p2 = transformPoint(ctm, x2, y2)
			const p3 = transformPoint(ctm, x3, y3)

			for (let step = 1; step <= 16; step++) {
				const t = step / 16
				const u = 1 - t

				segment([
					u * u * u * from[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
					u * u * u * from[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
				])
			}
		},
		closePath: () => {
			if (start !== null) segment(start)
		}
	})
	endSubpath()

	return touched || (fill && (evenOdd ? crossings % 2 === 1 : winding !== 0))
}

// MuPDF.js 1.28.6 hands a device's fillShade a Shade wrapping the interpreter's shading without taking a reference,
// yet registers it for dropping when collected: dropped then, the shading is released once too often and the heap is
// corrupted. The wrapper is detached from its finalizer as soon as it has been read.
function forgetBorrowed(mupdf: MupdfModule, shade: Mupdf.Shade): void {
	const registry: unknown = Reflect.get(mupdf.Shade, "_finalizer")

	if (registry instanceof FinalizationRegistry) registry.unregister(shade)

	Reflect.set(shade, "pointer", 0)
}

function runChecks(mupdf: MupdfModule, page: Mupdf.PDFPage, check: PageCheck, withAnnotations: boolean): void {
	const allRects = check.regions.map(region => region.rect)
	const advances = new Map<string, number>()
	const tiles: Tile[] = []
	const clips: (RedactRect | null)[] = []
	let maskArea: RedactRect | null = null
	const zeroStroke = new mupdf.StrokeState({ lineCap: "Butt", lineJoin: "Miter", lineWidth: 0, miterLimit: 10 })
	const pushClip = (box: RedactRect | null): void => {
		const top = clips.at(-1) ?? null

		clips.push(box === null ? top : top === null ? box : (intersectRects(top, box) ?? [box[0], box[1], box[0], box[1]]))
	}
	const glyphs = (text: Mupdf.Text, ctm: Mupdf.Matrix): void => {
		if (check.failed()) return

		text.walk({
			showGlyph: (font, trm, glyph, _unicode, wmode) => {
				if (check.failed()) return

				const key = `${String(font.pointer)}:${String(glyph)}:${String(wmode)}`
				let advance = advances.get(key)

				if (advance === undefined) {
					advance = font.advanceGlyph(glyph, wmode)
					advances.set(key, advance)
				}

				const core = glyphCore(concatMatrix(trm, ctm), advance, wmode === 1)
				const tile = tiles.at(-1)
				const inside =
					tile === undefined ? allRects.some(rect => quadOverlapsRect(core, rect)) : tiledOverlaps(core, tile, allRects)

				if (inside) check.fail("text")
			}
		})
	}
	const image = (picture: Mupdf.Image, ctm: Mupdf.Matrix, rule: PixelRule): void => {
		if (check.failed()) return

		const tile = tiles.at(-1)

		if (tile !== undefined) {
			if (tiledOverlaps(transformRectQuad(ctm, [0, 0, 1, 1]), tile, allRects)) check.fail("image")

			return
		}

		if (!checkImage(mupdf, picture, ctm, allRects, rule)) check.fail("image")
	}
	const drawing = (path: Mupdf.Path, ctm: Mupdf.Matrix, halfWidth: number, fill: boolean, evenOdd: boolean): void => {
		if (check.failed() || check.areas.length === 0 || tiles.length > 0) return

		const box = fill ? isRectanglePath(path, ctm) : null

		// The redaction boxes themselves.
		if (box !== null && (allRects.some(rect => close(box, rect)) || check.textRects.some(rect => inside(box, rect)))) return
		if (check.areas.some(area => pathTouches(path, ctm, area, halfWidth, fill, evenOdd))) check.fail("drawing")
	}
	// A callback must not throw back through MuPDF: a failure to read what it was given fails the page instead.
	const guard =
		<Args extends unknown[]>(run: (...args: Args) => void) =>
		(...args: Args): void => {
			try {
				run(...args)
			} catch {
				check.fail("unreadable")
			}
		}
	const guarded = { glyphs: guard(glyphs), image: guard(image), drawing: guard(drawing) }
	const device = new mupdf.Device({
		fillText: (text, ctm) => guarded.glyphs(text, ctm),
		strokeText: (text, _stroke, ctm) => guarded.glyphs(text, ctm),
		clipText: (text, ctm) => {
			guarded.glyphs(text, ctm)
			pushClip(text.getBounds(zeroStroke, ctm))
		},
		clipStrokeText: (text, stroke, ctm) => {
			guarded.glyphs(text, ctm)
			pushClip(text.getBounds(stroke, ctm))
		},
		ignoreText: (text, ctm) => guarded.glyphs(text, ctm),
		fillImage: (picture, ctm) => guarded.image(picture, ctm, "white"),
		fillImageMask: (picture, ctm) => guarded.image(picture, ctm, "unpainted"),
		clipImageMask: (picture, ctm) => {
			guarded.image(picture, ctm, "uniform")
			pushClip(transformRect(ctm, [0, 0, 1, 1]))
		},
		fillPath: (path, evenOdd, ctm) => guarded.drawing(path, ctm, 0, true, evenOdd),
		strokePath: (path, stroke, ctm) => {
			const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]))

			guarded.drawing(path, ctm, (stroke.getLineWidth() * scale) / 2, false, false)
		},
		clipPath: (path, _evenOdd, ctm) => pushClip(path.getBounds(zeroStroke, ctm)),
		clipStrokePath: (path, stroke, ctm) => pushClip(path.getBounds(stroke, ctm)),
		popClip: () => {
			clips.pop()
		},
		beginMask: area => {
			maskArea = area
		},
		endMask: () => {
			pushClip(maskArea)
		},
		fillShade: (shade, ctm) => {
			const bounds = transformRect(ctm, shade.getBounds())

			forgetBorrowed(mupdf, shade)

			if (check.failed() || check.areas.length === 0 || tiles.length > 0) return

			const clip = clips.at(-1) ?? null
			const visible = clip === null ? bounds : intersectRects(clip, bounds)

			if (visible !== null && check.areas.some(area => rectsOverlap(visible, area))) check.fail("drawing")
		},
		beginTile: (area, _view, xstep, ystep, ctm) => {
			if (tiles.length === 0 && check.areas.some(region => rectsOverlap(area, region))) check.fail("drawing")

			tiles.push({ ctm, xstep, ystep, area })

			return 0
		},
		endTile: () => {
			tiles.pop()
		}
	})

	try {
		if (withAnnotations) {
			page.run(device, mupdf.Matrix.identity)
		} else {
			page.runPageContents(device, mupdf.Matrix.identity)
			page.runPageWidgets(device, mupdf.Matrix.identity)
		}
	} finally {
		device.close()
		device.destroy()
		zeroStroke.destroy()
	}
}

// Verifies a saved redacted file against what was redacted. The document is changed in memory (all content made
// visible) and must not be saved or reused for editing.
export function verifyRedactedPdf(mupdf: MupdfModule, document: Mupdf.PDFDocument, manifest: RedactionManifest): RedactionVerdict {
	let failure: RedactionFailure | null = null
	const fail: Fail = found => {
		failure ??= found
	}
	const failed = (): boolean => failure !== null
	const verdict = (): RedactionVerdict => (failure === null ? { ok: true } : { ok: false, failure })
	const versions = document.countVersions()

	if (versions !== 1) return { ok: false, failure: { code: "revisions", count: versions } }

	const contentPages = new Map<number, number>()
	const pageCount = document.countPages()

	for (let index = 0; index < pageCount; index++) {
		const contents = document.findPage(index).get("Contents")

		if (contents.isArray()) contents.forEach(part => contentPages.set(part.asIndirect(), index))
		else contentPages.set(contents.asIndirect(), index)
	}

	scanObjects(document, {
		terms: manifest.terms,
		sanitized: manifest.sanitized,
		contentPages,
		infoNumber: document.getTrailer().get("Info").asIndirect(),
		fail,
		failed
	})

	if (failed()) return verdict()

	enableAllContent(document)

	for (let index = 0; index < pageCount && !failed(); index++) {
		const regions = manifest.regions.filter(region => region.page === index)

		if (regions.length === 0 && manifest.terms.length === 0) continue

		let page: Mupdf.PDFPage

		try {
			page = document.loadPage(index)

			for (const annotation of [...page.getAnnotations(), ...page.getWidgets()]) {
				const flags = annotation.getFlags()

				if ((flags & HIDDEN_FLAGS) !== 0) annotation.setFlags(flags & ~HIDDEN_FLAGS)
			}

			if (regions.length > 0 && removeAlternates(page.getObject(), false)) fail({ code: "hiddenData" })

			if (regions.length > 0 && !failed()) {
				runChecks(
					mupdf,
					page,
					{
						regions,
						areas: regions.filter(region => region.kind !== "text").map(region => region.rect),
						textRects: regions.filter(region => region.kind === "text").map(region => region.rect),
						fail: code => {
							fail({ code, page: index + 1 })
						},
						failed
					},
					manifest.annotationsRemoved
				)
			}

			if (!failed() && manifest.terms.length > 0) {
				const term = hasTerm(pageText(page).text, manifest.terms)

				if (term !== null) fail({ code: "term", term: term.text, place: "page", page: index + 1 })
			}

			page.destroy()
		} catch {
			fail({ code: "unreadable", page: index + 1 })
		}
	}

	return verdict()
}
