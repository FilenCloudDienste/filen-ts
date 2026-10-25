import type { PdfDocument } from "./types"

// The document's bookmarks (pdf.js getOutline) flattened in reading order for a menu, and its Info dictionary
// (getMetadata) reduced to what a properties dialog shows. Each is one worker round trip, read once per open
// document and kept with it.

export interface PdfOutlineItem {
	readonly title: string
	// 0 for a top-level bookmark.
	readonly depth: number
	// Where it leads (resolveDestination), or null for a heading that only groups others.
	readonly dest: string | readonly unknown[] | null
}

// A menu never holds more; deeper levels are left out (both bound a hostile or generated outline).
export const PDF_OUTLINE_LIMIT = 1000
export const PDF_OUTLINE_MAX_DEPTH = 6

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null
}

// Control characters and runs of whitespace (producers pad titles with both) collapse to one space.
function cleanText(value: unknown): string {
	if (typeof value !== "string") return ""

	let out = ""

	for (const char of value) {
		const code = char.codePointAt(0) ?? 0

		out += code < 0x20 || code === 0x7f ? " " : char
	}

	return out.replace(/\s+/g, " ").trim()
}

function destOf(value: unknown): string | readonly unknown[] | null {
	if (typeof value === "string" && value.length > 0) return value
	if (Array.isArray(value) && value.length > 0) return value as readonly unknown[]

	return null
}

export function pdfOutline(raw: readonly unknown[] | null): PdfOutlineItem[] {
	const items: PdfOutlineItem[] = []

	const walk = (nodes: readonly unknown[], depth: number): void => {
		for (const node of nodes) {
			if (items.length >= PDF_OUTLINE_LIMIT) return
			if (!isRecord(node)) continue

			const title = cleanText(node["title"])
			const children: readonly unknown[] = Array.isArray(node["items"]) ? (node["items"] as readonly unknown[]) : []
			const dest = destOf(node["dest"])
			const grouping = children.length > 0 && depth + 1 < PDF_OUTLINE_MAX_DEPTH

			// Nothing to show or follow (a bookmark to a URL leads out of the document).
			if (title.length === 0 || (dest === null && !grouping)) continue

			items.push({ title, depth, dest })

			if (grouping) walk(children, depth + 1)
		}
	}

	if (raw !== null) walk(raw, 0)

	return items
}

export interface PdfDocumentInfo {
	readonly title: string | null
	readonly author: string | null
	readonly subject: string | null
	readonly keywords: string | null
	readonly creator: string | null
	readonly producer: string | null
	readonly created: Date | null
	readonly modified: Date | null
	// The header's version ("1.7").
	readonly version: string | null
}

function infoText(info: Readonly<Record<string, unknown>>, key: string): string | null {
	const text = cleanText(info[key])

	return text.length > 0 ? text : null
}

const PDF_DATE = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/

// A PDF date (PDF 32000-1 §7.9.4: D:YYYYMMDDHHmmSSOHH'mm', everything after the year optional), or null.
export function parsePdfDate(value: unknown): Date | null {
	if (typeof value !== "string") return null

	const match = PDF_DATE.exec(value.trim())

	if (match === null) return null

	const part = (index: number, fallback: number): number => {
		const text = match[index]

		return text === undefined ? fallback : Number(text)
	}
	const month = part(2, 1)
	const day = part(3, 1)
	const hour = part(4, 0)
	const minute = part(5, 0)
	const second = part(6, 0)

	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null

	const sign = match[7] === "-" ? -1 : match[7] === "+" ? 1 : 0
	const offset = sign * (part(8, 0) * 60 + part(9, 0))

	return new Date(Date.UTC(part(1, 0), month - 1, day, hour, minute, second) - offset * 60_000)
}

export function pdfDocumentInfo(info: unknown): PdfDocumentInfo {
	const record = isRecord(info) ? info : {}

	return {
		title: infoText(record, "Title"),
		author: infoText(record, "Author"),
		subject: infoText(record, "Subject"),
		keywords: infoText(record, "Keywords"),
		creator: infoText(record, "Creator"),
		producer: infoText(record, "Producer"),
		created: parsePdfDate(record["CreationDate"]),
		modified: parsePdfDate(record["ModDate"]),
		version: infoText(record, "PDFFormatVersion")
	}
}

const outlines = new WeakMap<PdfDocument, Promise<PdfOutlineItem[]>>()
const infos = new WeakMap<PdfDocument, Promise<PdfDocumentInfo>>()

// Read once per document; a failed read is an empty outline (the viewer then offers none).
export function loadPdfOutline(document: PdfDocument): Promise<PdfOutlineItem[]> {
	let loading = outlines.get(document)

	if (loading === undefined) {
		loading = document.getOutline().then(pdfOutline, () => [])
		outlines.set(document, loading)
	}

	return loading
}

export function loadPdfInfo(document: PdfDocument): Promise<PdfDocumentInfo> {
	let loading = infos.get(document)

	if (loading === undefined) {
		loading = document.getMetadata().then(
			metadata => pdfDocumentInfo(metadata.info),
			() => pdfDocumentInfo(null)
		)
		infos.set(document, loading)
	}

	return loading
}
