// Timers and macrotask turns through globalThis, for every page and worker host: the modules type-check without DOM or
// Node typings. A leaf: separate package entries and worker bundles import it, so it imports nothing.

// How often a signal without events is looked at while a call on it is awaited.
export const SIGNAL_POLL_MS = 10

// `repeat`: an interval (setInterval) rather than a single timeout.
export function setTimer(run: () => void, ms: number, repeat = false): unknown {
	const set: unknown = Reflect.get(globalThis, repeat ? "setInterval" : "setTimeout")

	return typeof set === "function" ? Reflect.apply(set, globalThis, [run, ms]) : undefined
}

export function clearTimer(handle: unknown, repeat = false): void {
	const clear: unknown = Reflect.get(globalThis, repeat ? "clearInterval" : "clearTimeout")

	if (typeof clear === "function") Reflect.apply(clear, globalThis, [handle])
}

interface MessageChannelLike {
	readonly port1: { onmessage: ((event: unknown) => void) | null; close?(): void }
	readonly port2: { postMessage(message: unknown): void; close?(): void }
}

// The realm's one channel for macrotask turns, made on first use: a started port is kept alive by the engine, so a
// channel per caller (one per opened document) would never be collected. Each turn posts its own message and the
// replies come back in order, so one queue serves every caller.
let turns: { readonly port: MessageChannelLike["port2"]; readonly waiting: (() => void)[] } | undefined

function channelTurns(Channel: new () => MessageChannelLike): NonNullable<typeof turns> {
	if (turns !== undefined) return turns

	const channel = new Channel()
	const waiting: (() => void)[] = []

	channel.port1.onmessage = () => {
		waiting.shift()?.()
	}

	// Node keeps a listening port's process alive; nothing here should.
	for (const end of [channel.port1, channel.port2]) {
		const unref: unknown = Reflect.get(end, "unref")

		if (typeof unref === "function") Reflect.apply(unref, end, [])
	}

	turns = { port: channel.port2, waiting }

	return turns
}

// A macrotask turn, so messages queued for the thread (requests, reads) are handled between slices. MessageChannel
// avoids the 4 ms clamp nested timers get; setTimeout is the fallback. Which one is decided when the turn is asked for.
export function macrotaskYield(): () => Promise<void> {
	const Channel: unknown = Reflect.get(globalThis, "MessageChannel")

	if (typeof Channel !== "function") {
		// Looked up per turn: a timer installed later (fake timers in a test) is the one used.
		return () =>
			new Promise(resolve => {
				if (setTimer(resolve, 0) === undefined) resolve()
			})
	}

	const shared = channelTurns(Channel as new () => MessageChannelLike)

	return () =>
		new Promise<void>(resolve => {
			shared.waiting.push(resolve)
			shared.port.postMessage(0)
		})
}
