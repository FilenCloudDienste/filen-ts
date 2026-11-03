import type { PptLoss, PptLossKind } from "../../ppt/report"

// What a converted deck holds differently from its source, by kind, with counts and (where known) the 1-based slides.
// Nothing is dropped silently: each item is written, written in the nearest form the target has, or counted here.

export type ConversionLossKind =
	// A PowerPoint 97–2003 deck's own losses on its way to PresentationML (core/ppt/report.ts).
	| PptLossKind
	// A gradient, pattern or picture fill written in the nearest form the target holds.
	| "fill"
	// A dashed line or a line end the target has no form for.
	| "line"
	// An outline the target has no preset for, drawn as its nearest.
	| "geometry"
	// A paragraph's outline level the target holds only on a bulleted paragraph, written without it.
	| "outlineLevel"
	// Text written in a nearer form: vertical text, line-breaking rules, spacing, bullet size or numbering.
	| "text"
	// A table style written as the cells' own properties.
	| "tableStyle"
	// A chart not carried.
	| "chart"
	// A chart carried with less than it holds (a number format, a trend line, a secondary axis…).
	| "chartDetail"
	// A field the target has no type for (a page count, the file name), written as the text it shows.
	| "field"
	// A SmartArt diagram written as a group of its shapes (its data kept only in .pptx targets).
	| "smartArt"
	// A 3D scene shown as its picture.
	| "threeD"
	// Ink not carried.
	| "ink"
	// A shape the target could not hold.
	| "shape"
	// A slide background written in a nearer form.
	| "background"
	// A slide size the target cannot hold, written as the nearest it can (the content keeps its place).
	| "slideSize"
	// Slide show settings the target has no form for.
	| "showSettings"
	// A package signature, which a new file cannot keep.
	| "signature"
	// A write-reservation password, which a new file does not keep.
	| "writeReservation"
	// A medium's trim, fade or bookmarks: OpenDocument has no form for them.
	| "mediaTiming"
	// An animation a medium's bookmark starts, started on a click of the medium instead (OpenDocument has no bookmarks).
	| "bookmarkTrigger"

export interface ConversionLoss {
	readonly kind: ConversionLossKind
	readonly count: number
	readonly slides?: readonly number[]
}

// Losses gathered by kind.
export class ConversionReport {
	private readonly counts = new Map<ConversionLossKind, { count: number; slides: Set<number> }>()

	note(kind: ConversionLossKind, count = 1, slides: readonly number[] = []): void {
		if (count <= 0) return

		let entry = this.counts.get(kind)

		if (entry === undefined) {
			entry = { count: 0, slides: new Set() }
			this.counts.set(kind, entry)
		}

		entry.count += count

		for (const slide of slides) entry.slides.add(slide)
	}

	addPpt(losses: readonly PptLoss[]): void {
		for (const loss of losses) this.note(loss.kind, loss.count, loss.slides ?? [])
	}

	losses(): ConversionLoss[] {
		return [...this.counts]
			.map(([kind, entry]) => ({
				kind,
				count: entry.count,
				...(entry.slides.size === 0 ? {} : { slides: [...entry.slides].sort((a, b) => a - b) })
			}))
			.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
	}
}
