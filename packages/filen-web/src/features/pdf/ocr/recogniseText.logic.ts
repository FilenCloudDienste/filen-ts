import { pageRangesPages, parsePageRanges } from "@filen/office/core/pdfedit/pageRanges"
import type { OcrPageOutcome } from "@filen/office/dom/pdfedit/ocr"

// The Recognise text dialog's state: which pages it recognises, and each page's progress through a run.

export interface OcrPagesForm {
	readonly pages: "all" | "range"
	readonly range: string
}

export const DEFAULT_OCR_PAGES_FORM: OcrPagesForm = { pages: "all", range: "" }

// The scanned pages (0-based) among those chosen, in page order; null when the typed range cannot be read.
export function ocrChosenPages(form: OcrPagesForm, pageCount: number, scanned: readonly number[]): number[] | null {
	if (form.pages === "all") return [...scanned].sort((a, b) => a - b)

	const parsed = parsePageRanges(form.range, pageCount)

	if (!parsed.ok) return null

	const chosen = new Set<number>()

	for (const page of pageRangesPages(parsed.ranges)) chosen.add(page - 1)

	return scanned.filter(page => chosen.has(page)).sort((a, b) => a - b)
}

export interface OcrPageState {
	// 0-based.
	readonly page: number
	readonly status: "waiting" | "working" | "done" | "failed"
	readonly words: number
}

export type OcrDialogRun =
	| { readonly phase: "downloading"; readonly loaded: number; readonly total: number }
	| { readonly phase: "recognising"; readonly pages: readonly OcrPageState[] }
	| { readonly phase: "finished"; readonly pages: readonly OcrPageState[]; readonly cancelled: boolean }
	| { readonly phase: "modelsFailed" }

export function waitingPages(pages: readonly number[]): OcrPageState[] {
	return pages.map(page => ({ page, status: "waiting", words: 0 }))
}

// One pipeline event (a page started: null outcome; or settled) applied to the page list.
export function updatePageState(pages: readonly OcrPageState[], page: number, outcome: OcrPageOutcome | null): OcrPageState[] {
	return pages.map(state => {
		if (state.page !== page) return state
		if (outcome === null) return { ...state, status: "working" }

		return outcome.status === "done" ? { page, status: "done", words: outcome.words } : { page, status: "failed", words: 0 }
	})
}

export function settledCount(pages: readonly OcrPageState[]): number {
	return pages.filter(state => state.status === "done" || state.status === "failed").length
}
