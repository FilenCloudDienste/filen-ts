import {
	PDF_SIGNATURE_MAX_POINTS,
	PDF_SIGNATURE_MAX_STROKES,
	type PdfPageRect,
	type PdfSignatureRole,
	type PdfVisualSignature
} from "../../../core/pdfedit/visualSignature"
import { PdfEngineRefusal } from "../context"
import { addFillMark, addFillText, placeVisualSignature, type PdfFillFont, type PdfFillMark, type PdfRgb } from "../fillSign"
import { isIndex, isRecord, isText, type PdfCommandContext, type PdfCommandTable } from "./types"

// Fill & Sign marks on a page through the Fill & Sign block (fillSign/annotations.ts): typed text, a check mark /
// cross / dot, and a visual signature or initials (a picture of a signature, not a certificate signature). Each is one
// journal operation adding one annotation with the user's author name (empty: none) and the time. Boxes are MuPDF page
// space (points, origin at the top left of the page box, y down), clamped to the page.

export interface PdfFillPlacement {
	// 0-based page.
	readonly page: number
	readonly box: PdfPageRect
	// The annotation's author; "" writes none.
	readonly author: string
}

export interface PdfFillSignCommands {
	"fillSign.text": PdfFillPlacement & {
		readonly text: string
		readonly font: PdfFillFont
		readonly size: number
		readonly color: PdfRgb
	}
	"fillSign.mark": PdfFillPlacement & { readonly mark: PdfFillMark; readonly color: PdfRgb }
	"fillSign.signature": PdfFillPlacement & { readonly role: PdfSignatureRole; readonly signature: PdfVisualSignature }
}

const MAX_TEXT = 100_000
const MAX_AUTHOR = 1024
// Points: the largest page side PDF allows (14,400 user units).
const MAX_COORDINATE = 14_400
const MIN_SIZE = 1
const MAX_FONT_SIZE = 1000
// A signature picture is a small PNG (the dialog makes at most a few hundred KiB).
const MAX_PNG_BYTES = 4 * 1024 * 1024
const MAX_SIGNATURE_SIDE = 100_000
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const FONTS: readonly PdfFillFont[] = ["sans", "serif", "mono"]
const MARKS: readonly PdfFillMark[] = ["check", "cross", "dot"]

function isFiniteIn(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
}

function parseBox(value: unknown): PdfPageRect | null {
	if (!Array.isArray(value) || value.length !== 4 || !value.every(item => isFiniteIn(item, -MAX_COORDINATE, MAX_COORDINATE))) return null

	const [x0, y0, x1, y1] = value as [number, number, number, number]

	return x1 - x0 >= MIN_SIZE && y1 - y0 >= MIN_SIZE ? [x0, y0, x1, y1] : null
}

function parseColor(value: unknown): PdfRgb | null {
	return Array.isArray(value) && value.length === 3 && value.every(item => isFiniteIn(item, 0, 1))
		? [value[0] as number, value[1] as number, value[2] as number]
		: null
}

function parsePlacement(args: unknown): PdfFillPlacement | null {
	if (!isRecord(args) || !isIndex(args["page"]) || !isText(args["author"], MAX_AUTHOR)) return null

	const box = parseBox(args["box"])

	return box === null ? null : { page: args["page"], box, author: args["author"] }
}

function isPng(bytes: Uint8Array): boolean {
	return PNG_MAGIC.every((byte, index) => bytes[index] === byte)
}

function parseSignature(value: unknown): PdfVisualSignature | null {
	if (!isRecord(value)) return null

	const width = value["width"]
	const height = value["height"]

	if (!isFiniteIn(width, Number.MIN_VALUE, MAX_SIGNATURE_SIDE) || !isFiniteIn(height, Number.MIN_VALUE, MAX_SIGNATURE_SIDE)) return null

	if (value["kind"] === "image") {
		const png = value["png"]

		return png instanceof Uint8Array && png.length <= MAX_PNG_BYTES && isPng(png) ? { kind: "image", png, width, height } : null
	}

	const strokes = value["strokes"]

	if (value["kind"] !== "strokes" || !Array.isArray(strokes) || strokes.length === 0 || strokes.length > PDF_SIGNATURE_MAX_STROKES)
		return null

	const valid = strokes.every(
		(stroke: unknown) =>
			Array.isArray(stroke) &&
			stroke.length >= 2 &&
			stroke.length % 2 === 0 &&
			stroke.length <= PDF_SIGNATURE_MAX_POINTS * 2 &&
			stroke.every(coordinate => isFiniteIn(coordinate, -MAX_SIGNATURE_SIDE, MAX_SIGNATURE_SIDE))
	)

	return valid ? { kind: "strokes", width, height, strokes: strokes as number[][] } : null
}

// The page and the box clamped to its bounds; refused when the box lies outside it.
function placeOn(
	context: PdfCommandContext,
	placement: PdfFillPlacement
): { readonly page: ReturnType<PdfCommandContext["page"]>; readonly box: PdfPageRect } {
	if (placement.page >= context.document.countPages()) throw new PdfEngineRefusal("badRequest", "no such page")

	const page = context.page(placement.page)
	const [bx0, by0, bx1, by1] = page.getBounds()
	const [x0, y0, x1, y1] = placement.box
	const box: PdfPageRect = [Math.max(x0, bx0), Math.max(y0, by0), Math.min(x1, bx1), Math.min(y1, by1)]

	if (box[2] - box[0] < MIN_SIZE || box[3] - box[1] < MIN_SIZE) throw new PdfEngineRefusal("badRequest", "the box is outside the page")

	return { page, box }
}

export const FILL_SIGN_COMMANDS: PdfCommandTable<PdfFillSignCommands> = {
	"fillSign.text": {
		tool: "annotate",
		parse: args => {
			const placement = parsePlacement(args)
			const color = isRecord(args) ? parseColor(args["color"]) : null

			if (placement === null || color === null || !isRecord(args)) return null

			const text = args["text"]
			const font = FONTS.find(candidate => candidate === args["font"])
			const size = args["size"]

			return isText(text, MAX_TEXT) && text.trim() !== "" && font !== undefined && isFiniteIn(size, 1, MAX_FONT_SIZE)
				? { ...placement, text, font, size, color }
				: null
		},
		run: (context, args) => {
			const { page, box } = placeOn(context, args)

			addFillText(page, {
				box,
				text: args.text,
				font: args.font,
				size: args.size,
				color: args.color,
				author: args.author,
				date: context.now()
			})

			return [args.page]
		}
	},
	"fillSign.mark": {
		tool: "annotate",
		parse: args => {
			const placement = parsePlacement(args)
			const color = isRecord(args) ? parseColor(args["color"]) : null
			const mark = isRecord(args) ? MARKS.find(candidate => candidate === args["mark"]) : undefined

			return placement === null || color === null || mark === undefined ? null : { ...placement, mark, color }
		},
		run: (context, args) => {
			const { page, box } = placeOn(context, args)

			addFillMark(page, { box, mark: args.mark, color: args.color, author: args.author, date: context.now() })

			return [args.page]
		}
	},
	"fillSign.signature": {
		tool: "sign",
		parse: args => {
			const placement = parsePlacement(args)

			if (placement === null || !isRecord(args)) return null

			const role = args["role"] === "signature" || args["role"] === "initials" ? args["role"] : null
			const signature = parseSignature(args["signature"])

			return role === null || signature === null ? null : { ...placement, role, signature }
		},
		bytes: ({ signature }) => (signature.kind === "image" ? signature.png.byteLength : 0),
		run: (context, args) => {
			const { page, box } = placeOn(context, args)

			placeVisualSignature(context.mupdf, page, args.signature, { box, role: args.role, author: args.author, date: context.now() })

			return [args.page]
		}
	}
}
