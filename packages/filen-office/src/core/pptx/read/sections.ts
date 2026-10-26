import type { CustomShow, Section, SlideRef } from "../../presentation/model"
import { tooLarge } from "../../presentation/refusal"
import type { ReadContext } from "./drawing"
import { G } from "./xml"

// Sections (PowerPoint 2010's p14:sectionLst in the presentation's extension list, MS-PPTX §2.3.11) and custom
// shows (p:custShowLst, ECMA-376 Part 1 §19.2.1.6/.7). Slides are referenced by p:sldId/@id in sections and by
// relationship in custom shows; references to slides the deck does not list are dropped from the list only (the
// markup is kept).

const SECTIONS_EXT = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"

export function readSections(context: ReadContext, presentation: number, bySlideId: ReadonlyMap<number, SlideRef>): Section[] {
	const r = context.reader
	const out: Section[] = []
	const budget = context.tally.budgets.sections

	for (const ext of r.children(r.child(presentation, G.P, "extLst"), G.P, "ext")) {
		if (r.attr(ext, "uri") !== SECTIONS_EXT) continue

		for (const section of r.children(r.child(ext, G.P14, "sectionLst"), G.P14, "section")) {
			if (out.length >= budget) tooLarge("sections", budget)

			const slides: SlideRef[] = []

			for (const sldId of r.children(r.child(section, G.P14, "sldIdLst"), G.P14, "sldId")) {
				const ref = bySlideId.get(r.int(sldId, "id") ?? -1)

				if (ref !== undefined) slides.push(ref)
			}

			out.push({ name: r.attr(section, "name") ?? "", id: r.attr(section, "id") ?? "", slides })
		}
	}

	return out
}

export function readCustomShows(context: ReadContext, list: number, slideOfRel: (id: string) => SlideRef | undefined): CustomShow[] {
	const r = context.reader
	const out: CustomShow[] = []
	const budget = context.tally.budgets.customShows

	for (const show of r.children(list, G.P, "custShow")) {
		if (out.length >= budget) tooLarge("custom shows", budget)

		const slides: SlideRef[] = []

		for (const sld of r.children(r.child(show, G.P, "sldLst"), G.P, "sld")) {
			const ref = slideOfRel(r.rel(sld, "id") ?? "")

			if (ref !== undefined) slides.push(ref)
		}

		out.push({ name: r.attr(show, "name") ?? "", id: r.int(show, "id") ?? 0, slides })
	}

	return out
}
