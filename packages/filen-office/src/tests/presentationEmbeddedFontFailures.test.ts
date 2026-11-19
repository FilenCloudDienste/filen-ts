import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sessionFaces, viewCapability } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { HmtxMeasurer, nodeFontAssets } from "./layoutFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, sp, xfrm } from "./pptxFixtures"

// A deck embedding a regular face for "Deck Font" that is no font at all, with text drawn in it: the refusal reaches
// the realm's log once, as a code with the family and style, whichever path loaded the face.

const DECK = buildPptx({
	slides: [
		{
			shapes: sp(
				2,
				"TextBox 1",
				undefined,
				xfrm(100_000, 100_000, 3_000_000, 500_000),
				body('<a:p><a:r><a:rPr lang="en-GB"><a:latin typeface="Deck Font"/></a:rPr><a:t>Text</a:t></a:r></a:p>')
			)
		}
	],
	presentation:
		'<p:embeddedFontLst><p:embeddedFont><p:font typeface="Deck Font" charset="0"/><p:regular r:id="rId60"/></p:embeddedFont></p:embeddedFontLst>',
	presentationRels: [["rId60", "font", "fonts/font1.fntdata"]],
	parts: { "ppt/fonts/font1.fntdata": { data: new Uint8Array(1000), type: "application/x-fontdata" } }
})

const EXPECTED = [["Embedded font not used", { code: "notSfnt", family: "Deck Font", bold: false, italic: false }]]

let ready = false

beforeAll(() => {
	installPresentationRealm({
		text: {
			fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
			replayFonts: true,
			fontAssets: nodeFontAssets,
			measurer: new HmtxMeasurer(),
			yield: () => Promise.resolve()
		},
		canvas: {
			canvas: () => undefined,
			decode: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(undefined),
			fontsReady: () => Promise.resolve()
		}
	})
	ready = true
})

afterAll(() => {
	if (ready) installPresentationRealm(undefined)
})

function logged(warn: { mock: { calls: unknown[][] } }): unknown[][] {
	return warn.mock.calls.filter(call => call[0] === "Embedded font not used")
}

describe("a deck's embedded font failures", () => {
	it("reach the log once when a render needs the face", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

		try {
			const drive = await driveSession(DECK, "pptx")
			const slide = drive.session.deck.slides[0]

			if (slide === undefined) throw new Error("no slide")

			await viewCapability.render(drive.context, [slide])

			expect(logged(warn)).toEqual(EXPECTED)

			// Rendered again: nothing new failed, nothing more is logged.
			await viewCapability.render(drive.context, [slide])
			await sessionFaces(drive.session)

			expect(logged(warn)).toEqual(EXPECTED)
		} finally {
			warn.mockRestore()
		}
	})

	it("reach the log once when an export loads the faces no render reached", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

		try {
			const drive = await driveSession(DECK, "pptx")

			await sessionFaces(drive.session)

			expect(logged(warn)).toEqual(EXPECTED)

			await sessionFaces(drive.session)

			expect(logged(warn)).toEqual(EXPECTED)
		} finally {
			warn.mockRestore()
		}
	})
})
