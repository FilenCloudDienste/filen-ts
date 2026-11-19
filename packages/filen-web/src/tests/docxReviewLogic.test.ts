import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditAnnotationRevision, PagedEditor } from "@filen/office/core/docx/paged"
import {
	ReviewView,
	asideRoom,
	changeLabel,
	changeTitle,
	formatDescription,
	pageBalloons,
	placeColumn,
	reviewColorName,
	type ReviewPage,
	type ReviewTranslate
} from "@/features/preview/components/docxReview.logic"
import { preview } from "@/locales/en/preview"

// The view's annotation and comment stores, without a document: no comments, no tracked changes.
vi.mock("@filen/office/core/docx/paged", async () => {
	const actual = await vi.importActual<typeof import("@filen/office/core/docx/paged")>("@filen/office/core/docx/paged")

	return {
		...actual,
		EditAnnotations: class {
			subscribe(): () => void {
				return () => undefined
			}

			pageVersion(): number {
				return 0
			}

			read(): unknown {
				return { authors: [], comments: [], revisions: [], rectPages: new Int32Array(0), rectFloats: new Float32Array(0) }
			}
		},
		docxComments: () => ({ version: 0, threads: () => [] })
	}
})

const CHANGE: EditAnnotationRevision = {
	kind: "formatting",
	target: "text",
	author: 1,
	date: "",
	text: "",
	properties: [],
	format: [],
	firstRect: 3,
	rectCount: 1,
	id: "9",
	story: 0
}
const FRAME = { index: 0, top: 16, left: 100, width: 816, height: 1056 }
// Two threads and a formatting change on page 0.
const PAGE: ReviewPage = {
	frame: FRAME,
	threads: [
		{ id: "1", x: 10, y: 100, height: 20, author: 0 },
		{ id: "3", x: 50, y: 300, height: 20, author: 1 }
	],
	changes: [{ revision: CHANGE, x: 60, y: 200, height: 20, author: 1 }],
	revisions: [CHANGE],
	boxes: new Float32Array(0),
	boxThreads: [],
	boxAuthors: new Int32Array(0),
	bars: new Float32Array(0),
	barX: 0
}
const SIZES = { estimate: 64, connector: 14, gap: 8, more: 28 }

describe("review layer logic", () => {
	it("lists a page's threads and formatting changes in anchor order, as the markup shows them", () => {
		const all = pageBalloons(PAGE, { comments: true, formatting: true }, null)

		expect(all.map(balloon => balloon.key)).toEqual(["c:1", "f:9", "c:3"])
		expect(all[1]?.revision).toBe(CHANGE)
		expect(pageBalloons(PAGE, { comments: true, formatting: false }, null).map(balloon => balloon.key)).toEqual(["c:1", "c:3"])
		expect(pageBalloons(PAGE, { comments: false, formatting: false }, null)).toEqual([])

		// The comment being composed takes its place among them.
		const composing = pageBalloons(PAGE, { comments: true, formatting: true }, { x: 5, y: 250, height: 20 })

		expect(composing.map(balloon => balloon.key)).toEqual(["c:1", "f:9", "new", "c:3"])
	})

	it("places balloons beside their anchors without overlapping, the active one at its anchor", () => {
		const balloons = pageBalloons(PAGE, { comments: true, formatting: true }, null)
		const heights = new Map([["c:1", 150]])
		const placed = placeColumn(balloons, FRAME, 1, heights, null, SIZES)

		expect(placed.shown).toBe(3)
		expect(placed.tops[0]).toBe(16 + 110 - 14)
		// The second starts below the first (150 high) whatever its anchor.
		expect(placed.tops[1]).toBeGreaterThanOrEqual((placed.tops[0] ?? 0) + 150 + 8)

		const active = placeColumn(balloons, FRAME, 1, heights, "f:9", SIZES)

		expect(active.tops[1]).toBe(16 + 210 - 14)
		expect(active.tops[0]).toBeLessThanOrEqual(16 + 210 - 14 - 8 - 150)
	})

	it("finds the room beside the narrowest gap of the pages in view", () => {
		expect(asideRoom([FRAME], 1600, 16)).toBe(1600 - 916 - 32)
		expect(asideRoom([FRAME, { ...FRAME, index: 1, left: 300 }], 1600, 16)).toBe(1600 - 1116 - 32)
		expect(asideRoom([], 1600, 16)).toBe(0)
		expect(asideRoom([FRAME], 900, 16)).toBe(0)
	})

	it("names changes as Word's balloons do", () => {
		expect(changeLabel({ kind: "insertion", target: "text" })).toBe("previewDocxChangeInserted")
		expect(changeLabel({ kind: "deletion", target: "text" })).toBe("previewDocxChangeDeleted")
		expect(changeLabel({ kind: "moveFrom", target: "text" })).toBe("previewDocxChangeMovedFrom")
		expect(changeLabel({ kind: "moveTo", target: "text" })).toBe("previewDocxChangeMovedTo")
		expect(changeLabel({ kind: "formatting", target: "paragraph" })).toBe("previewDocxFormatted")
		expect(changeLabel({ kind: "insertion", target: "paragraph" })).toBe("previewDocxChangeParagraphInserted")
		expect(changeLabel({ kind: "deletion", target: "paragraph" })).toBe("previewDocxChangeParagraphDeleted")
		expect(changeLabel({ kind: "deletion", target: "table" })).toBe("previewDocxChangeTableDeleted")
	})
})

// The English catalog, interpolated.
const t: ReviewTranslate = (key, values) => preview[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ""))

describe("formatting changes in Word's words", () => {
	it("groups the font's changes and the indents, as Word's balloons do", () => {
		expect(
			formatDescription(
				[
					{ kind: "toggle", property: "bold", on: true },
					{ kind: "toggle", property: "italic", on: true }
				],
				t,
				"cm",
				"en-GB"
			)
		).toBe("Font: Bold, Italic")
		expect(formatDescription([{ kind: "indent", side: "left", twips: 567 }], t, "cm", "en-GB")).toBe("Indent: Left: 1 cm")
		expect(formatDescription([{ kind: "color", color: { kind: "rgb", rgb: "FF0000" } }], t, "cm", "en-GB")).toBe("Font color: Red")
		expect(
			formatDescription(
				[
					{ kind: "font", script: "default", name: "Arial", theme: null },
					{ kind: "size", script: "default", points: 12 },
					{ kind: "toggle", property: "bold", on: false },
					{ kind: "color", color: { kind: "theme", theme: "accent1", tint: 102 } },
					{ kind: "align", value: "center" },
					{ kind: "indent", side: "left", twips: 720 },
					{ kind: "indent", side: "hanging", twips: 360 },
					{ kind: "lineSpacing", rule: "auto", value: 276 },
					{ kind: "space", side: "before", points: 12 },
					{ kind: "space", side: "after", points: 3 },
					{ kind: "keepNext", on: true },
					{ kind: "outlineLevel", level: 2 }
				],
				t,
				"in",
				"en-US"
			)
		).toBe(
			'Font: (Default) Arial, 12 pt, Not Bold, Font color: Accent 1, lighter 60%, Centered, Indent: Left: 0.5", Hanging: 0.25", Line spacing: Multiple 1.15 li, Space Before: 12 pt, After: 3 pt, Keep with next, Level 2'
		)
		expect(
			formatDescription(
				[
					{ kind: "style", paragraph: true, name: "Heading 1" },
					{ kind: "list", list: "bullet", level: 1 },
					{ kind: "space", side: "after", points: "auto" },
					{ kind: "position", value: "baseline" }
				],
				t,
				"cm",
				"de-DE"
			)
		).toBe("Heading 1, Bulleted + Level: 1, Space After: Auto, Font: Not Superscript/ Subscript")
		expect(formatDescription([{ kind: "lineSpacing", rule: "exact", value: 250 }], t, "cm", "de-DE")).toBe(
			"Line spacing: Exactly 12,5 pt"
		)
	})

	it("names fonts by the characters they are for, theme fonts with their typeface", () => {
		expect(formatDescription([{ kind: "font", script: "default", name: "Calibri", theme: "body" }], t, "cm", "en-GB")).toBe(
			"Font: (Default) +Body (Calibri)"
		)
		expect(
			formatDescription(
				[
					{ kind: "font", script: "asian", name: "MS Mincho", theme: null },
					{ kind: "size", script: "complex", points: 20 },
					{ kind: "toggle", property: "hidden", on: true },
					{ kind: "underlineColor", color: { kind: "rgb", rgb: "FF0000" } }
				],
				t,
				"cm",
				"en-GB"
			)
		).toBe("Font: (Asian) MS Mincho, (Complex) 20 pt, Hidden, Underline color: Red")
	})

	it("names theme fonts by their slot, as Word does", () => {
		expect(
			formatDescription(
				[
					{ kind: "font", script: "asian", name: "DengXian", theme: "body" },
					{ kind: "font", script: "default", name: "Calibri", theme: "body" },
					{ kind: "font", script: "complex", name: null, theme: "headings" }
				],
				t,
				"cm",
				"en-GB"
			)
		).toBe("Font: (Asian) +Body Asian (DengXian), (Default) +Body (Calibri), (Complex) +Headings CS")
	})

	it("names colours as Word does", () => {
		expect(reviewColorName({ kind: "auto" }, t)).toBe("Auto")
		expect(reviewColorName({ kind: "rgb", rgb: "C00000" }, t)).toBe("Dark red")
		expect(reviewColorName({ kind: "rgb", rgb: "123456" }, t)).toBe("Custom Color(RGB(18,52,86))")
		expect(reviewColorName({ kind: "theme", theme: "text1", shade: 191 }, t)).toBe("Text 1, darker 25%")
	})

	it("titles a formatting change with what changed, a table's as Word does", () => {
		const base = { kind: "formatting", target: "text" } as const

		expect(changeTitle({ ...base, format: [{ kind: "toggle", property: "bold", on: true }] }, t)).toBe("Formatted: Font: Bold")
		expect(changeTitle({ ...base, format: [] }, t)).toBe("Formatted")
		expect(changeTitle({ kind: "formatting", target: "table", format: [] }, t)).toBe("Formatted Table")
		expect(changeTitle({ kind: "insertion", target: "text", format: [] }, t)).toBe("Inserted")
	})
})

describe("review view", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("lets the scroller's observer go with the last listener and observes it again on the next", () => {
		const frames: (() => void)[] = []
		const observers: { readonly observe: ReturnType<typeof vi.fn>; readonly disconnect: ReturnType<typeof vi.fn> }[] = []

		vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback))
		vi.stubGlobal("cancelAnimationFrame", vi.fn())
		vi.stubGlobal(
			"ResizeObserver",
			class {
				readonly observe = vi.fn()
				readonly disconnect = vi.fn()

				constructor() {
					observers.push(this)
				}
			}
		)

		const flush = (): void => {
			for (const callback of frames.splice(0)) callback()
		}
		const scroller = { clientWidth: 900, clientHeight: 700 }
		const page = { style: { top: "0px", left: "0px", width: "816px", height: "1056px" }, closest: () => scroller }
		const view = new ReviewView({} as PagedEditor)

		view.mount(0, page as unknown as HTMLElement)

		const unsubscribe = view.subscribe(() => undefined)

		flush()
		expect(observers).toHaveLength(1)
		expect(observers[0]?.observe).toHaveBeenCalledWith(scroller)

		unsubscribe()
		expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1)

		view.subscribe(() => undefined)
		flush()
		expect(observers).toHaveLength(2)
		expect(observers[1]?.observe).toHaveBeenCalledWith(scroller)
	})
})
