import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import type { DeckOp } from "../core/presentation/edit/ops"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { DEFAULTS, setShow } from "./showSettingsFixtures"

// The Set Up Slide Show range through slide edits: a range never ends past the last slide (pptx p:sldRg), an ODF
// range runs from its start page to the last slide, and undo puts the range back with the slides.

const page = (name: string): string =>
	`<draw:page draw:name="${name}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>${name}</text:p></draw:text-box></draw:frame></draw:page>`

function deckOf(format: "odp" | "pptx"): Uint8Array {
	return format === "odp"
		? odpBytes({ body: page("One") + page("Two") + page("Three") })
		: buildPptx({
				slides: ["One", "Two", "Three"].map(title => ({
					shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(title)))
				}))
			})
}

async function writtenShow(format: "odp" | "pptx", bytes: Uint8Array | undefined): Promise<string> {
	if (bytes === undefined) return "(none)"

	const zip = await ZipArchive.open(bytesSource(bytes))
	const entry = zip.get(format === "odp" ? "content.xml" : "ppt/presProps.xml")

	if (entry === undefined) return "(none)"

	const xml = new TextDecoder().decode(await zip.read(entry))

	return format === "odp" ? (/<presentation:settings[^>]*>/u.exec(xml)?.[0] ?? "") : (/<p:sldRg[^>]*>/u.exec(xml)?.[0] ?? "")
}

describe("the show's slide range through slide edits", () => {
	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: keeps the range inside the deck when a slide is added or deleted, and undo puts it back`, async () => {
			const drive = await driveSession(deckOf(format), format)
			const slides = drive.session.deck.slides

			expect((await drive.command(setShow({ ...DEFAULTS, range: { kind: "range", start: 2, end: 3 } }))).ok).toBe(true)

			// A slide deleted: the range ends at the last slide.
			expect((await drive.command({ family: "slide", kind: "delete", slides: [slides[2]] } as DeckOp)).ok).toBe(true)
			expect(drive.session.deck.show.range).toEqual({ kind: "range", start: 2, end: 2 })

			let saved = await drive.save()

			expect(saved.result.kind).toBe("written")
			expect(await writtenShow(format, saved.bytes)).toMatch(
				format === "odp" ? /presentation:start-page="/u : /<p:sldRg st="2" end="2"\/>/u
			)

			// Undo: the slide and the range as set.
			await drive.undo()
			expect(drive.session.deck.show.range).toEqual({ kind: "range", start: 2, end: 3 })

			// A slide added: pptx keeps its numbers; an ODF range still runs to the last slide.
			expect((await drive.command({ family: "slide", kind: "duplicate", slide: slides[0] } as DeckOp)).ok).toBe(true)
			expect(drive.session.deck.show.range).toEqual({ kind: "range", start: 2, end: format === "odp" ? 4 : 3 })
			saved = await drive.save()
			expect(saved.result.kind).toBe("written")
		}, 60_000)
	}
})
