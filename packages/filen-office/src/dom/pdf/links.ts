import { classifyLink } from "@filen/shared/linkPolicy"
import type { PdfDocument } from "./types"

// A page's Link annotations reduced to what a viewer renders: the rectangle in PDF space and either an external
// URL the shared link policy allows or an in-document destination. pdf.js's own link service is never used:
// it assigns hrefs for schemes the policy refuses. Everything else (javascript: and data: URIs, launch, named
// and attachment actions, a URL with no host) is dropped before it reaches the DOM.

export type PdfRect = readonly [number, number, number, number]

export type PdfLink =
	| { readonly kind: "external"; readonly rect: PdfRect; readonly url: string }
	// A named destination (string) or an explicit one (an array whose first item is a page reference).
	| { readonly kind: "internal"; readonly rect: PdfRect; readonly dest: string | readonly unknown[] }

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null
}

function asRect(value: unknown): PdfRect | null {
	const rect: readonly unknown[] | null = Array.isArray(value) ? (value as readonly unknown[]) : null

	if (rect?.length !== 4) return null

	const [x1, y1, x2, y2] = rect

	if (typeof x1 !== "number" || typeof y1 !== "number" || typeof x2 !== "number" || typeof y2 !== "number") return null
	if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return null

	return [x1, y1, x2, y2]
}

// A link target taken from a document, as a viewer may follow it: the URL the shared link policy allows (and `allow`
// too, which only ever narrows it), else null. Every engine's links pass here, so there is one gate.
export function pdfExternalLink(raw: unknown, allow?: (url: string) => boolean): string | null {
	if (typeof raw !== "string") return null

	const verdict = classifyLink(raw)

	return verdict.kind === "external" && (allow === undefined || allow(verdict.url)) ? verdict.url : null
}

// `allow` narrows the policy further (a host that must also parse the URL); it never widens it.
export function pdfLinks(annotations: readonly unknown[], allow?: (url: string) => boolean): PdfLink[] {
	const links: PdfLink[] = []

	for (const entry of annotations) {
		if (!isRecord(entry) || entry["subtype"] !== "Link") continue

		const rect = asRect(entry["rect"])

		if (rect === null) continue

		// pdf.js leaves `url` unset for schemes its own list lacks (sms:, geo:, ...); the raw value is judged by
		// the shared policy instead, which is the stricter of the two.
		const url = typeof entry["url"] === "string" ? entry["url"] : entry["unsafeUrl"]

		if (typeof url === "string") {
			const allowed = pdfExternalLink(url, allow)

			if (allowed !== null) links.push({ kind: "external", rect, url: allowed })

			continue
		}

		const dest = entry["dest"]

		if ((typeof dest === "string" && dest.length > 0) || (Array.isArray(dest) && dest.length > 0)) {
			links.push({ kind: "internal", rect, dest: dest as string | readonly unknown[] })
		}
	}

	return links
}

// Where a destination leads: its 1-based page and the point (PDF user space) to bring to the view's top-left
// corner. A null coordinate leaves that axis as it is (PDF 32000-1 §12.3.2.2, Table 151); the zoom a
// destination names is ignored, so the reader's own zoom stays.
export interface PdfDestination {
	readonly page: number
	readonly left: number | null
	readonly top: number | null
}

function coordinate(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null
}

// The view's [left, top] for an explicit destination's fit type (pdf.js gives the type as a { name } object).
function destinationPoint(explicit: readonly unknown[]): readonly [number | null, number | null] {
	const mode: unknown = explicit[1]
	const name = isRecord(mode) && typeof mode["name"] === "string" ? mode["name"] : null

	switch (name) {
		case "XYZ":
			return [coordinate(explicit[2]), coordinate(explicit[3])]
		case "FitH":
		case "FitBH":
			return [null, coordinate(explicit[2])]
		// [page /FitR left bottom right top]
		case "FitR":
			return [coordinate(explicit[2]), coordinate(explicit[5])]
		case "FitV":
		case "FitBV":
			return [coordinate(explicit[2]), null]
		default:
			return [null, null]
	}
}

// Null for a destination that points nowhere (a broken document).
export async function resolveDestination(document: PdfDocument, dest: string | readonly unknown[]): Promise<PdfDestination | null> {
	try {
		const explicit = typeof dest === "string" ? await document.getDestination(dest) : dest

		if (!Array.isArray(explicit)) return null

		const target: unknown = explicit[0]

		if (target === undefined || target === null) return null

		// A page index instead of a reference: some producers write one (PDF 32000-1 §12.3.2.2 allows it only
		// for remote go-to actions, pdf.js accepts it everywhere).
		const index = typeof target === "number" ? target : await document.getPageIndex(target)

		if (!Number.isInteger(index) || index < 0 || index >= document.numPages) return null

		const [left, top] = destinationPoint(explicit)

		return { page: index + 1, left, top }
	} catch {
		return null
	}
}
