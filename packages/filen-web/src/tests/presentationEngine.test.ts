import { afterEach, describe, expect, it } from "vitest"
import type { Deck } from "@filen/office/core/presentation"
import { slideRef } from "@filen/office/core/presentation"
import {
	presentationWorkerPool,
	type OpenCapability,
	type OpenedPackage,
	type PresentationEvent,
	type PresentationWorkerLike
} from "@filen/office/dom/presentation"
import { connectPresentation } from "@/features/presentation/lib/presentationEngine"
import { servePresentationDeckWorker } from "@/features/presentation/workers/presentationScope"
import { exposeRangePort } from "@/lib/media/rangePort"

// The page's connection and the worker body, in-thread over MessageChannels: a drive deck read through its range port
// in bounded blocks (never whole), its port shut with the session, the password round trip, and the session API the
// viewer's store drives.

const open: (() => void)[] = []

afterEach(() => {
	for (const close of open.splice(0)) close()
})

function deck(slides: number): Deck {
	const refs = Array.from({ length: slides }, (_unused, index) => slideRef(256 + index))

	return {
		format: "pptx",
		variant: "pptx",
		size: { cx: 12_192_000, cy: 6_858_000 },
		notesSize: { cx: 6_858_000, cy: 9_144_000 },
		firstSlideNumber: 1,
		slides: refs,
		layouts: [],
		masters: [],
		nodes: new Map(),
		sections: [],
		customShows: [],
		protection: {},
		gate: [],
		revision: 0
	} as unknown as Deck
}

// A worker whose body runs in this thread on the far end of a channel.
function inThreadWorker(openers: { pptx: OpenCapability }): () => PresentationWorkerLike {
	return () => {
		const channel = new MessageChannel()
		const stop = servePresentationDeckWorker(channel.port1, { openers })
		let terminated = false

		channel.port1.start()
		channel.port2.start()

		const terminate = (): void => {
			if (terminated) return

			terminated = true
			stop()
			channel.port1.close()
			channel.port2.close()
		}

		open.push(terminate)

		return {
			postMessage: (message, transfer) => {
				channel.port2.postMessage(message, transfer as Transferable[])
			},
			addEventListener: (type: "message" | "error", listener: (event: { readonly data: unknown }) => void) => {
				if (type === "message") channel.port2.addEventListener("message", listener)
			},
			terminate
		}
	}
}

function opener(slides = 3, password?: string): OpenCapability & { reads: number[][] } {
	const reads: number[][] = []

	return {
		reads,
		async open(request) {
			if (password !== undefined && request.password !== password) return { kind: "needsPassword" }

			// The end of the central directory, as a zip reader starts.
			const tail = await request.source.read(request.source.size - 22, 22)

			reads.push([...tail.subarray(0, 4)])

			const opened: OpenedPackage = {
				format: "pptx",
				variant: "pptx",
				bytes: request.source.size,
				source: request.source,
				sourceKind: request.sourceKind,
				locks: 0
			}

			return { kind: "opened", deck: deck(slides), package: opened }
		}
	}
}

interface Heard {
	readonly list: PresentationEvent[]
	push(event: PresentationEvent): void
	next(type: PresentationEvent["type"]): Promise<PresentationEvent>
}

function events(): Heard {
	const list: PresentationEvent[] = []
	let waiting: { type: string; resolve: (event: PresentationEvent) => void }[] = []

	return {
		list,
		push(event) {
			list.push(event)

			const ready = waiting.filter(entry => entry.type === event.type)

			waiting = waiting.filter(entry => entry.type !== event.type)

			for (const entry of ready) entry.resolve(event)
		},
		next: type =>
			new Promise(resolve => {
				const found = list.find(event => event.type === type)

				if (found !== undefined) resolve(found)
				else waiting.push({ type, resolve })
			})
	}
}

function served(bytes: Uint8Array): { port: MessagePort; requests: [number, number][]; lifetime: AbortController } {
	const channel = new MessageChannel()
	const lifetime = new AbortController()
	const requests: [number, number][] = []

	exposeRangePort(
		channel.port1,
		(start, end) => {
			requests.push([start, end])

			return Promise.resolve(bytes.slice(start, end))
		},
		lifetime
	)
	open.push(() => {
		lifetime.abort()
	})

	return { port: channel.port2, requests, lifetime }
}

function deckBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size)

	// An end-of-central-directory signature at the end.
	bytes.set([0x50, 0x4b, 0x05, 0x06], size - 22)

	return bytes
}

const OPTIONS = { format: "pptx", fileName: "a.pptx" } as const

describe("presentation engine connection", () => {
	it("opens a drive deck through the worker's block cache and shuts its port with the session", async () => {
		const read = opener(5)
		const pool = presentationWorkerPool(inThreadWorker({ pptx: read }))
		const source = served(deckBytes(3_000_000))
		const heard = events()
		const connection = connectPresentation(
			pool,
			{ kind: "range", port: source.port, size: 3_000_000, checked: false },
			event => {
				heard.push(event)
			},
			OPTIONS
		)
		const opened = await heard.next("opened")

		expect(opened.type === "opened" && opened.info.slides.length).toBe(5)
		expect(opened.type === "opened" && opened.info.source).toBe("range")
		expect(read.reads).toEqual([[0x50, 0x4b, 0x05, 0x06]])
		// One aligned block around the tail, never the whole file.
		expect(source.requests).toEqual([[2_097_152, 3_000_000]])

		connection.dispose()
		await new Promise(resolve => setTimeout(resolve, 20))

		expect(source.lifetime.signal.aborted).toBe(true)
		pool.dispose()
	})

	it("serves the session API the store drives and refuses calls after dispose", async () => {
		const pool = presentationWorkerPool(inThreadWorker({ pptx: opener() }))
		const heard = events()
		const connection = connectPresentation(
			pool,
			{ kind: "bytes", bytes: deckBytes(100) },
			event => {
				heard.push(event)
			},
			OPTIONS
		)

		await heard.next("opened")
		// Find is served by the worker: no match in the deck answers an empty result, not a refusal.
		await expect(connection.session.find("x")).resolves.toHaveLength(0)

		connection.dispose()

		await expect(connection.session.render([])).rejects.toMatchObject({ reason: "closed" })
		pool.dispose()
	})

	it("asks for a password, refuses a wrong one and opens with the right one", async () => {
		const pool = presentationWorkerPool(inThreadWorker({ pptx: opener(2, "tika") }))
		const heard = events()
		const connection = connectPresentation(
			pool,
			{ kind: "bytes", bytes: deckBytes(100) },
			event => {
				heard.push(event)
			},
			OPTIONS
		)

		expect(await heard.next("error")).toMatchObject({ reason: "needsPassword" })
		heard.list.length = 0
		connection.unlock("nope")
		expect(await heard.next("error")).toMatchObject({ reason: "wrongPassword" })
		connection.unlock("tika")
		expect(await heard.next("opened")).toMatchObject({ type: "opened" })
		connection.dispose()
		pool.dispose()
	})
})
