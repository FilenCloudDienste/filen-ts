import type { DeckChanges } from "./edit/apply"
import { findShape } from "./edit/changes"
import type { Deck } from "./model"

// Source pictures and media a save let go of and a later save added again (an undo put their shape back): the
// source's still, never the session's own (dom/presentation/prune.ts authoredEntries), by deck and zip name.
const restored = new WeakMap<object, Set<string>>()

export function noteRestoredMedia(deck: object, name: string): void {
	let names = restored.get(deck)

	if (names === undefined) {
		names = new Set()
		restored.set(deck, names)
	}

	names.add(name.startsWith("/") ? name.slice(1) : name)
}

export function isRestoredMedia(deck: object, name: string): boolean {
	return restored.get(deck)?.has(name.startsWith("/") ? name.slice(1) : name) === true
}

// Whether a save's changes can have let media go: a slide removed, a shape deleted, a fill or background replaced.
// Saves of other edits (moves, text, alt text) never look for released media.
export function mediaDropped(deck: Deck, changes: DeckChanges): boolean {
	if (changes.empty) return false

	const nodes = new Map<string, Deck["nodes"] extends ReadonlyMap<unknown, infer N> ? N : never>()

	for (const node of deck.nodes.values()) if (node.part !== undefined) nodes.set(node.part, node)

	for (const [part, change] of changes.parts) {
		if (change.change === "removed" || (change.slide?.kind === "slidePart" && change.slide.part === "background")) return true

		const node = nodes.get(part)

		for (const [id, dirt] of change.shapes)
			if ((dirt.kind === "props" && dirt.group === "fill") || node === undefined || findShape(node.shapes, id) === undefined)
				return true
	}

	return false
}
