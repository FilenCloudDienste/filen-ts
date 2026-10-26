import type { ByteSource } from "@filen/office/core/opc"
import {
	servePresentationWorker,
	type PresentationWorkerOptions,
	type PresentationWorkerScope,
	type SourceSpec,
	type ToPresentationWorker
} from "@filen/office/dom/presentation"
import { BlockCache } from "@/lib/media/blockCache"
import { rangePortReader, type RangePortReader } from "@/lib/media/rangePort"

// The presentation worker's server (presentation.worker.ts runs it on its scope): the engine's host with the web's
// range source. A drive file is read through a
// range port to the SDK worker, in 1 MiB blocks held in a small LRU, so a deck of any size costs a bounded amount of
// memory; archive entries arrive as bytes.

// Resident blocks per open deck (1 MiB each): the central directory, the parts being parsed and a picture or two.
export const DECK_BLOCK_CAPACITY = 24

interface RangeDeck {
	readonly reader: RangePortReader
	readonly cache: BlockCache
}

// A ByteSource over a range port: every read goes through the deck's block cache.
export function rangeByteSource(spec: Extract<SourceSpec, { kind: "range" }>, decks: Map<unknown, RangeDeck>): ByteSource {
	const reader = rangePortReader(spec.port as MessagePort)
	const abort = new AbortController()
	const cache = new BlockCache(spec.size, (start, end, signal) => reader.readRange(start, end, AbortSignal.any([signal, abort.signal])), {
		capacity: DECK_BLOCK_CAPACITY
	})

	decks.set(spec.port, { reader, cache })

	return {
		size: spec.size,
		read(offset, length) {
			if (offset < 0 || length < 0 || offset + length > spec.size) return Promise.reject(new RangeError("Read outside the source"))

			return Promise.resolve(cache.read(offset, offset + length))
		}
	}
}

function isMessage(data: unknown): data is ToPresentationWorker {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as { s?: unknown }).s === "number" &&
		typeof (data as { t?: unknown }).t === "string"
	)
}

// Serves the protocol on `scope` (the engine's host, with the realm in `options`). A deck's port, block cache and
// reader go when its session is disposed or the same session id opens another source.
export function servePresentationDeckWorker(
	scope: PresentationWorkerScope,
	options: Omit<PresentationWorkerOptions, "rangeSource"> = {}
): () => void {
	const decks = new Map<unknown, RangeDeck>()
	// The range port each session opened with.
	const ports = new Map<number, unknown>()
	const release = (s: number): void => {
		const port = ports.get(s)

		ports.delete(s)

		if (port === undefined) return

		const deck = decks.get(port)

		decks.delete(port)
		deck?.cache.dispose()
		deck?.reader.close()
	}
	const watch = (event: { readonly data: unknown }): void => {
		const message: unknown = event.data

		if (!isMessage(message)) return

		if (message.t === "dispose") release(message.s)
		else if (message.t === "open") {
			release(message.s)

			if (message.source.kind === "range") ports.set(message.s, message.source.port)
		}
	}
	// Seen before the server handles the message, so a reopen releases the old source first.
	scope.addEventListener("message", watch)

	const stop = servePresentationWorker(scope, { ...options, rangeSource: spec => rangeByteSource(spec, decks) })

	return () => {
		stop()
		scope.removeEventListener("message", watch)

		for (const s of [...ports.keys()]) release(s)
	}
}
