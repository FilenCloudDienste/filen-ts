import { PresentationError } from "../../../core/presentation/model"
import { slideOutline } from "../../../core/presentation/outline"
import type { OutlineCapability } from "../engine"
import { viewParts } from "./view"

// The Selection Pane's outline of one slide (core/presentation/outline.ts), read from the session's model when asked;
// a slide not parsed yet is parsed first (the pane asks after its render, so it seldom is).
export const outlineCapability: OutlineCapability = {
	outline: async (context, slide) => {
		const deck = context.session.deck

		if (!deck.slides.includes(slide)) throw new PresentationError("notFound", "slide")

		const node = deck.nodes.get(slide) ?? (await viewParts(deck)?.slide(slide, context.slicing))

		if (node === undefined) throw new PresentationError("notImplemented", "outline")
		if (context.signal.aborted) throw new PresentationError("aborted", "outline")

		return slideOutline(node)
	}
}
