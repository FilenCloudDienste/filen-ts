import type { TFunction } from "i18next"
import {
	formatPageRanges,
	normalizePageRanges,
	parsePageRangeParts,
	parsePageRanges,
	type PageRange
} from "@filen/office/core/pdfedit/pageRanges"
import { extractGroups, splitBefore, splitEvery } from "@filen/office/core/pdfedit/pageOrder"

// The pages rail's selection, the screen reader's sentences after a page change, and the Extract and Split dialogs'
// plans, as pure functions. Pages are 0-based here, 1-based in ranges and in what people read.

// The selection after a click or key: Shift extends a range from the anchor (the current page), Ctrl/Cmd toggles.
export function extendSelection(selected: ReadonlySet<number>, anchor: number, index: number, mode: "range" | "toggle"): Set<number> {
	if (mode === "toggle") {
		const next = new Set(selected)

		next.add(anchor)

		if (next.has(index) && index !== anchor) next.delete(index)
		else next.add(index)

		return next
	}

	const next = new Set<number>()

	for (let page = Math.min(anchor, index); page <= Math.max(anchor, index); page++) next.add(page)

	return next
}

// Space on the current page: in or out of the selection.
export function toggleSelection(selected: ReadonlySet<number>, index: number): Set<number> {
	const next = new Set(selected)

	if (next.has(index)) next.delete(index)
	else next.add(index)

	return next
}

export function selectAll(count: number): Set<number> {
	return new Set(Array.from({ length: Math.max(0, count) }, (_, index) => index))
}

// The pages an action applies to: the selection, or the current page when nothing else is selected.
export function actionPages(selected: ReadonlySet<number>, current: number): number[] {
	return selected.size > 0 ? [...selected].sort((a, b) => a - b) : [current]
}

// The selection after a reorder: the same pages where they now stand (`from`: per new page, its old index or -1).
export function remapSelection(selected: ReadonlySet<number>, from: readonly number[]): Set<number> {
	const next = new Set<number>()

	from.forEach((old, index) => {
		if (old >= 0 && selected.has(old)) next.add(index)
	})

	return next
}

export type PageChange =
	| { readonly kind: "moved"; readonly pages: readonly number[]; readonly position: number }
	| { readonly kind: "rotated" | "deleted" | "duplicated"; readonly pages: readonly number[] }
	| { readonly kind: "inserted"; readonly count: number; readonly position: number }

// What the live region says after a change ("Page 3 moved to position 2"); positions and pages read 1-based.
export function pageChangeAnnouncement(t: TFunction<"preview">, change: PageChange): string {
	if (change.kind === "inserted") return t("previewPdfPagesInserted", { count: change.count, position: change.position + 1 })

	const count = change.pages.length
	const page = (change.pages[0] ?? 0) + 1

	switch (change.kind) {
		case "moved":
			return t("previewPdfPagesMoved", { count, page, position: change.position + 1 })
		case "rotated":
			return t("previewPdfPagesRotated", { count, page })
		case "deleted":
			return t("previewPdfPagesDeleted", { count, page })
		case "duplicated":
			return t("previewPdfPagesDuplicated", { count, page })
	}
}

// The selection as ranges text ("2-4, 7"), 1-based.
export function selectionText(pages: Iterable<number>): string {
	return formatPageRanges(normalizePageRanges([...pages].map(page => ({ first: page + 1, last: page + 1 }))))
}

export type ExtractSource = "selected" | "range"

export interface ExtractForm {
	readonly source: ExtractSource
	readonly range: string
	readonly separate: boolean
	readonly deleteAfter: boolean
	readonly protect: boolean
}

export function defaultExtractForm(hasSelection: boolean): ExtractForm {
	return { source: hasSelection ? "selected" : "range", range: "", separate: false, deleteAfter: false, protect: true }
}

export interface ExtractPlan {
	// The files to make, each its ranges (1-based).
	readonly files: readonly (readonly PageRange[])[]
	// The 0-based pages to delete afterwards (empty when not deleting).
	readonly deletes: readonly number[]
	// Every page is chosen: deleting them all is refused.
	readonly coversAll: boolean
}

// What extracting does with this form, or null when the typed pages cannot be read.
export function extractPlan(form: ExtractForm, count: number, selected: readonly number[]): ExtractPlan | null {
	const parsed =
		form.source === "selected"
			? selected.length === 0
				? null
				: normalizePageRanges(selected.map(page => ({ first: page + 1, last: page + 1 })))
			: (() => {
					const result = parsePageRanges(form.range, count)

					return result.ok ? result.ranges : null
				})()

	if (parsed === null || parsed.length === 0) return null

	const total = parsed.reduce((sum, range) => sum + range.last - range.first + 1, 0)
	const coversAll = total >= count
	const deletes: number[] = []

	if (form.deleteAfter && !coversAll) {
		for (const range of parsed) for (let page = range.first; page <= range.last; page++) deletes.push(page - 1)
	}

	return { files: extractGroups(parsed, form.separate), deletes, coversAll }
}

export type SplitMode = "count" | "selection" | "bookmarks" | "ranges"

export interface SplitForm {
	readonly mode: SplitMode
	readonly size: string
	readonly ranges: string
	readonly protect: boolean
}

export function defaultSplitForm(): SplitForm {
	return { mode: "count", size: "1", ranges: "", protect: true }
}

// The parts a split makes (1-based ranges, one file each), or null when the form cannot make any. `bookmarks` holds
// the 0-based first page of each top-level bookmark.
export function splitPlan(form: SplitForm, count: number, selected: readonly number[], bookmarks: readonly number[]): PageRange[] | null {
	switch (form.mode) {
		case "count": {
			const size = Number(form.size)

			return Number.isInteger(size) && size >= 1 && size <= count ? splitEvery(count, size) : null
		}
		case "selection":
			return selected.length === 0
				? null
				: splitBefore(
						count,
						selected.map(page => page + 1)
					)
		case "bookmarks":
			return bookmarks.length === 0
				? null
				: splitBefore(
						count,
						bookmarks.map(page => page + 1)
					)
		case "ranges": {
			const parsed = parsePageRangeParts(form.ranges, count)

			return parsed.ok ? [...parsed.ranges] : null
		}
	}
}
