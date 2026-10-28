import type { Deck, SlideNode } from "../../model"
import type { ApplyContext } from "../apply"
import { isRefused } from "./shape"
import { overlayNode, type SlideSourceReading } from "./slide"

// An ODP page's source markup held by an inverse: an undo after a save puts the page back on that markup (as a
// deleted page's restore does), so the next save writes the page as the file had it, edits since then aside.

export function sourceReading(context: ApplyContext): SlideSourceReading | undefined {
	return "readSlides" in context ? (context as SlideSourceReading) : undefined
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false

	return true
}

// An ODP page's source markup as it is now (undefined: a page an op made, or no reading here).
export function pageMarkup(node: SlideNode, reading: SlideSourceReading | undefined): Uint8Array | undefined {
	const parts = node.src === undefined || reading === undefined ? undefined : reading.rawParts(node)

	return parts === undefined || isRefused(parts) ? undefined : parts[0]?.bytes
}

// The page put back on held markup a save since took out of the file: the slide and its notes read their sources
// there. A refusal's reason when the markup does not read.
export function onHeldPage(deck: Deck, node: SlideNode, raw: Uint8Array, reading: SlideSourceReading): string | undefined {
	const live = pageMarkup(node, reading)

	if (live !== undefined && sameBytes(live, raw)) return undefined

	const read = reading.readSlides(node.ref, [{ name: `/content.xml#${String(node.ref)}`, contentType: "", bytes: raw }])

	if (isRefused(read)) return read.detail ?? read.reason

	const page = overlayNode(node, read[0])

	if (page.src === undefined) delete node.src
	else node.src = page.src

	const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

	if (notes !== undefined && read[1] !== undefined) {
		const held = overlayNode(notes, read[1])

		if (held.src === undefined) delete notes.src
		else notes.src = held.src
	}

	return undefined
}
