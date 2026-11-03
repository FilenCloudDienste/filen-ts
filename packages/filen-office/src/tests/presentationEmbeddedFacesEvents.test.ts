import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { viewCapability } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { CORPUS_DIR } from "./corpusDir"
import { HmtxMeasurer, nodeFontAssets } from "./layoutFixtures"
import { driveSession } from "./odpWriteDrive"

// The page draws a deck's text only in faces the worker sends it ("fonts" events). Renders run concurrently in the
// worker (the slide, the thumbnails, the editor's text), and a bundled face's bytes are read asynchronously: every
// registered face must still be sent once, the embedded ones included.

const DECK = join(CORPUS_DIR, "pptx/govuk__Civil_Society_Covenant_-_Slide_Pack.pptx")
let ready = false

beforeAll(() => {
	installPresentationRealm({
		text: {
			fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
			replayFonts: true,
			// A fetch takes a while, as the worker's does.
			fontAssets: { read: () => new Promise(resolve => setTimeout(() => resolve(nodeFontAssets.read()), 5)) },
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

describe.skipIf(!existsSync(DECK))("the faces sent to the page", () => {
	it("sends each registered face once, the deck's embedded Roboto included, when renders overlap", { timeout: 120_000 }, async () => {
		const events: { type: string; faces?: { kind: string; face: { family: string; weight: unknown } }[] }[] = []
		const drive = await driveSession(new Uint8Array(readFileSync(DECK)), "pptx", events as never)
		const slides = drive.session.deck.slides

		// Slides 1-3 (Arial) and 9 (Roboto) at once.
		await Promise.all([0, 1, 2, 8].map(k => viewCapability.render(drive.context, [slides[k] ?? slides[0]!])))

		const sent = events.filter(event => event.type === "fonts").flatMap(event => event.faces ?? [])
		const families = sent.map(face => `${face.face.family}:${String(face.face.weight)}`)

		expect(families.filter(family => /-e\d+:(400|700)$/u.test(family)).length).toBe(2)
		expect(new Set(families).size).toBe(families.length)
	})
})
