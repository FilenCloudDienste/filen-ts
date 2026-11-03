import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { CORPUS_DIR } from "./corpusDir"

const FONT_DECKS = [
	"pptx/govuk__Civil_Society_Covenant_-_Slide_Pack.pptx",
	"pptx/lo__BoldonseFontEmbedded.pptx",
	"pptx/lo__multiplelayoutfooter.pptx",
	"pptx/lo__tdf167214.pptx",
	"pptx/poi__placeholder-layout-color.pptx"
]

// Every .fntdata of the corpus decks and the corpus's own font fixtures.
export function corpusFonts(): { readonly name: string; readonly bytes: Uint8Array }[] {
	const out: { name: string; bytes: Uint8Array }[] = []

	for (const deck of FONT_DECKS) {
		const path = join(CORPUS_DIR, deck)

		if (!existsSync(path)) continue

		for (const [name, bytes] of Object.entries(unzipSync(readFileSync(path))))
			if (name.endsWith(".fntdata")) out.push({ name: `${deck}:${name}`, bytes })
	}

	const fixtures = join(CORPUS_DIR, "fntdata")

	if (existsSync(fixtures))
		for (const name of readdirSync(fixtures)) out.push({ name, bytes: new Uint8Array(readFileSync(join(fixtures, name))) })

	return out
}
