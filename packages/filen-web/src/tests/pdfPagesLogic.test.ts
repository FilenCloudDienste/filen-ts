import { describe, expect, it, vi } from "vitest"
import type { TFunction } from "i18next"
import {
	actionPages,
	defaultExtractForm,
	defaultSplitForm,
	extendSelection,
	extractPlan,
	pageChangeAnnouncement,
	remapSelection,
	selectAll,
	selectionText,
	splitPlan,
	toggleSelection
} from "@/features/pdf/pages/organise.logic"
import { batchCopyNames, extractSuffix, partSuffix } from "@/features/pdf/pages/names"
import { PageThumbnails, thumbnailWindow, type ThumbnailBitmap } from "@/features/pdf/pages/thumbnails"
import { previewPdfPages } from "@/locales/en/previewPdf/pages"

// The pages rail's selection, its announcements, the Extract and Split plans, new files' names and the thumbnail
// window.

// The English catalog with i18next's interpolation and _one/_other plurals, enough for these strings.
const t = ((key: string, params: Record<string, unknown> = {}) => {
	const catalog: Record<string, string> = previewPdfPages
	const count = params["count"]
	const plural = typeof count === "number" ? catalog[`${key}_${count === 1 ? "one" : "other"}`] : undefined
	const text = plural ?? catalog[key] ?? key

	return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name]))
}) as unknown as TFunction<"preview">

describe("selection", () => {
	it("extends, toggles, selects all and picks what an action applies to", () => {
		expect([...extendSelection(new Set(), 2, 5, "range")]).toEqual([2, 3, 4, 5])
		expect([...extendSelection(new Set([7]), 2, 4, "toggle")].sort()).toEqual([2, 4, 7])
		expect([...extendSelection(new Set([2, 4]), 2, 4, "toggle")]).toEqual([2])
		expect([...toggleSelection(new Set([1]), 1)]).toEqual([])
		expect(selectAll(3).size).toBe(3)
		expect(actionPages(new Set(), 4)).toEqual([4])
		expect(actionPages(new Set([5, 1]), 4)).toEqual([1, 5])
		expect([...remapSelection(new Set([4, 5]), [0, 4, 5, 1, 2, 3])]).toEqual([1, 2])
		expect(selectionText([6, 1, 2, 3])).toBe("2-4, 7")
	})

	it("says what changed", () => {
		expect(pageChangeAnnouncement(t, { kind: "moved", pages: [2], position: 1 })).toBe("Page 3 moved to position 2")
		expect(pageChangeAnnouncement(t, { kind: "moved", pages: [4, 5], position: 1 })).toBe("2 pages moved to position 2")
		expect(pageChangeAnnouncement(t, { kind: "deleted", pages: [0] })).toBe("Page 1 deleted")
		expect(pageChangeAnnouncement(t, { kind: "inserted", count: 3, position: 4 })).toBe("3 pages inserted at position 5")
	})
})

describe("extract and split plans", () => {
	it("extracts the selection or typed pages, one file or one per page, deleting only when not every page goes", () => {
		const form = defaultExtractForm(true)

		expect(extractPlan(form, 10, [1, 2, 6])).toEqual({
			files: [
				[
					{ first: 2, last: 3 },
					{ first: 7, last: 7 }
				]
			],
			deletes: [],
			coversAll: false
		})
		expect(extractPlan({ ...form, source: "range", range: "9-", separate: true, deleteAfter: true }, 10, [])).toEqual({
			files: [[{ first: 9, last: 9 }], [{ first: 10, last: 10 }]],
			deletes: [8, 9],
			coversAll: false
		})
		expect(extractPlan({ ...form, source: "range", range: "1-", deleteAfter: true }, 3, [])?.deletes).toEqual([])
		expect(extractPlan({ ...form, source: "range", range: "x" }, 3, [])).toBeNull()
	})

	it("splits by count, selection, bookmarks or ranges", () => {
		const form = defaultSplitForm()

		expect(splitPlan({ ...form, size: "4" }, 10, [], [])).toHaveLength(3)
		expect(splitPlan({ ...form, size: "0" }, 10, [], [])).toBeNull()
		expect(splitPlan({ ...form, mode: "selection" }, 10, [3, 7], [])).toEqual([
			{ first: 1, last: 3 },
			{ first: 4, last: 7 },
			{ first: 8, last: 10 }
		])
		expect(splitPlan({ ...form, mode: "bookmarks" }, 10, [], [0, 5])).toEqual([
			{ first: 1, last: 5 },
			{ first: 6, last: 10 }
		])
		expect(splitPlan({ ...form, mode: "ranges", ranges: "5-6, 1-2" }, 10, [], [])).toEqual([
			{ first: 5, last: 6 },
			{ first: 1, last: 2 }
		])
	})
})

describe("new files' names", () => {
	it("names extracts and parts after the original, numbering a taken name", () => {
		const taken = new Set(["report (pages 3-5).pdf"])

		expect(batchCopyNames("report.pdf", [extractSuffix(t, [{ first: 3, last: 5 }])], taken)).toEqual(["report (pages 3-5 2).pdf"])
		expect(batchCopyNames("report.pdf", [extractSuffix(t, [{ first: 3, last: 3 }])], new Set())).toEqual(["report (page 3).pdf"])
		expect(batchCopyNames("Report.PDF", [partSuffix(t, 1), partSuffix(t, 2)], new Set(["report (part 1).pdf"]))).toEqual([
			"Report (part 1 2).pdf",
			"Report (part 2).pdf"
		])
	})
})

describe("thumbnail window", () => {
	function bitmap(): ThumbnailBitmap & { closed: boolean } {
		const made = { width: 96, height: 120, closed: false, close: () => undefined }

		made.close = () => {
			made.closed = true
		}

		return made
	}

	it("renders the window in order, one at a time, and keeps bitmaps for the window only", async () => {
		const made: (ThumbnailBitmap & { closed: boolean })[] = []
		const render = vi.fn((_page: number) => {
			const next = bitmap()

			made.push(next)

			return Promise.resolve(next)
		})
		const thumbnails = new PageThumbnails(render, () => undefined)

		thumbnails.setWindow(
			[
				{ id: "a", page: 0 },
				{ id: "b", page: 1 }
			],
			96
		)
		await vi.waitFor(() => {
			expect(thumbnails.get("b")).toBeDefined()
		})
		expect(render.mock.calls.map(call => call[0])).toEqual([0, 1])

		thumbnails.setWindow([{ id: "b", page: 0 }], 96)
		// "a" left the window: closed at once; "b" moved but keeps its bitmap.
		expect(made[0]?.closed).toBe(true)
		expect(thumbnails.get("a")).toBeUndefined()
		expect(thumbnails.get("b")).toBe(made[1])
		expect(render).toHaveBeenCalledTimes(2)

		thumbnails.invalidate(["b"])
		expect(made[1]?.closed).toBe(true)
		thumbnails.dispose()
	})

	it("aborts a render whose page left the window or moved", async () => {
		const signals: AbortSignal[] = []
		const thumbnails = new PageThumbnails(
			(_page, _width, signal) => {
				signals.push(signal)

				return new Promise<ThumbnailBitmap>((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						reject(new Error("aborted"))
					})
				})
			},
			() => undefined
		)

		thumbnails.setWindow([{ id: "a", page: 0 }], 96)
		thumbnails.setWindow([{ id: "a", page: 3 }], 96)
		expect(signals[0]?.aborted).toBe(true)
		await vi.waitFor(() => {
			expect(signals).toHaveLength(2)
		})
		thumbnails.dispose()
		expect(signals[1]?.aborted).toBe(true)
	})
})

describe("thumbnailWindow", () => {
	// Mounted pages 3–9, pages 4–7 in view first, then the overscan nearest first.
	const MOUNTED = [4, 5, 6, 7, 8, 3, 9]

	it("asks for every mounted page of a document held whole", () => {
		expect(thumbnailWindow(MOUNTED, 4, null)).toEqual(MOUNTED)
	})

	it("sparing, asks for the pages in view next to the page shown, and every page in view once explored", () => {
		expect(thumbnailWindow(MOUNTED, 4, { current: 5, explored: false })).toEqual([4, 5, 6])
		expect(thumbnailWindow(MOUNTED, 4, { current: 20, explored: false })).toEqual([])
		expect(thumbnailWindow(MOUNTED, 4, { current: 20, explored: true })).toEqual([4, 5, 6, 7])
	})
})
