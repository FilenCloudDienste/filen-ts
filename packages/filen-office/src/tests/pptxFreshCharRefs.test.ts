import { describe, expect, it } from "vitest"
import { memorySink } from "@filen/office/core/opc"
import { freshPptx } from "../core/pptx/write/fresh"
import { buildPptx } from "./pptxFixtures"
import { openDeck } from "./pptxWriteFixtures"

// A fresh package copies the source's markup it does not model. An attribute holding a character reference XML does
// not allow (&#x0;) cannot be copied into a well-formed part: the save is refused as malformed, typed, never failed.

const SHAPE =
	'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Box" data-x="&#x0;"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
	'<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>'

describe("a fresh package over markup it cannot copy", () => {
	it("refuses an attribute's invalid character reference as malformed", async () => {
		const opened = await openDeck(buildPptx({ slides: [{ shapes: SHAPE }] }))

		expect(await freshPptx(opened.deck, opened.source, memorySink(), {})).toMatchObject({ kind: "refused", reason: "malformed" })
	})

	it("writes the same deck without that reference", async () => {
		const opened = await openDeck(buildPptx({ slides: [{ shapes: SHAPE.replace(' data-x="&#x0;"', "") }] }))

		expect(await freshPptx(opened.deck, opened.source, memorySink(), {})).toMatchObject({ kind: "written" })
	})
})
