import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideRef, Xfrm } from "../core/presentation/model"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { editDeckOptions, editHarness, type EditHarness } from "./presentationEditFixtures"
import { body, buildPptx, DEFAULT_LAYOUTS, para, sp, xfrm } from "./pptxFixtures"

// Any sequence of ops followed by the ops of their inverses (applied as new commands, newest first) leaves the deck
// as it was: the recomputed changes against the saved state are empty, however the history trimmed and coalesced.

function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0

		return state / 4_294_967_296
	}
}

function pick<T>(next: () => number, items: readonly T[]): T | undefined {
	return items.length === 0 ? undefined : items[Math.floor(next() * items.length)]
}

function topShapes(harness: EditHarness, slide: SlideRef): ShapeNode[] {
	return harness.session.deck.nodes.get(slide)?.shapes ?? []
}

function box(next: () => number): Xfrm {
	return {
		x: Math.floor(next() * 8_000_000),
		y: Math.floor(next() * 6_000_000),
		cx: 1 + Math.floor(next() * 2_000_000),
		cy: 1 + Math.floor(next() * 2_000_000),
		rot: pick(next, [0, 0, 5_400_000, 2_700_000]) ?? 0,
		flipH: next() < 0.1,
		flipV: false
	}
}

// The edit deck with a third layout whose body placeholder has idx 7, and a slide with such a body: a layout
// change re-numbers placeholders one way or the other.
function propertyDeck(): Uint8Array {
	const options = editDeckOptions()
	const seven = {
		name: "Seven",
		type: "obj",
		shapes: sp(2, "Title 1", 'type="title"') + sp(3, "Body 7", 'type="body" idx="7"', xfrm(10, 10, 100, 100))
	}

	return buildPptx({
		...options,
		layouts: [...DEFAULT_LAYOUTS, seven],
		slides: options.slides.map((slide, index) =>
			index === 2 ? { ...slide, shapes: slide.shapes + sp(3, "Body", 'type="body" idx="7"', "", body(para("B"))) } : slide
		)
	})
}

let inserted = 0

function randomOp(harness: EditHarness, next: () => number): DeckOp | undefined {
	const deck = harness.session.deck
	const parsed = deck.slides.filter(ref => deck.nodes.has(ref))
	const slide = pick(next, parsed)

	if (slide === undefined) return undefined

	const shapes = topShapes(harness, slide)
	const free = shapes.filter(shape => shape.ph === undefined && shape.xfrm !== undefined)
	const any = pick(next, shapes)
	const target = (shape: ShapeNode | undefined): { slide: SlideRef; id: number } | undefined =>
		shape === undefined ? undefined : { slide, id: shape.id }
	const roll = Math.floor(next() * 19)

	switch (roll) {
		case 0:
		case 1: {
			const at = target(any)

			return at === undefined
				? undefined
				: { family: "shape", kind: "setXfrm", target: at, xfrm: next() < 0.1 ? undefined : box(next) }
		}
		case 2: {
			const at = target(any)
			const fill =
				next() < 0.3
					? "none"
					: {
							kind: "solid" as const,
							color: {
								kind: "srgb" as const,
								rgb: Math.floor(next() * 0xffffff)
									.toString(16)
									.padStart(6, "0")
							}
						}

			return at === undefined
				? undefined
				: { family: "shape", kind: "setProps", target: at, props: next() < 0.2 ? { fill: undefined } : { fill } }
		}
		case 3: {
			const at = target(any)

			return at === undefined
				? undefined
				: {
						family: "shape",
						kind: "setAlt",
						target: at,
						alt: next() < 0.2 ? undefined : { descr: `d${String(Math.floor(next() * 10))}` }
					}
		}
		case 4: {
			const ids = shapes.filter(() => next() < 0.4).map(shape => shape.id)

			return ids.length === 0
				? undefined
				: {
						family: "shape",
						kind: "zOrder",
						slide,
						shapes: ids,
						to: pick(next, ["front", "back", "forward", "backward"] as const) ?? "front"
					}
		}
		case 5:
			return any === undefined || shapes.length < 2 ? undefined : { family: "shape", kind: "delete", slide, shapes: [any.id] }
		case 6:
			inserted++

			return {
				family: "shape",
				kind: "insert",
				slide,
				shape: {
					id: 0,
					name: `New ${String(inserted)}`,
					hidden: false,
					kind: "sp",
					xfrm: box(next),
					props: { geometry: { kind: "preset", preset: "rect", guides: [] } }
				},
				index: Math.floor(next() * (shapes.length + 1))
			}
		case 7: {
			const a = pick(next, free)
			const b = pick(
				next,
				free.filter(shape => shape !== a)
			)

			return a === undefined || b === undefined ? undefined : { family: "shape", kind: "group", slide, shapes: [a.id, b.id] }
		}
		case 8: {
			const group = pick(
				next,
				shapes.filter(shape => shape.kind === "grpSp")
			)

			return group === undefined ? undefined : { family: "shape", kind: "ungroup", slide, group: group.id }
		}
		case 9:
			return free.length < 2
				? undefined
				: {
						family: "shape",
						kind: "align",
						slide,
						shapes: free.map(shape => shape.id),
						edge: pick(next, ["left", "center", "right", "top", "middle", "bottom"] as const) ?? "left",
						relativeTo: next() < 0.5 ? "slide" : "selection"
					}
		case 10:
			return free.length < 1
				? undefined
				: {
						family: "shape",
						kind: "distribute",
						slide,
						shapes: free.map(shape => shape.id),
						axis: next() < 0.5 ? "horizontal" : "vertical",
						relativeTo: next() < 0.5 ? "slide" : "selection"
					}
		case 11:
			return { family: "slide", kind: "hide", slides: [slide], hidden: next() < 0.5 }
		case 12:
			return { family: "slide", kind: "move", slides: [slide], to: Math.floor(next() * deck.slides.length) }
		case 13: {
			const layout = pick(next, deck.layouts)

			return layout === undefined || deck.slides.length > 8
				? undefined
				: { family: "slide", kind: "add", at: Math.floor(next() * (deck.slides.length + 1)), layout }
		}
		case 14:
			return deck.slides.length > 8 ? undefined : { family: "slide", kind: "duplicate", slide }
		case 15:
			return deck.slides.length < 3 ? undefined : { family: "slide", kind: "delete", slides: [slide] }
		case 16: {
			// Several slides at once, anywhere in the deck (their inverse must restore the whole order).
			const slides = deck.slides.filter(() => next() < 0.5)

			return slides.length < 2 ? undefined : { family: "slide", kind: "move", slides, to: Math.floor(next() * deck.slides.length) }
		}
		case 17: {
			const layout = pick(next, deck.layouts)

			return layout === undefined ? undefined : { family: "slide", kind: "setLayout", slide, layout }
		}
		default: {
			if (deck.sections.length < 2) return undefined

			const split = 1 + Math.floor(next() * (deck.slides.length - 1))

			return {
				family: "slide",
				kind: "setSections",
				sections: [
					{ ...(deck.sections[0] as never as { name: string; id: string }), slides: deck.slides.slice(0, split) },
					{ ...(deck.sections[1] as never as { name: string; id: string }), slides: deck.slides.slice(split) }
				]
			}
		}
	}
}

describe("presentation edit property", () => {
	it("10,000 random op sequences followed by their inverses recompute an empty set of changes", async () => {
		const harness = await editHarness(propertyDeck())

		for (const ref of [...harness.session.deck.slides]) await harness.slide(harness.session.deck.slides.indexOf(ref))

		const edits = sessionEdits(harness.session)
		const next = random(0x5eed)
		let applied = 0

		for (let sequence = 0; sequence < 10_000; sequence++) {
			const inverses: (readonly DeckOp[])[] = []
			const length = 1 + Math.floor(next() * 4)

			for (let index = 0; index < length; index++) {
				const op = randomOp(harness, next)

				if (op === undefined) continue

				const steps = edits.history.revision
				const result = await harness.command(op)

				// A refused op, or one that changed nothing (no step), has no inverse.
				if (!result.ok || edits.history.revision === steps) continue

				applied++
				inverses.push(edits.history.peekUndo()?.inverse.ops ?? [])
			}

			for (const ops of inverses.reverse()) {
				for (const op of ops) {
					const result = await harness.command(op)

					if (!result.ok)
						throw new Error(
							`inverse refused (${result.refusal}) at sequence ${String(sequence)}: ${JSON.stringify(op).slice(0, 300)}`
						)
				}
			}

			const changes = edits.changes()

			if (!changes.empty) {
				throw new Error(
					`sequence ${String(sequence)}: ${JSON.stringify([...edits.history.dirtyTouchKeys()])} ${JSON.stringify([...changes.parts.keys()])}`
				)
			}
		}

		expect(applied).toBeGreaterThan(10_000)
		expect(edits.history.size.steps).toBeLessThanOrEqual(500)
		harness.close()
	}, 600_000)
})
