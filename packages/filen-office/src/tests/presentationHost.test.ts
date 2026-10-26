import { afterEach, describe, expect, it, vi } from "vitest"
import { slideRef } from "../core/presentation/model"
import type { OpenCapability, ServeOptions } from "../dom/presentation/engine"
import {
	closeBitmapsOf,
	inThreadPresentationWorker,
	PresentationCallError,
	presentationWorkerPool,
	type PresentationWorkerLike
} from "../dom/presentation/host"
import type { FromPresentationWorker, PresentationEvent, ToPresentationWorker } from "../dom/presentation/protocol"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"

// Both ends of the presentation worker: the page's pool (a worker per open deck, one kept idle for a minute and
// reused), the session client (calls by id, refusals typed, aborts, the password round), and bitmaps of messages
// nobody receives closed.

const bytes = (): Uint8Array => new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)])

function opener(password?: string): OpenCapability {
	return {
		open: request => {
			if (password !== undefined && request.password !== password) return Promise.resolve({ kind: "needsPassword" })

			return Promise.resolve({
				kind: "opened",
				deck: fixtureDeck(),
				package: {
					format: "pptx",
					variant: "pptx",
					bytes: request.source.size,
					source: request.source,
					sourceKind: request.sourceKind,
					locks: 0
				}
			})
		}
	}
}

function serve(password?: string, extra: ServeOptions = {}): ServeOptions {
	return {
		openers: { pptx: opener(password) },
		handlers: {
			render: (context, refs) =>
				Promise.resolve(refs.map(ref => fixtureSlideRender(context.session.deck, context.session.deck.slides.indexOf(ref)))),
			find: (context, query) =>
				new Promise((resolve, reject) => {
					if (query === "never") context.signal.onAbort(() => reject(new Error("aborted")))
					else resolve(new Int32Array([0, 2, 0, 0, 4, 0]))
				})
		},
		...extra
	}
}

function counted(options: ServeOptions): { readonly made: PresentationWorkerLike[]; create(): PresentationWorkerLike } {
	const made: PresentationWorkerLike[] = []

	return {
		made,
		create() {
			const worker = inThreadPresentationWorker(options)
			const terminate = worker.terminate.bind(worker)

			made.push(worker)
			worker.terminate = vi.fn(terminate)

			return worker
		}
	}
}

function events(): {
	readonly list: PresentationEvent[]
	next(type: PresentationEvent["type"]): Promise<PresentationEvent>
	listener(event: PresentationEvent): void
} {
	const list: PresentationEvent[] = []
	const waiting: [PresentationEvent["type"], (event: PresentationEvent) => void][] = []

	return {
		list,
		next(type) {
			const seen = list.find(event => event.type === type)

			return seen !== undefined ? Promise.resolve(seen) : new Promise(resolve => waiting.push([type, resolve]))
		},
		listener(event) {
			list.push(event)

			for (const [index, [type, resolve]] of [...waiting.entries()].reverse()) {
				if (type === event.type) {
					waiting.splice(index, 1)
					resolve(event)
				}
			}
		}
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe("presentation worker pool", () => {
	it("opens a deck, answers its calls and refuses them typed once it is closed", async () => {
		const workers = counted(serve())
		const pool = presentationWorkerPool(() => workers.create())
		const heard = events()
		const client = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx" }, heard.listener)
		const opened = await heard.next("opened")

		expect(opened.type === "opened" && opened.info.slides.map(slide => slide.ref)).toEqual([10, 11, 12])

		const [render] = await client.render([slideRef(11)])

		expect(render?.index).toBe(1)
		expect(render?.layers.length).toBeGreaterThan(0)
		expect(await client.find("x")).toEqual(new Int32Array([0, 2, 0, 0, 4, 0]))
		await expect(client.timegraph(slideRef(10))).rejects.toMatchObject({ reason: "notImplemented" })

		client.close()

		expect(client.closed).toBe(true)
		await expect(client.render([slideRef(10)])).rejects.toBeInstanceOf(PresentationCallError)
		await expect(client.render([slideRef(10)])).rejects.toMatchObject({ reason: "closed" })
		pool.dispose()
	})

	it("reports slides hidden at open and releases what the opener kept when the deck closes", async () => {
		const release = vi.fn()
		const hiding: OpenCapability = {
			open: request => {
				const deck = fixtureDeck()

				deck.hiddenSlides = new Set([slideRef(11)])

				for (const ref of deck.slides) deck.nodes.delete(ref)

				return Promise.resolve({
					kind: "opened",
					deck,
					package: {
						format: "pptx",
						variant: "pptx",
						bytes: request.source.size,
						source: request.source,
						sourceKind: request.sourceKind,
						locks: 0,
						release
					}
				})
			}
		}
		const pool = presentationWorkerPool(() => inThreadPresentationWorker({ openers: { pptx: hiding } }))
		const heard = events()
		const client = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx" }, heard.listener)
		const opened = await heard.next("opened")

		expect(opened.type === "opened" && opened.info.slides.map(slide => slide.hidden)).toEqual([false, true, false])
		expect(release).not.toHaveBeenCalled()

		client.close()
		await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
		pool.dispose()
		expect(release).toHaveBeenCalledTimes(1)
	})

	it("aborts a call by its promise", async () => {
		const pool = presentationWorkerPool(() => inThreadPresentationWorker(serve()))
		const heard = events()
		const client = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx" }, heard.listener)

		await heard.next("opened")

		const call = client.find("never")

		client.abort(call)

		await expect(call).rejects.toMatchObject({ reason: "aborted" })
		pool.dispose()
	})

	it("asks for the password, says when it was wrong, and opens with the right one", async () => {
		const pool = presentationWorkerPool(() => inThreadPresentationWorker(serve("pw")))
		const heard = events()
		const client = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx" }, heard.listener)

		expect(await heard.next("error")).toMatchObject({ reason: "needsPassword" })

		client.unlock("nope")
		await vi.waitFor(() => expect(heard.list.filter(event => event.type === "error")).toHaveLength(2))
		expect(heard.list[1]).toMatchObject({ reason: "wrongPassword" })

		client.unlock("pw")
		expect(await heard.next("opened")).toMatchObject({ type: "opened" })
		pool.dispose()
	})

	it("gives each open deck a worker, keeps one idle for a minute and reuses it", async () => {
		vi.useFakeTimers()

		const workers = counted(serve())
		const pool = presentationWorkerPool(() => workers.create(), 60_000)
		const first = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx" }, () => undefined)
		const second = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "b.pptx" }, () => undefined)

		expect(pool.workers).toEqual({ busy: 2, idle: 0 })

		first.close()
		second.close()

		// One idle worker is kept; the other ends at once.
		expect(pool.workers).toEqual({ busy: 0, idle: 1 })
		expect(workers.made.filter(worker => vi.mocked(worker.terminate).mock.calls.length > 0)).toHaveLength(1)

		vi.advanceTimersByTime(59_000)

		const third = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "c.pptx" }, () => undefined)

		expect(workers.made).toHaveLength(2)

		third.close()
		vi.advanceTimersByTime(60_000)

		expect(pool.workers).toEqual({ busy: 0, idle: 0 })
		expect(workers.made.every(worker => vi.mocked(worker.terminate).mock.calls.length > 0)).toBe(true)

		pool.prewarm()
		expect(pool.workers).toEqual({ busy: 0, idle: 1 })
		pool.dispose()
		expect(pool.workers).toEqual({ busy: 0, idle: 0 })
	})

	it("fails the deck of a worker that died and starts a new worker for the next", async () => {
		const listeners: ((event: unknown) => void)[] = []
		let made = 0
		const pool = presentationWorkerPool(() => {
			made++

			return {
				postMessage: () => undefined,
				addEventListener: (type: string, listener: (event: unknown) => void) => {
					if (type === "error") listeners.push(listener)
				},
				terminate: () => undefined
			} as PresentationWorkerLike
		})
		const heard = events()
		const client = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx" }, heard.listener)
		const pending = client.render([slideRef(10)])

		for (const listener of listeners) listener({})

		await expect(pending).rejects.toMatchObject({ reason: "failed" })
		expect(heard.list).toEqual([{ type: "error", reason: "failed", message: "The presentation worker failed" }])

		pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "b.pptx" }, () => undefined)
		expect(made).toBe(2)
		pool.dispose()
	})

	it("closes the bitmaps of thumbnails, layers and previews nobody receives", () => {
		let closed = 0
		const bitmap = (): { width: number; height: number; close(): void } => ({ width: 2, height: 2, close: () => void closed++ })
		let deliver: (data: unknown) => void = () => undefined
		const sent: ToPresentationWorker[] = []
		const pool = presentationWorkerPool(
			() =>
				({
					postMessage: (message: ToPresentationWorker) => sent.push(message),
					addEventListener: (type: string, listener: (event: { readonly data: unknown }) => void) => {
						if (type === "message") deliver = data => listener({ data })
					},
					terminate: () => undefined
				}) as PresentationWorkerLike
		)
		const client = pool.open({ kind: "bytes", bytes: bytes() }, { format: "pptx", fileName: "a.pptx" }, () => undefined)
		const s = sent[0]?.s ?? 0

		void client.layers(slideRef(10), 100, { shapes: [], dpr: 1 }).catch(() => undefined)
		client.close()

		const late: FromPresentationWorker[] = [
			{
				t: "event",
				s,
				event: {
					type: "thumbs",
					items: [
						{ slide: slideRef(10), revision: 0, bitmap: bitmap() },
						{ slide: slideRef(11), revision: 0, bitmap: bitmap() }
					]
				}
			},
			{ t: "result", s, id: 1, method: "layers", value: [{ shape: 2, bitmap: bitmap(), x: 0, y: 0, width: 2, height: 2 }] },
			{ t: "result", s, id: 9, method: "smartArtPreview", value: bitmap() }
		]

		for (const message of late) deliver(message)

		expect(closed).toBe(4)
		expect(closeBitmapsOf({ t: "event", s, event: { type: "notice", notice: { kind: "macros" } } })).toBe(0)
		pool.dispose()
	})
})
