import type * as Mupdf from "mupdf"
import type { RedactionManifest, RedactionQuery } from "../../core/pdfedit/redactVerify"
import type { PdfAllowed, PdfSecurityChoice } from "../../core/pdfedit/security"
import { isIndex, isRecord, isText } from "./commands/types"
import { isRedactionPresets, isRedactionTerms } from "./commands/redact"
import { PdfEngineRefusal, type OpenDocument, type PdfEngineContext } from "./context"
import type { PdfEditSession } from "./editSession"
import type { PdfTextGeometryLine } from "./protocol"
import { findRedactions } from "./redact/find"
import { pageRedactionMarks } from "./redact/marks"
import { verifyRedactedPdf } from "./redact/verify"
import type { PdfRequestHandler } from "./requests"
import { planDocumentSecurity, unlockOwner } from "./security/index"

// The Protect tab's requests: reading redaction marks, Find & redact's search, the text geometry the text mark tool
// selects on, the protection the next save writes, and unlocking owner rights. Changes to the document itself are
// commands (commands/redact.ts); the protection is applied by the save (editRequests.ts saveBegin).

type ProtectOp = "redactMarks" | "redactFind" | "textGeometry" | "securitySet" | "securityUnlock"

const MAX_PASSWORD = 1024

function editing(context: PdfEngineContext): OpenDocument & { readonly edit: PdfEditSession } {
	const open = context.open()

	if (open.edit === null) throw new PdfEngineRefusal("badRequest", "the document is not open for editing")
	if (open.edit.output !== null) throw new PdfEngineRefusal("badRequest", "a save is under way")

	return { ...open, edit: open.edit }
}

function pageIndex(document: Mupdf.PDFDocument, page: unknown): number {
	if (typeof page !== "number" || !Number.isInteger(page) || page < 0 || page >= document.countPages())
		throw new PdfEngineRefusal("badRequest", "no such page")

	return page
}

function isPassword(value: unknown): value is string {
	return isText(value, MAX_PASSWORD)
}

function isAllowed(value: unknown): value is PdfAllowed {
	return (
		isRecord(value) && typeof value["print"] === "boolean" && typeof value["copy"] === "boolean" && typeof value["change"] === "boolean"
	)
}

// A Protect dialog choice as it crossed from the page, or null when malformed.
export function parseSecurityChoice(value: unknown): PdfSecurityChoice | null {
	if (!isRecord(value)) return null

	switch (value["kind"]) {
		case "keep":
		case "upgrade":
		case "remove":
			return { kind: value["kind"] }
		case "open":
			return isPassword(value["password"]) ? { kind: "open", password: value["password"] } : null
		case "restrict": {
			const open = value["openPassword"]

			return isPassword(value["ownerPassword"]) && (open === null || isPassword(open)) && isAllowed(value["allowed"])
				? {
						kind: "restrict",
						ownerPassword: value["ownerPassword"],
						openPassword: open,
						allowed: { print: value["allowed"].print, copy: value["allowed"].copy, change: value["allowed"].change }
					}
				: null
		}
		default:
			return null
	}
}

function parseQuery(value: unknown): RedactionQuery | null {
	return isRecord(value) && isRedactionTerms(value["terms"]) && isRedactionPresets(value["presets"])
		? { terms: value["terms"], presets: value["presets"] }
		: null
}

// The text lines of a page with their characters' edges (left to right), from its structured text.
export function pageTextGeometry(page: Mupdf.PDFPage): PdfTextGeometryLine[] {
	const stext = page.toStructuredText("")
	const lines: PdfTextGeometryLine[] = []
	let edges: number[] = []
	let rect: [number, number, number, number] | null = null
	const end = (): void => {
		if (rect !== null && edges.length > 1) lines.push({ rect, edges })

		edges = []
		rect = null
	}

	stext.walk({
		beginLine: () => {
			end()
		},
		onChar: (_char, _origin, _font, _size, quad) => {
			const x0 = Math.min(quad[0], quad[2], quad[4], quad[6])
			const x1 = Math.max(quad[0], quad[2], quad[4], quad[6])
			const y0 = Math.min(quad[1], quad[3], quad[5], quad[7])
			const y1 = Math.max(quad[1], quad[3], quad[5], quad[7])

			if (rect === null) {
				rect = [x0, y0, x1, y1]
				edges.push(x0)
			} else rect = [Math.min(rect[0], x0), Math.min(rect[1], y0), Math.max(rect[2], x1), Math.max(rect[3], y1)]

			// Edges stay ascending: a character drawn left of the last (right-to-left runs) adds none.
			edges.push(Math.max(x1, edges[edges.length - 1] ?? x1))
		},
		endLine: () => {
			end()
		}
	})
	end()
	stext.destroy()

	return lines
}

type Handlers = { readonly [K in ProtectOp]: PdfRequestHandler<K> }

export const PROTECT_REQUESTS: Handlers = {
	redactMarks: (context, { pages }) => {
		const { document } = editing(context)
		const indices = pages === undefined ? Array.from({ length: document.countPages() }, (_, index) => index) : pages

		return {
			value: indices.flatMap(index => {
				const page = document.loadPage(pageIndex(document, index))
				const marks = pageRedactionMarks(page, index)

				page.destroy()

				return marks
			})
		}
	},
	redactFind: (context, { query }) => {
		const { document } = editing(context)
		const parsed = parseQuery(query)

		if (parsed === null) throw new PdfEngineRefusal("badRequest", "malformed query")

		return { value: findRedactions(document, parsed) }
	},
	textGeometry: (context, { page }) => {
		const { document } = context.open()
		const loaded = document.loadPage(pageIndex(document, page))

		try {
			return { value: pageTextGeometry(loaded) }
		} finally {
			loaded.destroy()
		}
	},
	securitySet: (context, { choice }) => {
		const { document, edit } = editing(context)

		if (choice === null) {
			edit.protect(null)

			return { value: { ok: true, state: edit.snapshot(document) } }
		}

		const parsed = parseSecurityChoice(choice)

		if (parsed === null) throw new PdfEngineRefusal("badRequest", "malformed protection")

		const plan = planDocumentSecurity(document, edit.held, parsed)

		if (!plan.ok) return { value: { ok: false, reason: plan.reason } }

		const { options } = plan

		edit.protect(plan.changes && options.encrypt !== "keep" ? { choice: parsed, options } : null)

		return { value: { ok: true, state: edit.snapshot(document) } }
	},
	securityUnlock: (context, { password }) => {
		const { document, edit } = editing(context)

		if (!isPassword(password)) throw new PdfEngineRefusal("badRequest", "malformed password")

		const held = unlockOwner(document, password, edit.held)

		if (held === null) return { value: { ok: false } }

		edit.unlocked(held)

		return { value: { ok: true, state: edit.snapshot(document) } }
	}
}

function isRegion(value: unknown): boolean {
	if (!isRecord(value)) return false

	const rect: unknown = value["rect"]

	return (
		isIndex(value["page"]) &&
		(value["kind"] === "text" || value["kind"] === "area" || value["kind"] === "page") &&
		Array.isArray(rect) &&
		rect.length === 4 &&
		rect.every(item => typeof item === "number" && Number.isFinite(item))
	)
}

function isManifest(value: unknown): value is RedactionManifest {
	return (
		isRecord(value) &&
		Array.isArray(value["regions"]) &&
		value["regions"].every(isRegion) &&
		isRedactionTerms(value["terms"]) &&
		(value["hidden"] === undefined || isRedactionTerms(value["hidden"])) &&
		typeof value["sanitized"] === "boolean" &&
		typeof value["annotationsRemoved"] === "boolean"
	)
}

// The verifying engine's check of a written redacted file (registered by the engine worker). It changes the document
// in memory (every layer on, every annotation shown), so the engine is closed after it.
export const verifyRedactionRequest: PdfRequestHandler<"verifyRedaction"> = (context, { manifest }) => {
	const { document, role } = context.open()

	if (role !== "verify") throw new PdfEngineRefusal("badRequest", "only a verifying engine checks a written file")
	if (!isManifest(manifest)) throw new PdfEngineRefusal("badRequest", "malformed manifest")

	return { value: verifyRedactedPdf(context.mupdf, document, manifest) }
}
