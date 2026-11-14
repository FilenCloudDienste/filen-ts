import type { PDFDocument } from "mupdf"
import { composeWriteOptions, isWriteOptionText, PDF_PERMISSIONS_ALL } from "../../../core/pdfedit/security"
import type { MupdfModule } from "../protocol"
import { copyPages } from "./copy"
import { at, catalog } from "./objects"
import { isTaggedPdf } from "./organise"

// New documents made from pages of an open one (extract, split): built from the source through one graft map each
// (copy.ts): form fields rebuilt with only the copied widgets, outline items kept for the copied pages, signed signature
// fields drawn into their pages as content (no dangling signature field), links to pages left behind dropped. Tags
// are not carried. The source is only read.

export interface ExtractedDocument {
	// A new document the caller saves (with extractSaveOptions) and destroys.
	readonly document: PDFDocument
	// Signed signature fields drawn as content.
	readonly flattenedSignatures: number
	// The source had accessibility tags, which the new document does not keep.
	readonly droppedTags: boolean
}

// A new document holding `pages` (0-based source indices, in order).
export function extractDocument(mupdf: MupdfModule, source: PDFDocument, pages: readonly number[]): ExtractedDocument {
	const count = source.countPages()

	if (pages.length === 0 || pages.some(page => !Number.isInteger(page) || page < 0 || page >= count)) {
		throw new RangeError("extractDocument: pages out of range")
	}

	const document = new mupdf.PDFDocument()

	try {
		const copied = copyPages(document, source, pages, 0, { scripts: "keep", outline: true })
		const language = source.getLanguage()

		if (language !== null && language.length > 0) document.setLanguage(language)

		return { document, flattenedSignatures: copied.flattenedSignatures, droppedTags: isTaggedPdf(source) }
	} catch (error) {
		document.destroy()
		throw error
	}
}

// The passwords a new document is protected with. MuPDF does not reveal a document's passwords, so the caller passes
// the one the user opened it with (and the owner password when known), already prepared (SASLprep).
export interface CarriedPasswords {
	readonly user: string
	// Unknown (opened with the user password): the user password is used for both.
	readonly owner?: string
}

export type ExtractSaveOptions =
	// `options` go to saveToBuffer as they are: an object, which MuPDF reads as JSON, so passwords need no escaping.
	| { readonly ok: true; readonly options: Readonly<Record<string, string | number>>; readonly encrypted: boolean }
	// A password MuPDF's option parser would read back differently (a control character).
	| { readonly ok: false; readonly reason: "unsupportedPassword" }

const BASE_OPTIONS = "garbage=compact,compress,objstms"

// The write options for a document made from `source`: a full rewrite, encrypted like the source when it is (AES-256
// whatever the source used, its permissions kept) unless `protect` is false. Passwords reach MuPDF only through
// composeWriteOptions, never inside the comma-separated option string.
export function extractSaveOptions(source: PDFDocument, passwords: CarriedPasswords | null, protect = true): ExtractSaveOptions {
	const encrypt = at(source.getTrailer(), "Encrypt")

	if (!protect || !encrypt.isDictionary() || passwords === null)
		return { ok: true, options: composeWriteOptions(BASE_OPTIONS, { encrypt: "none" }), encrypted: false }

	const owner = passwords.owner ?? passwords.user

	if (!isWriteOptionText(passwords.user) || !isWriteOptionText(owner)) return { ok: false, reason: "unsupportedPassword" }

	const permissions = at(encrypt, "P")

	return {
		ok: true,
		options: composeWriteOptions(BASE_OPTIONS, {
			encrypt: "aes-256",
			"user-password": passwords.user,
			"owner-password": owner,
			permissions: permissions.isInteger() ? permissions.asNumber() | 0 : PDF_PERMISSIONS_ALL
		}),
		encrypted: true
	}
}

// The 0-based first page of each top-level bookmark, in outline order, for splitting by bookmarks (bookmarks going
// nowhere in this document skipped).
export function topLevelBookmarkPages(doc: PDFDocument): number[] {
	if (!at(catalog(doc), "Outlines").isDictionary()) return []

	const outline = doc.loadOutline() ?? []
	const pages: number[] = []

	for (const item of outline) {
		if (item.page !== undefined && item.page >= 0) pages.push(item.page)
	}

	return pages
}
