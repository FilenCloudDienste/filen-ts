import { drawingTheme, type DrawingTheme } from "../../drawingml/index"
import type { Deck, SchemeSlot, SlideNode } from "../model"
import { effectiveClrMap, readTheme, themeOf, themeSlot } from "../theme"
import type { RenderServices } from "./services"

// The theme a slide draws with, as the drawing layer reads it: its master's theme part, its colours through the
// colour map in force (core/presentation/theme.ts), and the theme part's own relationships for picture fills in its
// format scheme.

const NO_THEME: DrawingTheme = drawingTheme(undefined, () => undefined)

// The chain a node draws through, nearest first: the node, its layout, its master (notes: the notes master).
export function levels(deck: Deck, node: SlideNode): SlideNode[] {
	const out: SlideNode[] = [node]
	let current = node

	while (current.parent !== undefined && out.length < 4) {
		const parent = deck.nodes.get(current.parent)

		if (parent === undefined || out.includes(parent)) break

		out.push(parent)
		current = parent
	}

	return out
}

export class ThemeCache {
	private readonly services: RenderServices
	private readonly themes = new Map<string, DrawingTheme>()

	constructor(services: RenderServices) {
		this.services = services
	}

	// The theme of a level and everything above it.
	of(deck: Deck, node: SlideNode): DrawingTheme {
		const theme = themeOf(deck.nodes, node)

		if (theme === undefined) return NO_THEME

		const map = effectiveClrMap(deck.nodes, node)
		const key = `${theme.part}\n${String(theme.revision)}\n${Object.values(map).join(",")}`
		let drawing = this.themes.get(key)

		if (drawing === undefined) {
			drawing = this.build(theme.part, name => themeSlot(name as SchemeSlot, map))
			this.themes.set(key, drawing)
		}

		return drawing
	}

	private build(part: string, slot: (name: string) => string | undefined): DrawingTheme {
		const services = this.services
		const document = services.xml(part)

		if (document === undefined) return NO_THEME

		const colors = readTheme(part, document).colors

		return drawingTheme(
			document,
			name => {
				const mapped = slot(name)

				return mapped === undefined ? undefined : colors.get(mapped)
			},
			id => {
				const relationship = services.relationship(part, id)

				return relationship === undefined || relationship.external
					? undefined
					: { partName: relationship.target, contentType: services.contentType(relationship.target) }
			}
		)
	}
}
