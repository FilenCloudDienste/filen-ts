// @vitest-environment happy-dom
import { act } from "react"
import { describe, expect, it, vi } from "vitest"
import { slideRef, type SlideRef } from "../core/presentation/model"
import type { PresentationEvent, PresentationSessionApi, SlideRender } from "../dom/presentation/protocol"
import { createPresentationStore, type PresentationConnection, type PresentationHost } from "../react/presentation/store"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"

// A changed slide keeps its render until its new one arrives: an edit never blanks the slide (and the controls that
// follow the selection on it) for the worker's round trip.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

async function flush(turns = 5): Promise<void> {
	await act(async () => {
		for (let i = 0; i < turns; i++) await Promise.resolve()
	})
}

describe("the store's renders across a change", () => {
	it("shows a changed slide's render until its new one arrives", async () => {
		let listener: ((event: PresentationEvent) => void) | undefined
		let revision = 0
		let answer: ((renders: SlideRender[]) => void) | undefined
		const renderOf = (ref: SlideRef): SlideRender => ({
			...fixtureSlideRender(fixtureDeck(1), 0),
			ref,
			index: Number(ref) - 10,
			revision
		})
		const render = vi.fn((refs: readonly SlideRef[]) =>
			revision === 0 ? Promise.resolve(refs.map(renderOf)) : new Promise<SlideRender[]>(resolve => (answer = resolve))
		)
		const session = { render, thumbnails: vi.fn(() => Promise.resolve()), close: vi.fn() } as unknown as PresentationSessionApi
		const host: PresentationHost = (_source, onEvent) => {
			listener = onEvent

			return { session, unlock: vi.fn(), dispose: vi.fn() } satisfies PresentationConnection
		}
		const store = createPresentationStore({
			host,
			source: { kind: "bytes", bytes: new Uint8Array(1) },
			options: { format: "pptx", fileName: "deck.pptx" },
			renderWindow: 1
		})
		const unsubscribe = store.subscribe(() => undefined)
		const ref = slideRef(10)

		listener?.({
			type: "opened",
			info: {
				format: "pptx",
				variant: "pptx",
				slides: [{ ref, hidden: false }],
				size: { cx: 12_192_000, cy: 6_858_000 },
				notesSize: { cx: 6_858_000, cy: 9_144_000 },
				sections: [],
				customShows: [],
				protection: { writeProtected: false, encrypted: false },
				gate: [],
				editable: true,
				locks: 0,
				packageBytes: 1000,
				source: "bytes"
			}
		})
		await flush(20)

		const old = store.getSnapshot().renders.get(ref)

		expect(old?.revision).toBe(0)

		revision = 1
		listener?.({ type: "changed", revision: 1, dirty: true, slides: [ref] })
		await flush()

		expect(store.getSnapshot().renders.get(ref)).toBe(old)
		expect(render).toHaveBeenCalledTimes(2)

		answer?.([renderOf(ref)])
		await flush()

		expect(store.getSnapshot().renders.get(ref)?.revision).toBe(1)
		unsubscribe()
		store.dispose()
	})
})
