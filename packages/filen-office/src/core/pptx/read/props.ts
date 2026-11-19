import { MAX_RESTART_MS } from "../../presentation/edit/apply/presentation"
import { DEFAULT_SLIDE_GRID, type Author, type CustomShow, type ShowSettings, type SlideGrid } from "../../presentation/model"
import { tooLarge } from "../../presentation/refusal"
import { colorIn, type ReadContext } from "./drawing"
import { G } from "./xml"

// The presentation properties part (p:presentationPr, ECMA-376 Part 1 §19.2.1.27: p:showPr, §19.2.1.30) and the
// comment authors (p:cmAuthorLst, §19.4.2; PowerPoint 365's p188:authorLst, MS-PPTX §2.3.27).

export const DEFAULT_SHOW: ShowSettings = {
	kind: "present",
	loop: false,
	showAnimation: true,
	useTimings: true,
	range: { kind: "all" }
}

const DEFAULT_RESTART_MS = 300_000

export function readShowSettings(context: ReadContext, presentationPr: number): ShowSettings {
	const r = context.reader
	const showPr = r.child(presentationPr, G.P, "showPr")

	if (showPr < 0) return { ...DEFAULT_SHOW }

	const kiosk = r.child(showPr, G.P, "kiosk")
	const range = r.child(showPr, G.P, "sldRg")
	const custom = r.child(showPr, G.P, "custShow")
	const pen = colorIn(r, r.child(showPr, G.P, "penClr"))
	const restart = r.int(kiosk, "restart")
	// Kept absent when unwritten: only an explicit showNarration="0" mutes narration.
	const narration = r.bool(showPr, "showNarration")

	return {
		kind: kiosk >= 0 ? "kiosk" : r.child(showPr, G.P, "browse") >= 0 ? "browse" : "present",
		loop: r.bool(showPr, "loop") ?? false,
		...(narration === undefined ? {} : { showNarration: narration }),
		showAnimation: r.bool(showPr, "showAnimation") ?? true,
		useTimings: r.bool(showPr, "useTimings") ?? true,
		range:
			range >= 0
				? { kind: "range", start: r.int(range, "st") ?? 1, end: r.int(range, "end") ?? 1 }
				: custom >= 0
					? { kind: "customShow", id: r.int(custom, "id") ?? 0 }
					: { kind: "all" },
		...(pen === undefined ? {} : { penColor: pen }),
		// The kiosk restart (ST_Ms, an unsignedInt; default 300,000 ms). One outside it reads as the default, so the inverse
		// Set Up Slide Show or a slide edit stores never holds a restart the setShow check refuses.
		...(kiosk >= 0
			? { restartMs: restart !== undefined && restart >= 0 && restart <= MAX_RESTART_MS ? restart : DEFAULT_RESTART_MS }
			: {})
	}
}

// The file's show range as the deck can hold it: a p:sldRg ending past the last slide ends at it, and one starting outside
// the deck or after its end, or a p:custShow naming no custom show, plays all slides. The model then never holds a range
// the setShow check refuses, so the inverse a slide edit or Set Up Slide Show stores always applies on undo.
export function fitShowRange(range: ShowSettings["range"], slides: number, customShows: readonly CustomShow[]): ShowSettings["range"] {
	switch (range.kind) {
		case "range": {
			const end = Math.min(range.end, slides)

			if (range.start < 1 || range.start > end) return { kind: "all" }

			return end === range.end ? range : { kind: "range", start: range.start, end }
		}
		case "customShow":
			return customShows.some(custom => custom.id === range.id) ? range : { kind: "all" }
		default:
			return range
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
