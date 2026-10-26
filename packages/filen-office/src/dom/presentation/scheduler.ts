import type { Slicing } from "../../core/slicing"
import { macrotaskYield } from "../docx/host"
import type { CallSignal, Lane, PresentationScheduler, Task } from "./engine"

// The presentation worker's scheduler. Every piece of work runs in slices of at most SLICE_MS: a slice ends at a
// pause(), and the next waiter is chosen on a fresh macrotask (so messages queued meanwhile, new calls among them,
// are handled first). Waiters of the priority lane (layoutText, command, undo, redo, textSeed, the visible render)
// always go before background ones; background waiters take turns in arrival order, so a save, an index build and a
// run of thumbnails share the worker round robin. A priority call therefore waits at most for the background slice
// already running.

export const SLICE_MS = 8

type Turn = () => Promise<void>

interface Waiter {
	readonly resume: () => void
}

export interface SchedulerOptions {
	// A macrotask turn (MessageChannel in a worker; a timer elsewhere).
	readonly turn: Turn
	readonly now: () => number
	readonly sliceMs?: number
}

export interface PresentationWorkerScheduler extends PresentationScheduler {
	// Waiters per lane (tests and diagnostics).
	readonly waiting: { readonly priority: number; readonly background: number }
}

export function presentationScheduler(options: SchedulerOptions): PresentationWorkerScheduler {
	const sliceMs = options.sliceMs ?? SLICE_MS
	const queues: { readonly [L in Lane]: Waiter[] } = { priority: [], background: [] }
	let pumping = false

	const pump = (): void => {
		if (pumping) return

		pumping = true

		void options.turn().then(() => {
			pumping = false

			const next = queues.priority.shift() ?? queues.background.shift()

			next?.resume()

			if (queues.priority.length > 0 || queues.background.length > 0) pump()
		})
	}

	const wait = (lane: Lane): Promise<void> =>
		new Promise(resolve => {
			queues[lane].push({ resume: resolve })
			pump()
		})

	const slicings: { readonly [L in Lane]: Slicing } = {
		priority: { pause: () => wait("priority"), sliceMs, now: options.now },
		background: { pause: () => wait("background"), sliceMs, now: options.now }
	}

	return {
		get waiting() {
			return { priority: queues.priority.length, background: queues.background.length }
		},
		slicing: lane => slicings[lane],
		schedule(lane: Lane, task: Task, signal: CallSignal) {
			// Started on its lane's turn, like a waiter resuming.
			void wait(lane)
				.then(() => (signal.aborted ? undefined : task(slicings[lane], signal)))
				.catch(() => undefined)
		}
	}
}

// The worker realm's turn and clock: a MessageChannel macrotask (no 4 ms timer clamp) and performance.now().
export function realmScheduler(sliceMs: number = SLICE_MS): PresentationWorkerScheduler {
	return presentationScheduler({ turn: macrotaskYield(), now: realmClock(), sliceMs })
}

export function realmClock(): () => number {
	const performance: unknown = Reflect.get(globalThis, "performance")
	const now: unknown = typeof performance === "object" && performance !== null ? Reflect.get(performance, "now") : undefined

	return typeof now === "function" ? () => Reflect.apply(now, performance, []) as number : () => Date.now()
}
