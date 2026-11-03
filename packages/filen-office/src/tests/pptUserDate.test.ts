import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { pptToPptx } from "../core/ppt/toPptx"
import { CORPUS_DIR } from "./corpusDir"

// A deck whose headers and footers say the date is a fixed one (HeadersFootersAtom fHasUserDate, [MS-PPT] §2.4.15.2)
// shows that text, never today's date: its date placeholder is written as the text (here none: the deck has no
// UserDateAtom), not as an a:fld PowerPoint updates on open.

const FILE = join(CORPUS_DIR, "ppt/tika__testPPT.ppt")

describe("a .ppt with a fixed date", () => {
	it.skipIf(!existsSync(FILE))("writes the date as fixed text, no date field", async () => {
		const converted = await pptToPptx(bytesSource(new Uint8Array(readFileSync(FILE))))

		if (converted.kind !== "converted") throw new Error(JSON.stringify(converted))

		for (const name of ["ppt/slideMasters/slideMaster1.xml", "ppt/slides/slide1.xml"]) {
			const xml = new TextDecoder().decode(await converted.pptx.read(name))

			expect(xml, name).not.toMatch(/<a:fld [^>]*type="datetime/u)
			expect(xml, name).toContain('<p:ph type="dt"')
		}
	})
})
