// What a PowerPoint 97–2003 deck lost on its way to PresentationML, by kind and slide (1-based), so the viewer can say
// so and Save as can list it. Nothing is dropped silently: each item is converted, kept in another form (a picture in
// place of an embedded object), or counted here.

export type PptLossKind =
	// An embedded or linked OLE object: shown as its preview picture.
	| "oleObject"
	// A sound or movie: its poster or icon is shown, the media itself is not played.
	| "media"
	// Office 97 and PowerPoint 2002 animations (AnimationInfo, the PP10 time tree).
	| "animation"
	// A slide transition.
	| "transition"
	// A comment (PP10 Comment10).
	| "comment"
	// A VBA project, which a .pptx cannot hold.
	| "macros"
	// A click or hover action the deck cannot carry (media, an unknown action); macros, programs and OLE verbs are
	// carried, refused by the reader.
	| "action"
	// WordArt: its text in a text box of the shape's size, not drawn along the geometry.
	| "wordArt"
	// A custom shape path element (an arc or ellipse escape) drawn as straight segments.
	| "customGeometry"
	// A picture whose data could not be read or is in a format the deck cannot show.
	| "picture"
	// A slide with a colour scheme of its own shows its master's shapes in the master's colours.
	| "slideColorScheme"
	// A pattern fill: drawn as a 50% pattern of its two colours.
	| "patternFill"
	// Content the reader could not read (a damaged shape or text body).
	| "damagedContent"

export interface PptLoss {
	readonly kind: PptLossKind
	readonly count: number
	readonly slides?: readonly number[]
}

export class PptReport {
	private readonly counts = new Map<PptLossKind, { count: number; slides: Set<number> }>()

	note(kind: PptLossKind, slide?: number, count = 1): void {
		let entry = this.counts.get(kind)

		if (entry === undefined) {
			entry = { count: 0, slides: new Set() }
			this.counts.set(kind, entry)
		}

		entry.count += count

		if (slide !== undefined) entry.slides.add(slide)
	}

	losses(): PptLoss[] {
		return [...this.counts].map(([kind, entry]) => ({
			kind,
			count: entry.count,
			...(entry.slides.size === 0 ? {} : { slides: [...entry.slides].sort((a, b) => a - b) })
		}))
	}
}
