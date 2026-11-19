import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import type { DeckOp } from "../core/presentation/edit/ops"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { DEFAULTS, pptxBytes, setShow } from "./showSettingsFixtures"

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
			// ODF names the start page (slide 2 is the page "Two") and has no end: the range runs to the last slide.
			expect(await writtenShow(format, saved.bytes)).toBe(
				format === "odp" ? '<presentation:settings presentation:start-page="Two">' : '<p:sldRg st="2" end="2"/>'
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

// A file whose own show range the deck cannot hold (a p:sldRg ending past the last slide, a p:custShow naming no custom
// show): read as the deck can hold it, so the inverse a slide edit or Set Up Slide Show stores applies on undo.
describe("a pptx show range the file states past the deck", () => {
	const STALE_RANGE = '<p:showPr><p:present/><p:sldRg st="2" end="12"/></p:showPr>'
	const UNKNOWN_SHOW = '<p:showPr><p:present/><p:custShow id="7"/></p:showPr>'
	const kioskRestart = (restart: string): string => `<p:showPr><p:kiosk restart="${restart}"/><p:sldRg st="2" end="4"/></p:showPr>`
	const NEGATIVE_RESTART = kioskRestart("-5")
	const HUGE_RESTART = kioskRestart("99999999999")

	async function presProps(bytes: Uint8Array): Promise<string> {
		const zip = await ZipArchive.open(bytesSource(bytes))
		const entry = zip.get("ppt/presProps.xml")

		return entry === undefined ? "(none)" : new TextDecoder().decode(await zip.read(entry))
	}

	it("ends a stale p:sldRg at the last slide, and undo of a slide delete brings the slide back", async () => {
		const drive = await driveSession(pptxBytes(STALE_RANGE), "pptx")
		const slides = [...drive.session.deck.slides]

		expect(drive.session.deck.show.range).toEqual({ kind: "range", start: 2, end: 4 })
		expect((await drive.command({ family: "slide", kind: "delete", slides: [slides[3]] } as DeckOp)).ok).toBe(true)
		expect(drive.session.deck.show.range).toEqual({ kind: "range", start: 2, end: 3 })
		expect((await drive.undo()).ok).toBe(true)
		expect(drive.session.deck.slides).toEqual(slides)
		expect(drive.session.deck.show.range).toEqual({ kind: "range", start: 2, end: 4 })
	}, 60_000)

	it("plays all slides for an unknown p:custShow, and undo of Set Up Slide Show applies", async () => {
		const drive = await driveSession(pptxBytes(UNKNOWN_SHOW), "pptx")

		expect(drive.session.deck.show.range).toEqual({ kind: "all" })
		expect((await drive.command(setShow({ ...DEFAULTS, loop: true }))).ok).toBe(true)
		expect((await drive.undo()).ok).toBe(true)
		expect(drive.session.deck.show).toEqual(DEFAULTS)
	}, 60_000)

	for (const [name, showPr] of [
		["a negative", NEGATIVE_RESTART],
		["an over-unsignedInt", HUGE_RESTART]
	] as const) {
		it(`reads ${name} p:kiosk restart as the default, and undo of Set Up Slide Show applies`, async () => {
			const drive = await driveSession(pptxBytes(showPr), "pptx")
			const read = drive.session.deck.show

			expect(read.restartMs).toBe(300_000)
			expect((await drive.command(setShow({ ...read, loop: true }))).ok).toBe(true)
			expect((await drive.undo()).ok).toBe(true)
			expect(drive.session.deck.show).toEqual(read)
		}, 60_000)

		it(`undoes a range-shrinking slide delete beside ${name} p:kiosk restart`, async () => {
			const drive = await driveSession(pptxBytes(showPr), "pptx")
			const slides = [...drive.session.deck.slides]

			expect((await drive.command({ family: "slide", kind: "delete", slides: [slides[3]] } as DeckOp)).ok).toBe(true)
			expect(drive.session.deck.show.range).toEqual({ kind: "range", start: 2, end: 3 })
			expect((await drive.undo()).ok).toBe(true)
			expect(drive.session.deck.slides).toEqual(slides)
			expect(drive.session.deck.show.range).toEqual({ kind: "range", start: 2, end: 4 })
		}, 60_000)
	}

	for (const [name, showPr] of [
		["a stale p:sldRg", STALE_RANGE],
		["an unknown p:custShow", UNKNOWN_SHOW],
		["a negative p:kiosk restart", NEGATIVE_RESTART],
		["an over-unsignedInt p:kiosk restart", HUGE_RESTART]
	] as const)
		it(`keeps presProps.xml byte-identical when the show is not edited (${name})`, async () => {
			const bytes = pptxBytes(showPr)
			const drive = await driveSession(bytes, "pptx")

			// An edit outside the show: the first slide hidden.
			expect(
				(
					await drive.command({
						family: "slide",
						kind: "hide",
						slides: drive.session.deck.slides.slice(0, 1),
						hidden: true
					} as DeckOp)
				).ok
			).toBe(true)

			const saved = await drive.save()

			expect(saved.result.kind).toBe("written")
			expect(saved.bytes === undefined ? "(none)" : await presProps(saved.bytes)).toBe(await presProps(bytes))
		})
})
