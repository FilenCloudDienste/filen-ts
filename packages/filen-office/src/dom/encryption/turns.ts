import { sliceClock, type SliceClock, type Slicing } from "../../core/slicing"
import { SIGNAL_POLL_MS, clearTimer, macrotaskYield, setTimer } from "../platform"
import { OfficeCryptoError } from "./errors"

// Chromium settles WebCrypto promises without returning to the event loop, so a chain of awaited calls (the
// spin, the segments) is one long task there however small each call is. Long work therefore gives the host
// a macrotask turn every few milliseconds, and looks at the caller's abort signal at the same points.

export interface AbortSignalLike {
	readonly aborted: boolean
}

export interface OfficeCryptoOptions {
	readonly signal?: AbortSignalLike
	// The host's slicing (a docx engine's clock); by default a macrotask turn every 8 ms.
	readonly slicing?: Slicing
}

export interface Turns {
	readonly signal: AbortSignalLike | undefined
	readonly clock: SliceClock
}

const SLICE_MS = 8

function now(): number {
	const performance: unknown = Reflect.get(globalThis, "performance")
	const read: unknown = typeof performance === "object" && performance !== null ? Reflect.get(performance, "now") : undefined

	return typeof read === "function" ? (Reflect.apply(read, performance, []) as number) : Date.now()
}

export function turnsOf(options: OfficeCryptoOptions): Turns {
	return { signal: options.signal, clock: sliceClock(options.slicing ?? { pause: macrotaskYield(), sliceMs: SLICE_MS, now }) }
}

export async function turn(turns: Turns): Promise<void> {
	if (turns.signal?.aborted === true) throw new OfficeCryptoError("aborted", "Aborted")
	if (turns.clock.due) await turns.clock.pause()
}

// `promise`, or OfficeCryptoError("aborted") as soon as `signal` fires (its "abort" event when it has one, else
// looked at every SIGNAL_POLL_MS). The promise itself goes on.
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignalLike | undefined): Promise<T> {
	if (signal === undefined) return promise
	if (signal.aborted) return Promise.reject(new OfficeCryptoError("aborted", "Aborted"))

	const target = signal as AbortSignalLike & {
		addEventListener?: (type: "abort", listener: () => void) => void
		removeEventListener?: (type: "abort", listener: () => void) => void
	}

	return new Promise<T>((resolve, reject) => {
		let done = false
		let timer: unknown
		const finish = (): void => {
			done = true
			target.removeEventListener?.("abort", abort)

			if (timer !== undefined) clearTimer(timer)
		}
		const abort = (): void => {
			if (done) return

			finish()
			reject(new OfficeCryptoError("aborted", "Aborted"))
		}
		const look = (): void => {
			timer = undefined

			if (done) return
			if (signal.aborted) abort()
			else timer = setTimer(look, SIGNAL_POLL_MS)
		}

		if (typeof target.addEventListener === "function") target.addEventListener("abort", abort)
		else look()

		promise.then(
			value => {
				if (done) return

				finish()
				resolve(value)
			},
			(error: unknown) => {
				if (done) return

				finish()
				reject(error instanceof Error ? error : new Error(String(error)))
			}
		)
	})
}
