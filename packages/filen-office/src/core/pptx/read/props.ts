import { DEFAULT_SLIDE_GRID, type Author, type ShowSettings, type SlideGrid } from "../../presentation/model"
import { tooLarge } from "../../presentation/refusal"
import { colorIn, type ReadContext } from "./drawing"
import { G } from "./xml"

// The presentation properties part (p:presentationPr, ECMA-376 Part 1 §19.2.1.27: p:showPr, §19.2.1.30) and the
// comment authors (p:cmAuthorLst, §19.4.2; PowerPoint 365's p188:authorLst, MS-PPTX §2.3.27).

export const DEFAULT_SHOW: ShowSettings = {
	kind: "present",
	loop: false,
	showNarration: false,
	showAnimation: true,
	useTimings: true,
	range: { kind: "all" }
}

export function readShowSettings(context: ReadContext, presentationPr: number): ShowSettings {
	const r = context.reader
	const showPr = r.child(presentationPr, G.P, "showPr")

	if (showPr < 0) return { ...DEFAULT_SHOW }

	const kiosk = r.child(showPr, G.P, "kiosk")
	const range = r.child(showPr, G.P, "sldRg")
	const custom = r.child(showPr, G.P, "custShow")
	const pen = colorIn(r, r.child(showPr, G.P, "penClr"))
	const restart = r.int(kiosk, "restart")

	return {
		kind: kiosk >= 0 ? "kiosk" : r.child(showPr, G.P, "browse") >= 0 ? "browse" : "present",
		loop: r.bool(showPr, "loop") ?? false,
		showNarration: r.bool(showPr, "showNarration") ?? false,
		showAnimation: r.bool(showPr, "showAnimation") ?? true,
		useTimings: r.bool(showPr, "useTimings") ?? true,
		range:
			range >= 0
				? { kind: "range", start: r.int(range, "st") ?? 1, end: r.int(range, "end") ?? 1 }
				: custom >= 0
					? { kind: "customShow", id: r.int(custom, "id") ?? 0 }
					: { kind: "all" },
		...(pen === undefined ? {} : { penColor: pen }),
		// The kiosk restart (ST_Ms, default 300,000 ms).
		...(kiosk >= 0 ? { restartMs: restart ?? 300_000 } : {})
	}
}

// The view properties part's grid (p:viewPr, §19.2.2.18): p:gridSpacing and p:slideViewPr/p:cSldViewPr@snapToGrid,
// PowerPoint's defaults for what is absent or not a positive size.
export function readViewGrid(context: ReadContext, viewPr: number): SlideGrid {
	const r = context.reader
	const spacing = r.child(viewPr, G.P, "gridSpacing")
	const slideView = r.child(viewPr, G.P, "slideViewPr")
	const common = slideView < 0 ? -1 : r.child(slideView, G.P, "cSldViewPr")
	const size = (value: number | undefined, fallback: number): number => (value !== undefined && value > 0 ? value : fallback)

	return {
		cx: size(r.int(spacing, "cx"), DEFAULT_SLIDE_GRID.cx),
		cy: size(r.int(spacing, "cy"), DEFAULT_SLIDE_GRID.cy),
		snap: r.bool(common, "snapToGrid") ?? DEFAULT_SLIDE_GRID.snap
	}
}

export function readLegacyAuthors(context: ReadContext, list: number): Author[] {
	const r = context.reader
	const out: Author[] = []
	const budget = context.tally.budgets.authors

	for (const author of r.children(list, G.P, "cmAuthor")) {
		if (out.length >= budget) tooLarge("comment authors", budget)

		const id = r.int(author, "id") ?? out.length
		const initials = r.attr(author, "initials")

		out.push({ id: String(id), name: r.attr(author, "name") ?? "", ...(initials === undefined ? {} : { initials }), legacyId: id })
	}

	return out
}

export function readModernAuthors(context: ReadContext, list: number): Author[] {
	const r = context.reader
	const out: Author[] = []
	const budget = context.tally.budgets.authors

	for (const author of r.children(list, G.P188, "author")) {
		if (out.length >= budget) tooLarge("comment authors", budget)

		const initials = r.attr(author, "initials")
		const userId = r.attr(author, "userId")
		const providerId = r.attr(author, "providerId")

		out.push({
			id: r.attr(author, "id") ?? "",
			name: r.attr(author, "name") ?? "",
			...(initials === undefined ? {} : { initials }),
			...(userId === undefined ? {} : { userId }),
			...(providerId === undefined ? {} : { providerId })
		})
	}

	return out
}
