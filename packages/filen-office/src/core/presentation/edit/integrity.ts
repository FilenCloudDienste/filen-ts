import type { Action, CustomShow, Deck, Run, Section, ShapeNode, ShapeRef, SlideRef, TextBody } from "../model"

// The deck's reference graph for slide add, duplicate, delete and reorder, format-neutral: what a slide owns (its
// notes slide, comments, charts with their workbooks and styles, diagram parts, embedded objects: copied with a
// duplicate, removed with a delete) and shares (layouts, masters, themes, pictures and media, fonts), which other
// slides jump to it, and its section and custom-show membership. The model ops (apply/slide.ts) carry out the
// model's half; the writers' parts.ts carry out the package's half from the same plans.

// One internal reference of a part: the target part and the relationship's kind (the last segment of its type URI:
// "notesSlide", "comments", "chart", "image", "slide"…).
export interface PartReference {
	readonly kind: string
	readonly part: string
}

export interface ReferenceFacts {
	// The internal references of a part (pptx: its relationships), or undefined when the part has none or is unknown.
	references(part: string): readonly PartReference[] | undefined
	// Every part with references (slides, layouts, masters, notes, the presentation…), for orphan checks.
	parts(): Iterable<string>
}

// Kinds a slide owns: a duplicate gets its own copies, a delete removes them (unless another part still refers to
// them). Everything else is shared.
export const OWNED_KINDS: ReadonlySet<string> = new Set([
	"notesSlide",
	"comments",
	"chart",
	"chartStyle",
	"chartColorStyle",
	"package",
	"oleObject",
	"diagramData",
	"diagramLayout",
	"diagramQuickStyle",
	"diagramColors",
	"diagramDrawing",
	"tags",
	"vmlDrawing",
	"customXml",
	"ink"
])

// Back references an owned part keeps to its owner or to shared parts (a notes slide to its slide and notes master).
const NOT_FOLLOWED: ReadonlySet<string> = new Set(["slide", "slideLayout", "slideMaster", "notesMaster", "handoutMaster", "theme"])

export interface SlideReferences {
	readonly slide: SlideRef
	readonly part: string
	// Owned parts, depth first from the slide (a chart before its workbook and styles).
	readonly owned: readonly string[]
	// Shared parts the slide refers to directly.
	readonly shared: readonly string[]
	// Other slides whose parts refer to this one (slide-jump actions).
	readonly jumpsFrom: readonly SlideRef[]
	readonly sections: readonly string[]
	readonly customShows: readonly number[]
}

function slideParts(deck: Deck, partOf: (ref: SlideRef) => string | undefined): Map<string, SlideRef> {
	const out = new Map<string, SlideRef>()

	for (const ref of deck.slides) {
		const part = partOf(ref)

		if (part !== undefined) out.set(part, ref)
	}

	return out
}

// The part of a listed slide (parsed or not).
export type PartOf = (ref: SlideRef) => string | undefined

export function slideReferences(deck: Deck, ref: SlideRef, facts: ReferenceFacts, partOf: PartOf): SlideReferences | undefined {
	const part = partOf(ref)

	if (part === undefined) return undefined

	const owned: string[] = []
	const shared: string[] = []
	const seen = new Set<string>([part])
	const follow = (from: string, depth: number): void => {
		for (const reference of facts.references(from) ?? []) {
			if (seen.has(reference.part) || NOT_FOLLOWED.has(reference.kind)) continue

			seen.add(reference.part)

			if (OWNED_KINDS.has(reference.kind)) {
				owned.push(reference.part)
				if (depth < 8) follow(reference.part, depth + 1)
			} else {
				// Shared from the slide or from a part it owns (a picture a diagram's data relates): a delete that leaves no
				// other reference to it removes it too, so its undo holds it.
				shared.push(reference.part)
			}
		}
	}

	follow(part, 0)

	for (const reference of facts.references(part) ?? []) {
		if (NOT_FOLLOWED.has(reference.kind) && reference.kind !== "slide" && !shared.includes(reference.part)) shared.push(reference.part)
	}

	const jumpsFrom: SlideRef[] = []
	const byPart = slideParts(deck, partOf)

	for (const [other, otherRef] of byPart) {
		if (otherRef === ref) continue
		if ((facts.references(other) ?? []).some(reference => reference.kind === "slide" && reference.part === part))
			jumpsFrom.push(otherRef)
	}

	return {
		slide: ref,
		part,
		owned,
		shared,
		jumpsFrom,
		sections: deck.sections.filter(section => section.slides.includes(ref)).map(section => section.id),
		customShows: deck.customShows.filter(show => show.slides.includes(ref)).map(show => show.id)
	}
}

// Where an action that jumps to a slide sits: a shape's click or hover action, or a run's hyperlink in its text.
export type JumpSite =
	| { readonly kind: "shape"; readonly shape: ShapeRef; readonly trigger: "click" | "hover" }
	| {
			readonly kind: "run"
			readonly shape: ShapeRef
			// A table cell's text (row, col of the shape's table), or the shape's own text.
			readonly cell?: { readonly row: number; readonly col: number }
			readonly paragraph: number
			readonly run: number
			readonly trigger: "hlinkClick" | "hlinkMouseOver"
	  }

export interface JumpRewrite {
	readonly site: JumpSite
	readonly from: Action
	readonly to: Action
}

// After a delete, a jump to a removed slide goes to the next slide (and is reported).
export const JUMP_REPLACEMENT: Action = { kind: "internal", jump: "next" }

function jumpsIn(shapes: readonly ShapeNode[], slide: SlideRef, targets: ReadonlySet<SlideRef>, out: JumpRewrite[]): void {
	for (const shape of shapes) {
		for (const trigger of ["click", "hover"] as const) {
			const action = shape.actions?.[trigger]

			if (action?.kind === "slide" && targets.has(action.slide)) {
				out.push({ site: { kind: "shape", shape: { slide, id: shape.id }, trigger }, from: action, to: JUMP_REPLACEMENT })
			}
		}

		const inBody = (body: TextBody | undefined, cell?: { readonly row: number; readonly col: number }): void => {
			body?.paragraphs.forEach((paragraph, p) => {
				paragraph.runs.forEach((run: Run, r) => {
					if (run.kind === "opaque") return

					for (const trigger of ["hlinkClick", "hlinkMouseOver"] as const) {
						const action = run.rPr[trigger]

						if (action?.kind === "slide" && targets.has(action.slide)) {
							const site: JumpSite = {
								kind: "run",
								shape: { slide, id: shape.id },
								...(cell === undefined ? {} : { cell }),
								paragraph: p,
								run: r,
								trigger
							}

							out.push({ site, from: action, to: JUMP_REPLACEMENT })
						}
					}
				})
			})
		}

		inBody(shape.text)

		if (shape.frame?.kind === "table") {
			shape.frame.table.rows.forEach((row, rowIndex) => {
				row.cells.forEach((cell, col) => inBody(cell.text, { row: rowIndex, col }))
			})
		}

		if (shape.children !== undefined) jumpsIn(shape.children, slide, targets, out)
	}
}

// The jumps to `targets` in the deck's parsed slides (other than the targets).
export function jumpsTo(deck: Deck, targets: ReadonlySet<SlideRef>): JumpRewrite[] {
	const out: JumpRewrite[] = []

	for (const ref of deck.slides) {
		if (targets.has(ref)) continue

		const node = deck.nodes.get(ref)

		if (node !== undefined) jumpsIn(node.shapes, ref, targets, out)
	}

	return out
}

export interface DeletePlan {
	readonly slides: readonly SlideRef[]
	// Slides whose content must be parsed before the delete applies (they jump to a deleted slide).
	readonly parse: readonly SlideRef[]
	// Parts removed with the slides: each slide's own part, its owned parts, and shared parts nothing else refers to.
	readonly remove: readonly string[]
	readonly sections: readonly Section[] | undefined
	readonly customShows: readonly CustomShow[] | undefined
	readonly jumps: readonly JumpRewrite[]
	// docProps/app.xml: the slide count after the delete.
	readonly slideCount: number
}

function withoutSlides<T extends { slides: SlideRef[] }>(list: readonly T[], gone: ReadonlySet<SlideRef>): T[] | undefined {
	if (!list.some(item => item.slides.some(ref => gone.has(ref)))) return undefined

	return list.map(item => ({ ...item, slides: item.slides.filter(ref => !gone.has(ref)) }))
}

export function planDelete(deck: Deck, refs: readonly SlideRef[], facts: ReferenceFacts, partOf: PartOf): DeletePlan {
	const gone = new Set(refs.filter(ref => deck.slides.includes(ref)))
	const removed = new Set<string>()
	const parse = new Set<SlideRef>()
	const candidates: string[] = []

	for (const ref of gone) {
		const references = slideReferences(deck, ref, facts, partOf)

		if (references === undefined) continue

		removed.add(references.part)

		for (const part of references.owned) removed.add(part)
		for (const part of references.shared) candidates.push(part)
		for (const from of references.jumpsFrom) if (!gone.has(from)) parse.add(from)
	}

	// An owned or shared part another remaining part still refers to stays.
	const stillReferenced = new Set<string>()

	for (const part of facts.parts()) {
		if (removed.has(part)) continue

		for (const reference of facts.references(part) ?? []) stillReferenced.add(reference.part)
	}

	const remove: string[] = []

	for (const part of removed) if (!stillReferenced.has(part) || [...gone].some(ref => partOf(ref) === part)) remove.push(part)
	for (const part of new Set(candidates)) if (!stillReferenced.has(part) && !removed.has(part)) remove.push(part)

	const jumps = jumpsTo(deck, gone)

	return {
		slides: [...gone],
		parse: [...parse].filter(ref => !deck.nodes.has(ref)),
		remove,
		sections: withoutSlides(deck.sections, gone),
		customShows: withoutSlides(deck.customShows, gone),
		jumps,
		slideCount: deck.slides.length - gone.size
	}
}

export interface DuplicatePlan {
	readonly source: SlideRef
	// Owned parts the copy gets its own copies of (renamed by the writer), depth first.
	readonly copy: readonly string[]
	// Parts the copy shares with the source.
	readonly share: readonly string[]
	// The copy takes a new p14:creationId (and a new p:sldId).
	readonly newIdentity: true
}

export function planDuplicate(deck: Deck, ref: SlideRef, facts: ReferenceFacts, partOf: PartOf): DuplicatePlan | undefined {
	const references = slideReferences(deck, ref, facts, partOf)

	if (references === undefined) return undefined

	return { source: ref, copy: references.owned, share: references.shared, newIdentity: true }
}

// Sections after slides moved to `order` (the new deck order): each section keeps its slides in deck order, and a
// slide that left its section's run joins the section of the slide before it (the first section at the top).
export function sectionsAfterMove(
	sections: readonly Section[],
	order: readonly SlideRef[],
	moved: ReadonlySet<SlideRef>
): Section[] | undefined {
	if (sections.length === 0) return undefined

	const sectionOf = new Map<SlideRef, number>()

	sections.forEach((section, index) => {
		for (const ref of section.slides) sectionOf.set(ref, index)
	})

	const out = sections.map(section => ({ ...section, slides: [] as SlideRef[] }))
	let current = 0

	for (const ref of order) {
		const own = sectionOf.get(ref)

		// A slide not moved keeps its section, and the run continues from it; a moved one follows the slide before it.
		if (own !== undefined && !moved.has(ref) && own >= current) current = own

		out[current]?.slides.push(ref)
	}

	const same = out.every((section, index) => {
		const before = sections[index]?.slides ?? []

		return section.slides.length === before.length && section.slides.every((ref, at) => before[at] === ref)
	})

	return same ? undefined : out
}

// Sections after a slide is inserted at `at` of `order` (the new deck order): it joins the section of the slide
// before it, or the first section.
export function sectionsAfterInsert(sections: readonly Section[], order: readonly SlideRef[], inserted: SlideRef): Section[] | undefined {
	return sectionsAfterMove(sections, order, new Set([inserted]))
}
