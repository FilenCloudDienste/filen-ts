import { describe, expect, it } from "vitest"
import { servePresentation } from "../dom/presentation/engine"
import type { OpenInfo, PresentationEvent } from "../dom/presentation/protocol"
import { loopback, LoopbackSession } from "./fixtures/presentation/loopback"
import { buildPpt, FIXTURE_PNG, type FixtureOptions } from "./pptFixtures"

// A PowerPoint 97–2003 deck through the presentation worker's protocol (servePresentation over the loopback): the
// ppt opener converts it to the in-memory pptx in the worker and the other capabilities read that deck as a pptx.

const DECK: FixtureOptions = {
	slides: [
		{
			shapes: [
				{ text: "Hello", textType: 0, placeholder: { type: 13, position: 0 }, anchor: [100, 300, 5400, 700] },
				{ picture: true, anchor: [1000, 1000, 2000, 2000] }
			]
		},
		{ hidden: true, shapes: [{ text: "Hidden", anchor: [100, 100, 1000, 1000] }] }
	],
	png: FIXTURE_PNG
}

async function open(
	bytes: Uint8Array,
	fileName: string
): Promise<{
	readonly session: LoopbackSession
	readonly post: (password: string) => void
	readonly stop: () => void
	readonly event: PresentationEvent
}> {
	const channel = loopback()
	const stop = servePresentation(channel.worker)
	const session = new LoopbackSession(channel.page, 1)
	const event = session.nextEvent()

	channel.page.post({ t: "open", s: 1, source: { kind: "bytes", bytes }, options: { format: "ppt", fileName, viewOnly: true } })

	return {
		session,
		post: password => channel.page.post({ t: "unlock", s: 1, password }),
		stop,
		event: await event
	}
}

function info(event: PresentationEvent): OpenInfo {
	if (event.type !== "opened") throw new Error(`not opened: ${JSON.stringify(event)}`)

	return event.info
}

describe("ppt through the presentation worker", () => {
	it("opens a .pps as a ppt deck of its variant, its slides and hidden flags listed", async () => {
		const { event, stop } = await open((await buildPpt(DECK)).bytes, "Show.pps")
		const opened = info(event)

		expect(opened.format).toBe("ppt")
		expect(opened.variant).toBe("pps")
		expect(opened.slides.map(slide => slide.hidden)).toEqual([false, true])
		expect(opened.protection.encrypted).toBe(false)
		stop()
	})

	it("serves the deck's pictures from the converted package", async () => {
		const { event, session, stop } = await open((await buildPpt(DECK)).bytes, "Deck.ppt")

		info(event)
		expect(await session.call("image", "/ppt/media/image1.png").answer).toMatchObject({ type: "image/png", bytes: FIXTURE_PNG })
		stop()
	})

	it("asks for the password of an encrypted deck, refuses a wrong one, opens with the right one", async () => {
		const { event, session, post, stop } = await open((await buildPpt({ ...DECK, password: "secret" })).bytes, "Template.pot")

		expect(event).toMatchObject({ type: "error", reason: "needsPassword" })

		const wrong = session.nextEvent()

		post("Secret")
		expect(await wrong).toMatchObject({ type: "error", reason: "wrongPassword" })

		const right = session.nextEvent()

		post("secret")

		const opened = info(await right)

		expect(opened.variant).toBe("pot")
		expect(opened.protection.encrypted).toBe(true)
		stop()
	})

	it("refuses a compound file that is not a presentation, typed", async () => {
		const { cfbBytes } = await import("../core/cfb/index")
		const { event, stop } = await open(await cfbBytes([{ path: ["WordDocument"], bytes: new Uint8Array(16) }]), "Not.ppt")

		expect(event).toMatchObject({ type: "error", reason: "unsupported" })
		stop()
	})
})
