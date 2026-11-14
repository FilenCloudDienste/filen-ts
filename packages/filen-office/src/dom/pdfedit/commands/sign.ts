import type * as Mupdf from "mupdf"
import { BYTE_RANGE_SENTINEL } from "../../../core/pdfsign/placeholder"
import { PdfEngineRefusal } from "../context"
import { addPdfSignatureField, PdfSignRefusal, type PdfSignaturePlacement, type PdfVisualSignatureInput } from "../sign"
import { isIndex, isRecord, isText, type PdfCommandTable } from "./types"

// Signing with a certificate, its first half: the signature field placed (a drawn rectangle, or an empty signature
// field of the form), its appearance and its /V dictionary with the placeholder (sign.ts addPdfSignatureField). The
// signature itself is made by the signing save that follows at once (signBegin), the last step of a save; until then
// the document holds a placeholder no plain save may write (pendingSignature).

// /Contents room: far above any certificate chain a signer worker reads (its container is at most 1 MiB).
const MAX_CAPACITY = 2 * 1024 * 1024
const MAX_TEXT = 1_000
const MAX_LINES = 8
const MAX_STROKES = 2_000
const MAX_POINTS = 200_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export interface PdfSignFieldArgs {
	readonly placement: PdfSignaturePlacement
	readonly visual: PdfVisualSignatureInput | null
	readonly lines: readonly string[]
	readonly name: string | null
	readonly reason: string | null
	readonly location: string | null
	// /M, the time the signer claims: milliseconds since the epoch.
	readonly time: number
	readonly certify: 1 | 2 | 3 | null
	readonly capacity: number
}

export interface PdfSignCommands {
	"sign.addField": PdfSignFieldArgs
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function optionalText(value: unknown): string | null | undefined {
	return value === null ? null : isText(value, MAX_TEXT) ? value : undefined
}

function parsePlacement(value: unknown): PdfSignaturePlacement | null {
	if (!isRecord(value)) return null

	if (value["kind"] === "field")
		return isText(value["name"], MAX_TEXT) && value["name"].length > 0 ? { kind: "field", name: value["name"] } : null

	const rect = value["rect"]

	if (value["kind"] !== "rect" || !isIndex(value["page"]) || !Array.isArray(rect) || rect.length !== 4) return null

	const [x0, y0, x1, y1] = rect as unknown[]

	if (!isNumber(x0) || !isNumber(y0) || !isNumber(x1) || !isNumber(y1) || !(x1 > x0) || !(y1 > y0)) return null

	return { kind: "rect", page: value["page"], rect: [x0, y0, x1, y1] }
}

function parseVisual(value: unknown): PdfVisualSignatureInput | null | undefined {
	if (value === null) return null
	if (!isRecord(value)) return undefined

	if (value["kind"] === "image") {
		const png = value["png"]

		return png instanceof Uint8Array && png.byteLength > 0 && png.byteLength <= MAX_IMAGE_BYTES ? { kind: "image", png } : undefined
	}

	const { width, height, lineWidth, color, strokes } = value

	if (value["kind"] !== "strokes" || !isNumber(width) || !isNumber(height) || !(width > 0) || !(height > 0) || !isNumber(lineWidth))
		return undefined
	if (!Array.isArray(color) || color.length !== 3 || !color.every(isNumber)) return undefined
	if (!Array.isArray(strokes) || strokes.length > MAX_STROKES) return undefined

	let points = 0
	const parsed: (readonly [number, number])[][] = []

	for (const stroke of strokes as unknown[]) {
		if (!Array.isArray(stroke)) return undefined

		const line: (readonly [number, number])[] = []

		for (const point of stroke as unknown[]) {
			if (!Array.isArray(point) || point.length !== 2 || !isNumber(point[0]) || !isNumber(point[1])) return undefined

			line.push([point[0], point[1]])
		}

		points += line.length

		if (points > MAX_POINTS) return undefined

		parsed.push(line)
	}

	const [r = 0, g = 0, b = 0] = color as number[]

	return { kind: "strokes", width, height, lineWidth, color: [r, g, b], strokes: parsed }
}

export function parseSignFieldArgs(args: unknown): PdfSignFieldArgs | null {
	if (!isRecord(args)) return null

	const placement = parsePlacement(args["placement"])
	const visual = parseVisual(args["visual"])
	const name = optionalText(args["name"])
	const reason = optionalText(args["reason"])
	const location = optionalText(args["location"])
	const lines = args["lines"]
	const { time, certify, capacity } = args

	if (placement === null || visual === undefined || name === undefined || reason === undefined || location === undefined) return null
	if (!Array.isArray(lines) || lines.length > MAX_LINES || !lines.every((line: unknown) => isText(line, MAX_TEXT))) return null
	if (!isNumber(time) || !(certify === null || certify === 1 || certify === 2 || certify === 3)) return null
	if (!isNumber(capacity) || !Number.isSafeInteger(capacity) || capacity <= 0 || capacity > MAX_CAPACITY) return null

	return { placement, visual, lines: lines as string[], name, reason, location, time, certify, capacity }
}

export const SIGN_COMMANDS: PdfCommandTable<PdfSignCommands> = {
	"sign.addField": {
		tool: "sign",
		parse: parseSignFieldArgs,
		run: (context, args) => {
			try {
				return addPdfSignatureField(context.mupdf, context.document, { ...args, time: new Date(args.time) }).pages
			} catch (error) {
				if (error instanceof PdfSignRefusal) throw new PdfEngineRefusal("notAllowed", `sign.${error.reason}`)

				throw error
			}
		}
	}
}

// The placeholder signature a sign.addField step left unsigned, if any: its field's object, its /V's object number.
export interface PendingSignature {
	readonly signatureNum: number
	readonly field: string
}

function isPlaceholder(value: Mupdf.PDFObject): boolean {
	const range = value.get("ByteRange")
	const resolved = range.isIndirect() ? range.resolve() : range

	// Compared as written: MuPDF reads a number this large back through a 32-bit float.
	return resolved.isArray() && resolved.length === 4 && resolved.get(1).toString() === String(BYTE_RANGE_SENTINEL)
}

// Walks the form's signature fields for one whose /V still holds the sentinels (never signed).
export function pendingSignature(document: Mupdf.PDFDocument): PendingSignature | null {
	const fields = document.getTrailer().get("Root", "AcroForm", "Fields")
	const list = fields.isIndirect() ? fields.resolve() : fields
	const seen = new Set<number>()
	let found: PendingSignature | null = null

	const visit = (field: Mupdf.PDFObject, parent: string | null, depth: number): void => {
		if (found !== null || depth > 32) return

		if (field.isIndirect()) {
			if (seen.has(field.asIndirect())) return

			seen.add(field.asIndirect())
		}

		const dict = field.isIndirect() ? field.resolve() : field

		if (!dict.isDictionary()) return

		const partial = dict.get("T")
		const name = partial.isString() ? (parent === null ? partial.asString() : `${parent}.${partial.asString()}`) : parent
		const value = dict.get("V")

		if (value.isIndirect() && value.resolve().isDictionary() && isPlaceholder(value.resolve()) && name !== null) {
			found = { signatureNum: value.asIndirect(), field: name }

			return
		}

		const kids = dict.get("Kids")

		if (kids.isArray()) for (let index = 0; index < kids.length; index++) visit(kids.get(index), name, depth + 1)
	}

	if (list.isArray()) for (let index = 0; index < list.length; index++) visit(list.get(index), null, 0)

	return found
}
