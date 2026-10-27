import type { Section, SlideRef } from "../../model"
import type { DeckOp, OpOf } from "../ops"
import { oneStep } from "./batch"

// The slide commands of the editor (the rail, the ribbon, the keys), as the ops they send. Pure: they read the slide
// list, the selection and the layouts as the page holds them (OpenInfo), so the page builds an op without a round
// trip and the worker applies it as any other.

type SlideOp = OpOf<"slide">

// A layout as the page knows it (OpenInfo.layouts).
export interface SlideLayoutChoice {
	readonly ref: SlideRef
	readonly master: SlideRef
	// ST_SlideLayoutType (ECMA-376 §19.7.15): "title", "obj", "twoObj"…; absent for a layout that names none.
	readonly type?: string
	readonly name?: string
}

// The layout a new slide takes, as PowerPoint picks it: the slide it follows keeps its layout, except a title slide,
// after which comes its master's Title and Content layout ("obj"). With no slide to follow (an empty deck, or the
// current slide's layout unknown), the first master's Title and Content, else its first layout that is not a title
// slide, else its first.
export function newSlideLayout(layouts: readonly SlideLayoutChoice[], after: SlideRef | undefined): SlideRef | undefined {
	const current = after === undefined ? undefined : layouts.find(layout => layout.ref === after)

	if (current !== undefined && current.type !== "title") return current.ref

	const master = current?.master ?? layouts[0]?.master
	const own = layouts.filter(layout => layout.master === master)

	return (own.find(layout => layout.type === "obj") ?? own.find(layout => layout.type !== "title") ?? own[0])?.ref
}

// A new slide at `at` (an index in the slide list, after the current slide as the editor asks).
export function addSlideOp(at: number, layout: SlideRef): SlideOp {
	return { family: "slide", kind: "add", at: Math.max(0, Math.trunc(at)), layout }
}

// The selection in deck order, without refs the deck no longer lists.
export function inDeckOrder(order: readonly SlideRef[], selection: Iterable<SlideRef>): SlideRef[] {
	const chosen = new Set(selection)

	return order.filter(ref => chosen.has(ref))
}

// Duplicates of the selected slides, as PowerPoint makes them: in their order, right after the last selected slide.
// One duplicate op per slide, sent as one step (a batch when there are several).
export function duplicateSlideOps(order: readonly SlideRef[], selection: Iterable<SlideRef>): DeckOp[] {
	const chosen = inDeckOrder(order, selection)
	const last = chosen.at(-1)

	if (last === undefined) return []

	const after = order.indexOf(last) + 1

	return oneStep(chosen.map((slide, index): SlideOp => ({ family: "slide", kind: "duplicate", slide, at: after + index })))
}

export function deleteSlidesOp(
	order: readonly SlideRef[],
	selection: Iterable<SlideRef>
): Extract<SlideOp, { kind: "delete" }> | undefined {
	const slides = inDeckOrder(order, selection)

	return slides.length === 0 ? undefined : { family: "slide", kind: "delete", slides }
}

// The selected slides moved to stand before the slide at `before` in the current list (`order.length`: at the end),
// as a drop between two rail items asks. Undefined when nothing would move.
export function moveSlidesOp(order: readonly SlideRef[], selection: Iterable<SlideRef>, before: number): SlideOp | undefined {
	const slides = inDeckOrder(order, selection)

	if (slides.length === 0) return undefined

	const moving = new Set(slides)
	const clamped = Math.max(0, Math.min(order.length, Math.trunc(before)))
	// The op's index counts only the slides that stay.
	let to = 0

	for (let index = 0; index < clamped; index++) {
		const ref = order[index]

		if (ref !== undefined && !moving.has(ref)) to++
	}

	const staying = order.filter(ref => !moving.has(ref))
	const result = [...staying.slice(0, to), ...slides, ...staying.slice(to)]

	return result.every((ref, index) => order[index] === ref) ? undefined : { family: "slide", kind: "move", slides, to }
}

// The selected slides one place up or down (the block moves past its neighbour), or to the start or the end, as
// Ctrl+Up/Down and Ctrl+Shift+Up/Down do in PowerPoint's slide list.
export function nudgeSlidesOp(
	order: readonly SlideRef[],
	selection: Iterable<SlideRef>,
	step: -1 | 1 | "first" | "last"
): SlideOp | undefined {
	const slides = inDeckOrder(order, selection)
	const first = slides[0]
	const last = slides.at(-1)

	if (first === undefined || last === undefined) return undefined

	switch (step) {
		case "first":
			return moveSlidesOp(order, slides, 0)
		case "last":
			return moveSlidesOp(order, slides, order.length)
		case -1:
			return moveSlidesOp(order, slides, Math.max(0, order.indexOf(first) - 1))
		case 1:
			return moveSlidesOp(order, slides, Math.min(order.length, order.indexOf(last) + 2))
	}
}

// Hide or show the selected slides in the show: hidden when any of them is shown (PowerPoint's toggle), shown when
// all are hidden.
export function toggleHiddenOp(
	slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[],
	selection: Iterable<SlideRef>
): SlideOp | undefined {
	const chosen = new Set(selection)
	const picked = slides.filter(slide => chosen.has(slide.ref))

	if (picked.length === 0) return undefined

	return { family: "slide", kind: "hide", slides: picked.map(slide => slide.ref), hidden: picked.some(slide => !slide.hidden) }
}

// The selected slides on another layout, one op each, sent as one step.
export function setLayoutOps(order: readonly SlideRef[], selection: Iterable<SlideRef>, layout: SlideRef): DeckOp[] {
	return oneStep(inDeckOrder(order, selection).map((slide): SlideOp => ({ family: "slide", kind: "setLayout", slide, layout })))
}

// PowerPoint's Reset: the placeholders of each selected slide back to their layout's position and formatting, as one
// step.
export function resetSlideOps(order: readonly SlideRef[], selection: Iterable<SlideRef>): DeckOp[] {
	return oneStep(inDeckOrder(order, selection).map((slide): SlideOp => ({ family: "slide", kind: "reset", slide })))
}

// Sections (pptx p14:sectionLst). Once a deck has sections every slide is in one, in deck order: a section is a name on
// the run of slides up to the next section.

// The section list with every slide in one: slides that come before the first section join it (PowerPoint keeps no
// slide outside a section).
function covering(order: readonly SlideRef[], sections: readonly Section[]): Section[] {
	const sectionOf = new Map<SlideRef, number>()

	sections.forEach((section, index) => {
		for (const ref of section.slides) sectionOf.set(ref, index)
	})

	const out = sections.map(section => ({ ...section, slides: [] as SlideRef[] }))
	let current = 0

	for (const ref of order) {
		const own = sectionOf.get(ref)

		if (own !== undefined && own >= current) current = own

		out[current]?.slides.push(ref)
	}

	return out
}

// A new section starting at the slide at `at` (its run up to the next section moves into it; a section that started
// there is left empty before it). With no sections yet, the slides before it go into a first section named
// `defaultName`, as PowerPoint names it.
export function addSectionOp(
	order: readonly SlideRef[],
	sections: readonly Section[],
	at: number,
	section: { readonly id: string; readonly name: string },
	defaultName: string,
	defaultId: string
): SlideOp | undefined {
	const start = order[at]

	if (start === undefined) return undefined

	const whole = sections.length === 0 ? [{ id: defaultId, name: defaultName, slides: [...order] }] : covering(order, sections)
	const index = whole.findIndex(entry => entry.slides.includes(start))
	const host = whole[index]

	if (host === undefined) return undefined

	const split = host.slides.indexOf(start)
	// A section the slide already starts stays, empty (PowerPoint never drops a named section here); only the default
	// section a deck without sections would get before its first slide is not made.
	const kept = split > 0 || sections.length > 0
	const next: Section[] = [
		...whole.slice(0, index),
		...(kept ? [{ ...host, slides: host.slides.slice(0, split) }] : []),
		{ id: section.id, name: section.name, slides: host.slides.slice(split) },
		...whole.slice(index + 1)
	]

	return { family: "slide", kind: "setSections", sections: next }
}

export function renameSectionOp(sections: readonly Section[], id: string, name: string): SlideOp | undefined {
	const trimmed = name.trim()

	if (trimmed === "" || !sections.some(section => section.id === id && section.name !== trimmed)) return undefined

	return {
		family: "slide",
		kind: "setSections",
		sections: sections.map(section => (section.id === id ? { ...section, name: trimmed, slides: [...section.slides] } : section))
	}
}

// The section's name removed, its slides kept: they join the section before it (the first section's join the one
// after it). Removing the last section leaves the deck without sections.
export function removeSectionOp(order: readonly SlideRef[], sections: readonly Section[], id: string): SlideOp | undefined {
	const whole = covering(order, sections)
	const index = whole.findIndex(section => section.id === id)
	const gone = whole[index]

	if (gone === undefined) return undefined

	if (whole.length === 1) return { family: "slide", kind: "setSections", sections: [] }

	const next = whole.filter(section => section.id !== id).map(section => ({ ...section, slides: [...section.slides] }))
	const into = next[Math.max(0, index - 1)]

	if (into !== undefined) into.slides = index === 0 ? [...gone.slides, ...into.slides] : [...into.slides, ...gone.slides]

	return { family: "slide", kind: "setSections", sections: next }
}

// The rows of a slide list with section headers: each section's header, then its slides (covering: a slide listed
// before the first section's own joins it). Without sections, the slides alone.
export type SlideListRow =
	| { readonly kind: "section"; readonly section: number; readonly first: number; readonly count: number }
	| { readonly kind: "slide"; readonly index: number }

export function slideListRows(order: readonly SlideRef[], sections: readonly Section[]): SlideListRow[] {
	if (sections.length === 0) return order.map((_ref, index) => ({ kind: "slide", index }))

	const rows: SlideListRow[] = []
	let index = 0

	covering(order, sections).forEach((section, at) => {
		rows.push({ kind: "section", section: at, first: index, count: section.slides.length })

		for (let left = section.slides.length; left > 0; left--) {
			rows.push({ kind: "slide", index })
			index++
		}
	})

	return rows
}
