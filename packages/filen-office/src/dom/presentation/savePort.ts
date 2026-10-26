import type { ByteSink } from "../../core/opc/io"
import type { PortLike } from "./protocol"

// A save streamed from the presentation worker to the SDK worker's upload over a MessagePort: a pull protocol, so no
// engine has to transfer a ReadableStream (one supported engine cannot). The reading side (the upload) asks for one
// chunk at a time, with at most SAVE_PORT_IN_FLIGHT asked and not yet read; the writing side sends a chunk of at most
// SAVE_PORT_CHUNK bytes per request, and its writes wait while nothing is asked, so neither side holds more than a
// few chunks. Only "end" lets the upload finish: an "abort" from either side, or a port that goes quiet, ends it
// without a new file. A writer still preparing its first bytes (a package checked whole before any leaves, over a
// slow link) says it is alive every SAVE_PORT_ALIVE_MS, so only a writer that went away goes quiet. The bytes are always copied into chunks this module owns and transferred, so a chunk the zip
// writer handed over (often a view of the deck's own bytes) is never detached.
//
// Self-contained (the SDK worker imports it alone): this file and the zip CRC are all it pulls in.

export { crc32 } from "../../core/opc/crc32"

export const SAVE_PORT_CHUNK = 1024 * 1024
export const SAVE_PORT_IN_FLIGHT = 4

// Why a save stream ended without a file: the deck had nothing to save, the save failed a check before the upload
// could finish, the user or a newer save cancelled it, the upload side failed, or a side went away.
export type SavePortAbortReason = "unchanged" | "refused" | "failed" | "cancelled" | "upload" | "closed"

const KEY = "filen.savePort"

// Either way: the other side's "abort" arrived. The side that aborted keeps its end open until this (or the other
// side's own abort) comes, or SAVE_PORT_LINGER_MS passed: a message posted just before its port closes is lost in one
// engine when the other end is still being transferred to its worker (a save that ends before the upload's first pull).
type Ack = { readonly [KEY]: "closed" }

type ToWriter =
	| Ack
	| { readonly [KEY]: "pull" }
	| { readonly [KEY]: "abort"; readonly reason: SavePortAbortReason }
	// After "end": whether the upload made the file.
	| { readonly [KEY]: "settled"; readonly ok: boolean }

type ToReader =
	| Ack
	| { readonly [KEY]: "chunk"; readonly bytes: Uint8Array }
	// The writer's worker is alive and working; no bytes yet.
	| { readonly [KEY]: "alive" }
	| { readonly [KEY]: "end"; readonly size: number }
	| { readonly [KEY]: "abort"; readonly reason: SavePortAbortReason }

// A port end that also receives (a MessagePort; the protocol's PortLike only sends).
export interface SavePortEnd extends PortLike {
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
}

export class SavePortAbortedError extends Error {
	readonly reason: SavePortAbortReason

	constructor(reason: SavePortAbortReason) {
		super(`save stream aborted: ${reason}`)
		this.name = "SavePortAbortedError"
		this.reason = reason
	}
}

// Timers through globalThis: the module type-checks without DOM or Node typings.
function setTimer(run: () => void, ms: number): unknown {
	const set: unknown = Reflect.get(globalThis, "setTimeout")

	return typeof set === "function" ? Reflect.apply(set, globalThis, [run, ms]) : undefined
}

function clearTimer(handle: unknown): void {
	const clear: unknown = Reflect.get(globalThis, "clearTimeout")

	if (typeof clear === "function") Reflect.apply(clear, globalThis, [handle])
}

// How long an end that sent "abort" waits for the other side's acknowledgement before it closes anyway.
export const SAVE_PORT_LINGER_MS = 60_000

// Closes `port` once the other side acknowledged an abort (or aborted too), or after `ms`.
function closeOnAck(port: SavePortEnd, ms: number): void {
	const ack = (event: { readonly data: unknown }): void => {
		const kind = messageOf(event.data)?.[KEY]

		if (kind === "closed" || kind === "abort") done()
	}
	const timer = setTimer(() => {
		done()
	}, ms)

	function done(): void {
		clearTimer(timer)
		port.removeEventListener("message", ack)
		port.close()
	}

	port.addEventListener("message", ack)
}

function messageOf(data: unknown): { readonly [KEY]: string; readonly [field: string]: unknown } | undefined {
	return typeof data === "object" && data !== null && typeof (data as Record<string, unknown>)[KEY] === "string"
		? (data as { readonly [KEY]: string })
		: undefined
}

function isAbortReason(value: unknown): value is SavePortAbortReason {
	return (
		value === "unchanged" ||
		value === "refused" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "upload" ||
		value === "closed"
	)
}

// The writing end, a ByteSink for the zip writer. close() sends what is still buffered but does not end the upload:
// commit() does, once the save has passed its checks; abort() ends it without a file. Writes reject once the reader
// aborted (its reason in SavePortAbortedError).
export interface SavePortWriter extends ByteSink {
	// Bytes sent so far.
	readonly sent: number
	// Ends the upload with the file it received (after close()).
	commit(): void
	abort(reason: SavePortAbortReason): void
	// Resolves with the reader's reason when it aborts first; never otherwise.
	readonly aborted: Promise<SavePortAbortReason>
	// After commit(): whether the upload made the file (false when it failed, the save aborted, or no answer came
	// within `settleMs`: an SDK worker that died posts nothing).
	readonly uploaded: Promise<boolean>
	// Called after every chunk sent (progress).
	onSent?: (sent: number) => void
}

// How long a committed save waits for the upload's answer (the SDK finishing the file, its drive lock included).
export const SAVE_PORT_SETTLE_MS = 10 * 60_000

// How often an open writer tells the reader it is alive: well inside the reader's stall, so a writer that is working
// (each step of its work bounded on its own: a range read gives up after a minute without progress) is never taken
// for one that went away, which posts nothing.
export const SAVE_PORT_ALIVE_MS = 20_000

export function savePortWriter(
	port: SavePortEnd,
	options: { readonly settleMs?: number; readonly aliveMs?: number; readonly lingerMs?: number } = {}
): SavePortWriter {
	let credits = 0
	let sent = 0
	// The chunk being filled (owned here, transferred when sent).
	let buffer = new Uint8Array(SAVE_PORT_CHUNK)
	let filled = 0
	let ended: SavePortAbortReason | "committed" | undefined
	let wake: (() => void) | undefined
	const abortedBy = Promise.withResolvers<SavePortAbortReason>()
	const uploadedBy = Promise.withResolvers<boolean>()
	const aliveMs = options.aliveMs ?? SAVE_PORT_ALIVE_MS
	let alive: unknown
	const beat = (): void => {
		alive = undefined

		if (ended !== undefined) return

		port.postMessage({ [KEY]: "alive" } satisfies ToReader)
		alive = setTimer(beat, aliveMs)
	}

	alive = setTimer(beat, aliveMs)

	// Ends this side; `linger`: it sent "abort", so the port stays open for the acknowledgement.
	const finish = (linger = false): void => {
		clearTimer(alive)
		alive = undefined
		port.removeEventListener("message", listener)

		if (linger) closeOnAck(port, options.lingerMs ?? SAVE_PORT_LINGER_MS)
		else port.close()

		wake?.()
		uploadedBy.resolve(false)
	}
	const listener = (event: { readonly data: unknown }): void => {
		const message = messageOf(event.data) as ToWriter | undefined

		if (message === undefined) return

		if (ended === "committed") {
			// Requests still on their way are moot; the reader's answer (or its abort) ends the stream.
			if (message[KEY] === "pull") return
			if (message[KEY] === "settled") uploadedBy.resolve(message.ok === true)

			finish()

			return
		}

		if (ended !== undefined) return

		if (message[KEY] === "settled") return

		if (message[KEY] === "pull") {
			credits++
			wake?.()

			return
		}

		if (message[KEY] !== "abort") return

		ended = isAbortReason(message.reason) ? message.reason : "closed"
		abortedBy.resolve(ended)
		port.postMessage({ [KEY]: "closed" } satisfies Ack)
		finish()
	}

	port.addEventListener("message", listener)
	port.start?.()

	const failure = (): Error => new SavePortAbortedError(ended === undefined || ended === "committed" ? "closed" : ended)

	// Waits for a request, then sends the filled part of the buffer.
	const send = async (): Promise<void> => {
		while (credits === 0) {
			if (ended !== undefined) throw failure()

			await new Promise<void>(resolve => {
				wake = resolve
			})
			wake = undefined
		}

		if (ended !== undefined) throw failure()

		const bytes = filled === buffer.length ? buffer : buffer.slice(0, filled)

		credits--
		sent += filled
		buffer = new Uint8Array(SAVE_PORT_CHUNK)
		filled = 0
		port.postMessage({ [KEY]: "chunk", bytes } satisfies ToReader, [bytes.buffer])
		writer.onSent?.(sent)
	}

	const writer: SavePortWriter = {
		get sent() {
			return sent
		},
		aborted: abortedBy.promise,
		uploaded: uploadedBy.promise,
		async write(chunk) {
			if (ended !== undefined) throw failure()

			for (let at = 0; at < chunk.length;) {
				const take = Math.min(chunk.length - at, buffer.length - filled)

				buffer.set(chunk.subarray(at, at + take), filled)
				filled += take
				at += take

				if (filled === buffer.length) await send()
			}
		},
		async close() {
			if (filled > 0) await send()
			if (ended !== undefined) throw failure()
		},
		commit() {
			if (ended !== undefined) throw failure()
			if (filled > 0) throw new Error("commit before close")

			ended = "committed"
			clearTimer(alive)
			alive = undefined
			// The port stays open for the reader's "settled".
			port.postMessage({ [KEY]: "end", size: sent } satisfies ToReader)
			wake?.()

			const timer = setTimer(finish, options.settleMs ?? SAVE_PORT_SETTLE_MS)

			void uploadedBy.promise.then(() => {
				clearTimer(timer)
			})
		},
		abort(reason) {
			if (ended !== undefined) return

			ended = reason
			port.postMessage({ [KEY]: "abort", reason } satisfies ToReader)
			finish(true)
		}
	}

	return writer
}

// The reading end: chunks in order, undefined once the writer committed. A read rejects with SavePortAbortedError
// when the writer aborted, when abort() was called here, or when no chunk arrived for `stallMs` while one was asked
// (a writer whose worker died posts nothing; a live one says so while it prepares). After the last read, settled() tells the writer whether the upload made
// the file (the writer holds the deck's reads of the old file until then).
export interface SavePortReader {
	read(): Promise<Uint8Array | undefined>
	abort(reason: SavePortAbortReason): void
	settled(ok: boolean): void
	// Bytes received so far.
	readonly received: number
}

export const SAVE_PORT_STALL_MS = 120_000

export function savePortReader(
	port: SavePortEnd,
	options: { readonly stallMs?: number; readonly inFlight?: number; readonly lingerMs?: number } = {}
): SavePortReader {
	const stallMs = options.stallMs ?? SAVE_PORT_STALL_MS
	const inFlight = Math.max(1, Math.min(SAVE_PORT_IN_FLIGHT, options.inFlight ?? SAVE_PORT_IN_FLIGHT))
	const queue: Uint8Array[] = []
	// Asked and not yet arrived.
	let asked = 0
	let received = 0
	let state: { readonly kind: "open" | "end" | "settled" } | { readonly kind: "aborted"; readonly reason: SavePortAbortReason } = {
		kind: "open"
	}
	let waiter: { resolve: () => void } | undefined
	let stall: unknown

	const armStall = (): void => {
		clearTimer(stall)
		stall =
			asked > 0 && state.kind === "open"
				? setTimer(() => {
						reader.abort("closed")
					}, stallMs)
				: undefined
	}
	const settle = (): void => {
		const pending = waiter

		waiter = undefined
		pending?.resolve()
	}
	// Ends this side; `linger` as the writer's finish.
	const stop = (linger = false): void => {
		clearTimer(stall)
		port.removeEventListener("message", listener)

		if (linger) closeOnAck(port, options.lingerMs ?? SAVE_PORT_LINGER_MS)
		else port.close()

		settle()
	}
	// Keeps the requests topped up: asked plus queued never exceeds `inFlight`.
	const ask = (): void => {
		while (state.kind === "open" && asked + queue.length < inFlight) {
			asked++
			port.postMessage({ [KEY]: "pull" } satisfies ToWriter)
		}

		armStall()
	}
	const listener = (event: { readonly data: unknown }): void => {
		const message = messageOf(event.data) as ToReader | undefined

		if (message === undefined || state.kind !== "open") return

		switch (message[KEY]) {
			case "chunk":
				if (!(message.bytes instanceof Uint8Array) || message.bytes.length > SAVE_PORT_CHUNK || asked === 0) {
					reader.abort("failed")

					return
				}

				asked--
				received += message.bytes.length
				queue.push(message.bytes)
				armStall()
				settle()

				return
			case "alive":
				armStall()

				return
			case "end":
				// A size other than what arrived is a lost chunk: never a file.
				if (message.size !== received) {
					reader.abort("failed")

					return
				}

				state = { kind: "end" }
				clearTimer(stall)
				settle()

				return
			case "abort":
				state = { kind: "aborted", reason: isAbortReason(message.reason) ? message.reason : "closed" }
				queue.length = 0
				port.postMessage({ [KEY]: "closed" } satisfies Ack)
				stop()

				return
		}
	}

	port.addEventListener("message", listener)
	port.start?.()

	const reader: SavePortReader = {
		get received() {
			return received
		},
		async read() {
			for (;;) {
				if (state.kind === "aborted") throw new SavePortAbortedError(state.reason)

				const chunk = queue.shift()

				if (chunk !== undefined) {
					ask()

					return chunk
				}

				if (state.kind !== "open") return undefined

				ask()
				await new Promise<void>(resolve => {
					waiter = { resolve }
				})
			}
		},
		abort(reason) {
			if (state.kind === "aborted" || state.kind === "settled") return

			// After "end" the writer only listens for "settled".
			if (state.kind === "end") {
				reader.settled(false)

				return
			}

			state = { kind: "aborted", reason }
			queue.length = 0
			port.postMessage({ [KEY]: "abort", reason } satisfies ToWriter)
			stop(true)
		},
		settled(ok) {
			if (state.kind !== "end") return

			state = { kind: "settled" }
			port.postMessage({ [KEY]: "settled", ok } satisfies ToWriter)
			stop()
		}
	}

	ask()

	return reader
}
