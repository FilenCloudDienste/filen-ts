import {
	quadBounds,
	rectsOverlap,
	type RedactionFailure,
	type RedactionFinding,
	type RedactionMark,
	type RedactionPlace,
	type RedactionPreset,
	type RedactionTerm,
	type RedactRect
} from "@filen/office/core/pdfedit/redactVerify"
import { editedCopyName } from "@/features/drive/lib/copyName"
import type { previewPdfRedaction } from "@/locales/en/previewPdf/redaction"

// Pure rules of the redaction UI: the copy's name, the failure reason's wording, the labels of marks, and the Find
// & redact form's terms and query.

type RedactionKey = keyof typeof previewPdfRedaction

// Where a redacted file goes: a copy beside the original by default, or a new version of this file.
export type RedactionDestination = { readonly kind: "copy"; readonly name: string } | { readonly kind: "inPlace" }

export type RedactMode = "area" | "text" | "find"

// "report.pdf" → "report (redacted).pdf", then "report (redacted 2).pdf"… skipping names in `taken` (lowercased).
// `suffix(n)` words the suffix ("redacted", "redacted 2").
export function redactedCopyName(original: string, suffix: (n: number) => string, taken: ReadonlySet<string>): string {
	return editedCopyName(original, "pdf", suffix, taken)
}

export interface Phrase {
	readonly key: RedactionKey
	readonly params: Readonly<Record<string, string | number>>
}

const TERM_PLACES: Readonly<Record<RedactionPlace, RedactionKey>> = {
	page: "previewPdfRedactReasonTermPage",
	annotation: "previewPdfRedactReasonTermAnnotation",
	field: "previewPdfRedactReasonTermField",
	bookmark: "previewPdfRedactReasonTermBookmark",
	metadata: "previewPdfRedactReasonTermMetadata",
	attachment: "previewPdfRedactReasonTermAttachment",
	tags: "previewPdfRedactReasonTermTags",
	file: "previewPdfRedactReasonTermFile"
}

const METADATA: Readonly<Record<Extract<RedactionFailure, { code: "metadata" }>["what"], RedactionKey>> = {
	info: "previewPdfRedactReasonInfo",
	xmp: "previewPdfRedactReasonXmp",
	attachments: "previewPdfRedactReasonAttachments",
	scripts: "previewPdfRedactReasonScripts",
	pieceInfo: "previewPdfRedactReasonPieceInfo"
}

// The {{reason}} of "The redacted file didn't pass the check, so it wasn't saved: {{reason}}."
export function failureReason(failure: RedactionFailure): Phrase {
	switch (failure.code) {
		case "revisions":
			return { key: "previewPdfRedactReasonRevisions", params: {} }
		case "text":
			return { key: "previewPdfRedactReasonText", params: { page: failure.page } }
		case "image":
			return { key: "previewPdfRedactReasonImage", params: { page: failure.page } }
		case "drawing":
			return { key: "previewPdfRedactReasonDrawing", params: { page: failure.page } }
		case "term":
			return {
				key: failure.place === "page" && failure.page === undefined ? "previewPdfRedactReasonTermFile" : TERM_PLACES[failure.place],
				params: { term: failure.term, page: failure.page ?? 0 }
			}
		case "metadata":
			return { key: METADATA[failure.what], params: {} }
		case "hiddenData":
			return { key: "previewPdfRedactReasonHiddenData", params: {} }
		case "unreadable":
			return { key: "previewPdfRedactReasonUnreadable", params: { page: failure.page } }
	}
}

// How a mark reads in the review list; `text` is the marked text when the caller knows it.
export function markLabel(mark: RedactionMark, text: string | undefined): Phrase {
	if (mark.kind === "page") return { key: "previewPdfRedactMarkPage", params: {} }
	if (mark.kind === "area") return { key: "previewPdfRedactMarkArea", params: {} }

	return text === undefined || text.trim().length === 0
		? { key: "previewPdfRedactMarkTextUnknown", params: {} }
		: { key: "previewPdfRedactMarkText", params: { text: text.length > 60 ? `${text.slice(0, 59)}…` : text } }
}

// The terms with a typed one added: trimmed, ignored when empty or already there (compared as typed).
export function addTerm(terms: readonly string[], typed: string): readonly string[] {
	const term = typed.trim()

	return term.length === 0 || terms.includes(term) ? terms : [...terms, term]
}

export interface FindRedactForm {
	readonly terms: readonly string[]
	readonly matchCase: boolean
	readonly wholeWord: boolean
	readonly presets: readonly RedactionPreset[]
}

export const DEFAULT_FIND_FORM: FindRedactForm = { terms: [], matchCase: false, wholeWord: false, presets: [] }

export function findQuery(form: FindRedactForm): {
	readonly terms: readonly RedactionTerm[]
	readonly presets: readonly RedactionPreset[]
} {
	return {
		terms: form.terms.map(text => ({ text, matchCase: form.matchCase, wholeWord: form.wholeWord })),
		presets: form.presets
	}
}

export function canSearch(form: FindRedactForm): boolean {
	return form.terms.length > 0 || form.presets.length > 0
}

export function togglePreset(presets: readonly RedactionPreset[], preset: RedactionPreset, on: boolean): readonly RedactionPreset[] {
	const without = presets.filter(item => item !== preset)

	return on ? [...without, preset] : without
}

// The selected findings, in document order.
export function selectedFindings(findings: readonly RedactionFinding[], selected: ReadonlySet<string>): RedactionFinding[] {
	return findings.filter(finding => selected.has(finding.id))
}

// The findings a pending text mark still covers (by id): a finding counts as marked while every one of its quads
// overlaps a text mark's quad on its page. A mark removed from the review list since leaves its finding unmarked.
export function markedFindings(findings: readonly RedactionFinding[], marks: readonly RedactionMark[]): ReadonlySet<string> {
	const byPage = new Map<number, RedactRect[]>()

	for (const mark of marks) {
		if (mark.kind !== "text") continue

		const rects = byPage.get(mark.page) ?? []

		for (const quad of mark.quads) rects.push(quadBounds(quad))

		byPage.set(mark.page, rects)
	}

	const marked = new Set<string>()

	for (const finding of findings) {
		const rects = byPage.get(finding.page)

		if (
			rects !== undefined &&
			finding.quads.length > 0 &&
			finding.quads.every(quad => rects.some(rect => rectsOverlap(rect, quadBounds(quad))))
		)
			marked.add(finding.id)
	}

	return marked
}

// The pages with pending marks, in order (each is one Apply step).
export function markedPages(marks: readonly RedactionMark[]): number[] {
	return [...new Set(marks.map(mark => mark.page))].sort((a, b) => a - b)
}

// The error a save throws when the written file failed the redaction check (save/pdfSave.ts PdfRedactionRefusedError),
// told by its name so this module stays free of the save pipeline.
export function isRedactionRefusal(error: unknown): error is Error & { readonly failure: RedactionFailure } {
	return error instanceof Error && error.name === "PdfRedactionRefusedError" && "failure" in error
}
