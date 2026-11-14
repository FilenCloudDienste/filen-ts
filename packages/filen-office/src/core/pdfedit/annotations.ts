// What the annotation engine (dom/pdfedit/annotations) reads and takes, as plain data a page can hold without MuPDF.
// Geometry is in MuPDF page space: points, origin at the top-left of the page's box, y growing downwards (the space
// `PDFPage.getBounds()` and the structured text use); a renderer maps it to pixels with one scale. Colours are RGB
// components in [0, 1]. Dates are epoch milliseconds, null when the file has none or an unreadable one.

export type PdfPoint = readonly [number, number]
// x0, y0, x1, y1 with x0 <= x1 and y0 <= y1.
export type PdfRect = readonly [number, number, number, number]
// Upper-left, upper-right, lower-left, lower-right corners (x, y each), as PDF QuadPoints and MuPDF quads order them.
export type PdfQuad = readonly [number, number, number, number, number, number, number, number]
export type PdfRgb = readonly [number, number, number]

export type PdfMarkupKind = "Highlight" | "Underline" | "StrikeOut" | "Squiggly"
export type PdfLineEnding =
	"None" | "Square" | "Circle" | "Diamond" | "OpenArrow" | "ClosedArrow" | "Butt" | "ROpenArrow" | "RClosedArrow" | "Slash"
export type PdfTextAlign = "left" | "center" | "right"
// The review states of the Review state model (ISO 32000-2 §12.5.6.4, table 172).
export type PdfReviewState = "None" | "Accepted" | "Rejected" | "Cancelled" | "Completed"
// The standard faces a FreeText default appearance can name without embedding a font.
export type PdfTextFont = "Helv" | "TiRo" | "Cour"

// An annotation within the open document: its page and its object number (stable for the session; undo and redo
// restore the same numbers, and a save never renumbers: savePlan.ts PDF_FULL_SAVE_OPTIONS).
export interface PdfAnnotationRef {
	readonly page: number
	readonly id: number
}

// What the select tool, the popover and the comments read of one annotation.
export interface PdfAnnotationInfo extends PdfAnnotationRef {
	// The PDF subtype ("FreeText", "Ink", "Highlight", …).
	readonly type: string
	readonly rect: PdfRect
	readonly color: PdfRgb | null
	readonly interiorColor: PdfRgb | null
	readonly opacity: number
	// Border or stroke width in points (0 where the type has none).
	readonly width: number
	readonly author: string
	readonly created: number | null
	readonly modified: number | null
	// The plain text (/Contents, or the rich text /RC reduced to plain text when /Contents is empty).
	readonly text: string
	// The annotation this one replies to (/IRT), when it is a reply or a review state.
	readonly replyTo: number | null
	// Whether the select tool may move/resize it, and how: "rect" (every rect-based type), "points" (ink, line: moved
	// by translating their points, resized by scaling them), null (widgets, links, popups, file attachments: never).
	readonly geometry: "rect" | "points" | null
	// Locked (/F bit 8) or read-only (/F bit 7): shown, never changed.
	readonly locked: boolean
}

// One comment of a thread: the annotation's own note or a reply.
export interface PdfComment {
	readonly id: number
	readonly author: string
	readonly text: string
	readonly created: number | null
	readonly modified: number | null
}

// A thread for the Comments panel: the annotation that carries it (any markup annotation with a note, or a sticky
// note), its replies in creation order, and the latest review state any reply set.
export interface PdfCommentThread {
	readonly page: number
	readonly root: PdfComment & { readonly type: string; readonly rect: PdfRect }
	readonly replies: readonly PdfComment[]
	readonly state: PdfReviewState
}

// A link annotation's target: an external URL the shared link policy (classifyLink) allows, as it normalised it; a
// page of the document; or none (refused, unparsable or unresolved). Nothing navigates in the engine.
export type PdfLinkTarget =
	{ readonly kind: "uri"; readonly uri: string } | { readonly kind: "page"; readonly page: number } | { readonly kind: "none" }

export interface PdfLinkInfo {
	readonly page: number
	readonly rect: PdfRect
	readonly target: PdfLinkTarget
}

// An embedded file, offered only as bytes to download (never opened inline). `source`: the document's EmbeddedFiles
// name tree, or a FileAttachment annotation (with its ref).
export interface PdfAttachmentInfo {
	readonly name: string
	readonly size: number | null
	readonly source: { readonly kind: "document"; readonly key: string } | { readonly kind: "annotation"; readonly ref: PdfAnnotationRef }
}

// Control (Cc), format (Cf: bidi overrides and isolates, zero-width joiners, soft hyphens, tag characters, …) and line or
// paragraph separator (Zl, Zp) characters: invisible, or able to reorder what a name shows ("invoice‮fdp.exe"
// reads as "invoiceexe.pdf").
const HIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

// An attachment's name as shown and offered for download: without the characters above, trimmed.
export function attachmentDisplayName(name: string): string {
	return name.replace(HIDDEN_NAME_CHARACTERS, "").trim()
}

// The standard stamp names (ISO 32000-2 §12.5.6.12) every viewer draws without an appearance of its own.
export const PDF_PRESET_STAMPS = [
	"Approved",
	"Experimental",
	"NotApproved",
	"AsIs",
	"Expired",
	"NotForPublicRelease",
	"Confidential",
	"Final",
	"Sold",
	"Departmental",
	"ForComment",
	"TopSecret",
	"Draft",
	"ForPublicRelease"
] as const

export type PdfPresetStamp = (typeof PDF_PRESET_STAMPS)[number]

export const PDF_REVIEW_STATES: readonly PdfReviewState[] = ["None", "Accepted", "Rejected", "Cancelled", "Completed"]

export function isReviewState(value: string): value is PdfReviewState {
	return (PDF_REVIEW_STATES as readonly string[]).includes(value)
}

export function normalizeRect(rect: readonly [number, number, number, number]): PdfRect {
	const [ax, ay, bx, by] = rect

	return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
}

export function translateRect(rect: PdfRect, dx: number, dy: number): PdfRect {
	return [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy]
}

// Maps a point inside `from` to the same relative place inside `to` (a resize of a points-based annotation). A
// degenerate side keeps its offset.
export function mapPoint(point: PdfPoint, from: PdfRect, to: PdfRect): PdfPoint {
	const width = from[2] - from[0]
	const height = from[3] - from[1]
	const x = width === 0 ? point[0] - from[0] + to[0] : to[0] + ((point[0] - from[0]) * (to[2] - to[0])) / width
	const y = height === 0 ? point[1] - from[1] + to[1] : to[1] + ((point[1] - from[1]) * (to[3] - to[1])) / height

	return [x, y]
}

// The bounding box of quads (a markup's rect).
export function boundsOfQuads(quads: readonly PdfQuad[]): PdfRect | null {
	if (quads.length === 0) return null

	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity

	for (const quad of quads) {
		for (let index = 0; index < 8; index += 2) {
			const x = quad[index] ?? 0
			const y = quad[index + 1] ?? 0

			x0 = Math.min(x0, x)
			y0 = Math.min(y0, y)
			x1 = Math.max(x1, x)
			y1 = Math.max(y1, y)
		}
	}

	return [x0, y0, x1, y1]
}

export function clamp01(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
}

// A colour as the annotation stores it: RGB kept, gray and CMYK converted (the naive CMYK to RGB of the DeviceCMYK
// fallback), none as null.
export function rgbOf(components: readonly number[]): PdfRgb | null {
	switch (components.length) {
		case 1: {
			const gray = clamp01(components[0] ?? 0)

			return [gray, gray, gray]
		}
		case 3:
			return [clamp01(components[0] ?? 0), clamp01(components[1] ?? 0), clamp01(components[2] ?? 0)]
		case 4: {
			const k = clamp01(components[3] ?? 0)

			return [
				(1 - clamp01(components[0] ?? 0)) * (1 - k),
				(1 - clamp01(components[1] ?? 0)) * (1 - k),
				(1 - clamp01(components[2] ?? 0)) * (1 - k)
			]
		}
		default:
			return null
	}
}

// "RRGGBB" for a colour, and back (the office colour grid speaks hex).
export function rgbToHex(rgb: PdfRgb): string {
	return rgb
		.map(component =>
			Math.round(clamp01(component) * 255)
				.toString(16)
				.padStart(2, "0")
		)
		.join("")
		.toUpperCase()
}

export function hexToRgb(hex: string): PdfRgb | null {
	const digits = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1]

	if (digits === undefined) return null

	const value = Number.parseInt(digits, 16)

	return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
// Elements whose end (or, for <br>, whose start) breaks a line in rich text (the XHTML subset of rich text strings).
const BREAKS = new Set(["p", "div", "br", "li"])
// Rich text longer than this is cut before it is read: a comment is never megabytes of markup.
const MAX_RICH_CHARS = 1 << 20

function codePoint(digits: string, radix: number): string {
	const code = Number.parseInt(digits, radix)

	return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""
}

function decodeEntity(name: string): string {
	if (name.startsWith("#x") || name.startsWith("#X")) return codePoint(name.slice(2), 16)
	if (name.startsWith("#")) return codePoint(name.slice(1), 10)

	return ENTITIES[name] ?? ""
}

// Rich text (/RC, XHTML) as plain text: tags dropped, block ends and <br> as line breaks, entities decoded. The result
// is shown as text only; nothing of the markup ever reaches a DOM as HTML.
export function richTextToPlain(rich: string): string {
	const source = rich.length > MAX_RICH_CHARS ? rich.slice(0, MAX_RICH_CHARS) : rich
	let out = ""
	let index = 0

	while (index < source.length) {
		const char = source.charAt(index)

		if (char === "<") {
			const end = source.indexOf(">", index + 1)

			if (end < 0) break

			const name = /^\/?\s*([a-zA-Z][\w:-]*)/
				.exec(source.slice(index + 1, end))?.[1]
				?.toLowerCase()
				.replace(/^.*:/, "")
			const closing = source.charAt(index + 1) === "/"

			if (name !== undefined && BREAKS.has(name) && (closing || name === "br") && out.length > 0 && !out.endsWith("\n")) out += "\n"

			index = end + 1
		} else if (char === "&") {
			const end = source.indexOf(";", index + 1)

			if (end < 0 || end - index > 12) {
				out += "&"
				index += 1
			} else {
				out += decodeEntity(source.slice(index + 1, end))
				index = end + 1
			}
		} else {
			out += char
			index += 1
		}
	}

	return out.replace(/\r\n?/g, "\n").replace(/\n+$/, "")
}
