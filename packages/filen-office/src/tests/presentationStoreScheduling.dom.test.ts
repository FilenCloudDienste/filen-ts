// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"

const { released } = vi.hoisted(() => ({ released: [] as unknown[] }))

vi.mock("../react/presentation/paint/slide", () => ({
	releaseSlidePictures: (session: unknown) => {
		released.push(session)
	}
}))
import { slideRef, type SlideRef } from "../core/presentation/model"
import type { OpenInfo, PresentationEvent, PresentationSessionApi, SlideRender } from "../dom/presentation/protocol"
import { thumbnailOrder } from "../react/shared/railWindow"
import { createPresentationStore, type PresentationConnection, type PresentationHost } from "../react/presentation/store"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"

// Worker time goes to what the page shows: the open window streams first and the rest of the window waits for it,
// the slide in view is asked for before its neighbours, and work for a window or a rail range the user left is
// aborted.

interface Deferred<T> {
	readonly promise: Promise<T>
	resolve(value: T): void
	reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined
	let reject: (error: unknown) => void = () => undefined
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})

	return { promise, resolve, reject }
}

function render(ref: SlideRef): SlideRender {
	return { ...fixtureSlideRender(fixtureDeck(1), 0), ref, index: Number(ref) - 10 }
}

function info(count: number): OpenInfo {
	return {
		format: "pptx",
		variant: "pptx",
		slides: Array.from({ length: count }, (_, index) => ({ ref: slideRef(10 + index), hidden: false })),
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
}

function fake() {
	let listener: ((event: PresentationEvent) => void) | undefined
	const renders: { refs: readonly SlideRef[]; call: Deferred<SlideRender[]> }[] = []
	const thumbs: { refs: readonly SlideRef[]; call: Deferred<undefined> }[] = []
	const aborted: Promise<unknown>[] = []
	const session = {
		render: vi.fn((refs: readonly SlideRef[]) => {
			const call = deferred<SlideRender[]>()

			renders.push({ refs, call })

			return call.promise
		}),
		thumbnails: vi.fn((refs: readonly SlideRef[]) => {
			const call = deferred<undefined>()

			thumbs.push({ refs, call })

			return call.promise
		}),
		close: vi.fn()
	} as unknown as PresentationSessionApi
	const abort = (call: Promise<unknown>): void => {
		aborted.push(call)

		const rejects = [...renders, ...thumbs].filter(entry => entry.call.promise === call).map(entry => entry.call.reject)

		for (const reject of rejects) reject(new Error("aborted"))
	}
	const host: PresentationHost = (_source, onEvent) => {
		listener = onEvent

		return { session, unlock: vi.fn(), abort, dispose: vi.fn() } satisfies PresentationConnection
	}

	return { host, renders, thumbs, aborted, emit: (event: PresentationEvent) => listener?.(event) }
}

const settle = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve()
}

function open(window?: { from: number; count: number }, renderWindow = 3) {
	const host = fake()
	const store = createPresentationStore({
		host: host.host,
		source: { kind: "bytes", bytes: new Uint8Array(1) },
		options: { format: "pptx", fileName: "a.pptx", ...(window === undefined ? {} : { window }) },
		renderWindow
	})

	store.subscribe(() => undefined)

	return { host, store }
}

describe("presentation store scheduling", () => {
	it("leaves the open window to the worker's stream and asks for the rest of the window after it", async () => {
		const { host, store } = open({ from: 0, count: 2 })

		host.emit({ type: "opened", info: info(20) })
		await settle()

		expect(store.getSnapshot().status).toBe("streaming")
		expect(host.renders).toEqual([])

		host.emit({ type: "slides", renders: [render(slideRef(10))], final: false })
		await settle()
		expect(store.getSnapshot().renders.has(slideRef(10))).toBe(true)
		expect(host.renders).toEqual([])

		host.emit({ type: "slides", renders: [render(slideRef(11))], final: true })
		await settle()

		expect(store.getSnapshot().status).toBe("ready")
		// Slides 0 and 1 came by the stream: the window's rest, one per call, nearest first.
		expect(host.renders.map(entry => entry.refs)).toEqual([[slideRef(12)]])
		host.renders[0]?.call.resolve([render(slideRef(12))])
		await settle()
		expect(host.renders.map(entry => entry.refs)).toEqual([[slideRef(12)], [slideRef(13)]])
		store.dispose()
	})

	it("asks for the slide in view first, then its neighbours nearest first", async () => {
		const { host, store } = open(undefined, 2)

		host.emit({ type: "opened", info: info(20) })
		store.setWindow(5)
		await settle()
		// Slide 0, asked for at the open, was aborted by the move.
		host.renders.shift()

		for (let k = 0; k < 5; k++) {
			const last = host.renders[host.renders.length - 1]

			last?.call.resolve(last.refs.map(render))
			await settle()
		}

		expect(host.renders.map(entry => Number(entry.refs[0]) - 10)).toEqual([5, 6, 4, 7, 3])
		store.dispose()
	})

	it("aborts the slide in flight when the window moves away from it, and asks for the new slide at once", async () => {
		const { host, store } = open(undefined, 2)

		host.emit({ type: "opened", info: info(100) })
		await settle()

		const first = host.renders[0]

		expect(first?.refs).toEqual([slideRef(10)])

		store.setWindow(80)
		await settle()

		expect(host.aborted).toHaveLength(1)
		expect(host.aborted[0]).toBe(first?.call.promise)
		expect(host.renders[1]?.refs).toEqual([slideRef(90)])
		store.dispose()
	})

	it("keeps the slide in flight when the new window still holds it", async () => {
		const { host, store } = open(undefined, 2)

		host.emit({ type: "opened", info: info(100) })
		await settle()
		store.setWindow(1)
		await settle()

		expect(host.aborted).toHaveLength(0)
		store.dispose()
	})

	it("keeps one thumbnail batch in flight, replacing it when the rail shows other slides", async () => {
		const { host, store } = open()

		host.emit({ type: "opened", info: info(100) })
		store.requestThumbnails([slideRef(10), slideRef(11)], 192)
		await settle()
		// The same slides again (the rail re-asks as thumbnails land): nothing new.
		store.requestThumbnails([slideRef(10), slideRef(11)], 192)
		await settle()
		store.requestThumbnails([slideRef(11), slideRef(12)], 192)
		await settle()
		store.requestThumbnails([slideRef(60), slideRef(61)], 192)
		await settle()

		expect(host.thumbs.map(entry => entry.refs)).toEqual([
			[slideRef(10), slideRef(11)],
			[slideRef(11), slideRef(12)],
			[slideRef(60), slideRef(61)]
		])
		expect(host.aborted).toHaveLength(2)
		expect(host.aborted[0]).toBe(host.thumbs[0]?.call.promise)
		expect(host.aborted[1]).toBe(host.thumbs[1]?.call.promise)

		// A thumbnail that landed is never asked for again; the rest of a slide shown again is.
		host.emit({
			type: "thumbs",
			items: [{ slide: slideRef(60), revision: 0, bitmap: { width: 192, height: 108, close: () => undefined } }]
		})
		store.requestThumbnails([slideRef(60), slideRef(11)], 192)
		await settle()

		expect(host.thumbs[3]?.refs).toEqual([slideRef(11)])
		store.dispose()
	})

	it("asks the rail's thumbnails in view first, then the overscan nearest first", () => {
		expect(thumbnailOrder({ first: 7, last: 16 }, { first: 10, last: 13 })).toEqual([10, 11, 12, 13, 14, 9, 15, 8, 16, 7])
		expect(thumbnailOrder({ first: 0, last: 5 }, { first: 0, last: 2 })).toEqual([0, 1, 2, 3, 4, 5])
	})

	it("revokes the deck's slide pictures when the worker fails, and keeps what was open", async () => {
		const { host, store } = open()

		host.emit({ type: "opened", info: info(3) })
		await settle()

		const session = store.getSnapshot().session

		released.length = 0
		host.emit({ type: "error", reason: "failed", message: "The presentation worker failed" })

		expect(released).toEqual([session])
		expect(store.getSnapshot()).toMatchObject({ status: "error", info: { slides: info(3).slides } })

		store.dispose()
		expect(released).toEqual([session])
	})
})
