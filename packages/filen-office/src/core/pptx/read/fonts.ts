import type { EmbeddedFontRef } from "../../presentation/model"
import { relPart, type ReadContext } from "./drawing"
import { G } from "./xml"

// p:embeddedFontLst (ECMA-376 Part 1 §19.2.1.9): each embedded typeface and the font parts of its four styles
// (obfuscated or EOT data, decoded by core/fonts when the deck is drawn).
export function readEmbeddedFonts(context: ReadContext, list: number): EmbeddedFontRef[] {
	const r = context.reader
	const out: EmbeddedFontRef[] = []

	for (const font of r.children(list, G.P, "embeddedFont")) {
		const face = r.child(font, G.P, "font")
		const typeface = r.attr(face, "typeface") ?? ""

		if (typeface === "") continue

		const style = (local: string): string | undefined => relPart(context, r.rel(r.child(font, G.P, local), "id"))
		const regular = style("regular")
		const bold = style("bold")
		const italic = style("italic")
		const boldItalic = style("boldItalic")
		const charset = r.int(face, "charset")
		const pitchFamily = r.int(face, "pitchFamily")

		out.push({
			typeface,
			...(regular === undefined ? {} : { regular }),
			...(bold === undefined ? {} : { bold }),
			...(italic === undefined ? {} : { italic }),
			...(boldItalic === undefined ? {} : { boldItalic }),
			...(charset === undefined ? {} : { charset }),
			...(pitchFamily === undefined ? {} : { pitchFamily })
		})
	}

	return out
}
