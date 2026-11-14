import { PdfEngineRefusal } from "../context"
import { applyAddText, applyTextEdit } from "../textEdit/apply"
import type { TextEditChar } from "../textEdit/target"
import { isIndex, isRecord, type PdfCommandTable } from "./types"

// Editing a page's text: a block's (or a selection's) glyphs replaced by new text, and new text added where there was
// none. The new text arrives laid out already (prepareTextEdit, an engine request made before the command: fonts load
// asynchronously, a command runs synchronously), as a one-page overlay PDF grafted over the page; null replaces with
// nothing. A replacement that would also remove a neighbouring glyph is abandoned whole (TEXT_EDIT_UNSAFE).

// The refusal's message when a replacement would remove more than its glyphs: the page says so (the "unsafe" notice).
export const TEXT_EDIT_UNSAFE = "textEdit.unsafe"

// Glyphs one replacement takes, and the overlay's size: far above a page's text, and what a page posts at most.
const MAX_CHARS = 100_000
const MAX_OVERLAY_BYTES = 32 * 1024 * 1024

export interface PdfTextEditCommands {
	"textEdit.replace": { readonly page: number; readonly chars: readonly TextEditChar[]; readonly overlay: Uint8Array | null }
	"textEdit.add": { readonly page: number; readonly overlay: Uint8Array }
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function parseChar(value: unknown): TextEditChar | null {
	if (!isRecord(value)) return null

	const { c, x, y, quad } = value

	if (typeof c !== "string" || c.length === 0 || c.length > 8 || !isNumber(x) || !isNumber(y)) return null
	if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(isNumber)) return null

	const [a = 0, b = 0, d = 0, e = 0, f = 0, g = 0, h = 0, k = 0] = quad as number[]

	return { c, x, y, quad: [a, b, d, e, f, g, h, k] }
}

function parseOverlay(value: unknown): Uint8Array | null {
	return value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= MAX_OVERLAY_BYTES ? value : null
}

function pageInRange(page: number, count: number): void {
	if (page >= count) throw new PdfEngineRefusal("badRequest", "no such page")
}

export const TEXT_EDIT_COMMANDS: PdfCommandTable<PdfTextEditCommands> = {
	"textEdit.replace": {
		tool: "content",
		// The replaced glyphs stay in the file's earlier versions.
		removesContent: true,
		parse: args => {
			if (!isRecord(args) || !isIndex(args["page"]) || !Array.isArray(args["chars"])) return null

			const list: unknown[] = args["chars"]

			if (list.length === 0 || list.length > MAX_CHARS) return null

			const chars: TextEditChar[] = []

			for (const value of list) {
				const char = parseChar(value)

				if (char === null) return null

				chars.push(char)
			}

			const overlay = args["overlay"] === null ? null : parseOverlay(args["overlay"])

			if (args["overlay"] !== null && overlay === null) return null

			return { page: args["page"], chars, overlay }
		},
		run: (context, args) => {
			pageInRange(args.page, context.document.countPages())

			const result = applyTextEdit(context.mupdf, context.document, args.page, args, args.overlay)

			if (result.status === "unsafe") throw new PdfEngineRefusal("notAllowed", TEXT_EDIT_UNSAFE)

			return result.pages
		}
	},
	"textEdit.add": {
		tool: "content",
		parse: args => {
			if (!isRecord(args) || !isIndex(args["page"])) return null

			const overlay = parseOverlay(args["overlay"])

			return overlay === null ? null : { page: args["page"], overlay }
		},
		run: (context, args) => {
			pageInRange(args.page, context.document.countPages())

			return applyAddText(context.mupdf, context.document, args.page, args.overlay).pages
		}
	}
}
