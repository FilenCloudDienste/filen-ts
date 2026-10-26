import { NodeKind, type XmlDocument } from "../xml/index"
import type { Background, ClrMap, Deck, SlideNode } from "./model"
import { effectiveClrMap, themeOf } from "./theme"

// The background a slide shows (ECMA-376 Part 1 §19.3.1.1): its own p:bg, else its layout's, else its master's
// (showMasterSp hides shapes, never the background). A p:bgRef names a background fill style of the theme
// (idx ≥ 1001 into bgFillStyleLst, 1–999 into fillStyleLst, §20.1.4.1.7) drawn with its colour as phClr.

export interface ResolvedBackground {
	readonly background: Background
	// The level the background came from.
	readonly node: SlideNode
	// The colour map and theme the slide's colours resolve through (the slide's own, not the level's).
	readonly clrMap: ClrMap
	readonly theme: SlideNode["theme"]
}

export function resolveBackground(deck: Deck, slide: SlideNode): ResolvedBackground | undefined {
	let at: SlideNode | undefined = slide

	for (let guard = 0; at !== undefined && guard < 4; guard++) {
		if (at.background !== undefined) {
			return { background: at.background, node: at, clrMap: effectiveClrMap(deck.nodes, slide), theme: themeOf(deck.nodes, slide) }
		}

		at = at.parent === undefined ? undefined : deck.nodes.get(at.parent)
	}

	return undefined
}

// The theme element a p:bgRef idx (or a p:style fillRef idx) names: a child of a:bgFillStyleLst (idx ≥ 1001) or
// a:fillStyleLst (1–999), or -1 (idx 0 and 1000 mean no background / no fill).
export function themeFillStyle(theme: XmlDocument, idx: number): number {
	const list = idx >= 1001 ? "bgFillStyleLst" : idx >= 1 && idx <= 999 ? "fillStyleLst" : undefined

	if (list === undefined) return -1

	const position = idx >= 1001 ? idx - 1001 : idx - 1
	const container = descendant(theme, theme.documentElement(), ["themeElements", "fmtScheme", list])
	let index = 0

	for (let child = container < 0 ? -1 : theme.firstChildElement(container); child >= 0; child = theme.nextSiblingElement(child)) {
		if (index++ === position) return child
	}

	return -1
}

function descendant(document: XmlDocument, node: number, path: readonly string[]): number {
	let at = node

	for (const local of path) {
		let next = -1

		for (let child = at < 0 ? -1 : document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.kinds[child] === NodeKind.Element && document.localName(child) === local) {
				next = child

				break
			}
		}

		at = next
	}

	return at
}
