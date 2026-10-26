import { describe, expect, it, vi } from "vitest"
import type { SlideRef } from "../core/presentation/model"
import type { OpenCapability, ServeOptions } from "../dom/presentation/engine"
import { inThreadPresentationWorker, presentationWorkerPool } from "../dom/presentation/host"
import type { PresentationEvent } from "../dom/presentation/protocol"
import { openWindowRefs } from "../dom/presentation/window"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"

// The open of a deck: the window the page asked for streams as "slides" events, the shown slide first and alone, the
// last one final; and what an opener kept (a decrypted package's key) is released when the deck is closed or the open
// abandoned before the opener answers.

const bytes = (): Uint8Array => new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)])
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

function opener(release?: () => void): { readonly capability: OpenCapability; finish(): void; readonly immediate: boolean } {
	let finish: (() => void) | undefined
	const immediate = release === undefined

	return {
		immediate,
		finish: () => finish?.(),
		capability: {
			open: request =>
				new Promise(resolve => {
					const answer = (): void =>
						resolve({
							kind: "opened",
							deck: fixtureDeck(),
							package: {
								format: "pptx",
								variant: "pptx",
								bytes: request.source.size,
								source: request.source,
								sourceKind: request.sourceKind,
								locks: 0,
								...(release === undefined ? {} : { release })
							}
						})

					if (immediate) answer()
					else finish = answer
				})
		}
	}
}

describe("presentation open window", () => {
	it("streams the window one slide per event, the shown slide first and the last one final", async () => {
		const asked: SlideRef[][] = []
		const options: ServeOptions = {
			openers: { pptx: opener().capability },
			handlers: {
				render: (context, refs) => {
					asked.push([...refs])

					return Promise.resolve(
						refs.map(ref => fixtureSlideRender(context.session.deck, context.session.deck.slides.indexOf(ref)))
					)
				}
			}
		}
		const pool = presentationWorkerPool(() => inThreadPresentationWorker(options))
		const events: PresentationEvent[] = []
		const deck = fixtureDeck()

		pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx", window: { from: 1, count: 2 } }, event =>
			events.push(event)
		)
		await vi.waitFor(() => {
			expect(events.filter(event => event.type === "slides").some(event => event.type === "slides" && event.final)).toBe(true)
		})

		const slides = events.filter(event => event.type === "slides")

		expect(events[0]?.type).toBe("opened")
		expect(asked).toEqual([[deck.slides[1]], [deck.slides[2]]])
		expect(slides.map(event => [event.renders.map(render => render.ref), event.final])).toEqual([
			[[deck.slides[1]], false],
			[[deck.slides[2]], true]
		])
		pool.dispose()
	})

	it("clamps the window into the deck", () => {
		const refs = [10, 11, 12] as unknown as SlideRef[]

		expect(openWindowRefs(refs, { from: 9, count: 3 })).toEqual([12])
		expect(openWindowRefs(refs, { from: -2, count: 2 })).toEqual([10, 11])
		expect(openWindowRefs(refs, { from: 0, count: 0 })).toEqual([])
	})

	it("sends no window when none is asked for", async () => {
		const options: ServeOptions = { openers: { pptx: opener().capability } }
		const pool = presentationWorkerPool(() => inThreadPresentationWorker(options))
		const events: PresentationEvent[] = []

		pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx" }, event => events.push(event))
		await tick()
		await tick()

		expect(events.map(event => event.type)).toEqual(["opened"])
		pool.dispose()
	})

	it("releases what the opener kept when the deck closes before the open finishes", async () => {
		const release = vi.fn()
		const slow = opener(release)
		const pool = presentationWorkerPool(() => inThreadPresentationWorker({ openers: { pptx: slow.capability } }))
		const client = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx" }, () => undefined)

		await tick()
		client.close()
		await tick()
		slow.finish()
		await tick()

		expect(release).toHaveBeenCalledTimes(1)
		pool.dispose()
	})

	it("releases what the opener kept when the open is abandoned before it finishes", async () => {
		const release = vi.fn()
		const slow = opener(release)
		const pool = presentationWorkerPool(() => inThreadPresentationWorker({ openers: { pptx: slow.capability } }))
		const client = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx" }, () => undefined)

		await tick()
		client.abortOpen()
		await tick()
		slow.finish()
		await tick()

		expect(release).toHaveBeenCalledTimes(1)
		pool.dispose()
	})
})
