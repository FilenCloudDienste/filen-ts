import { useSyncExternalStore } from "react"

const MINUTE_MS = 60_000

// One shared timer for every subscriber, aligned to the next wall-clock minute rather than started at
// mount, so all consumers flip on the same tick.
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined

// Epoch ms truncated to the minute.
export function minuteStamp(now: number): number {
	return now - (now % MINUTE_MS)
}

function scheduleTick(): void {
	if (timer !== undefined || listeners.size === 0) {
		return
	}

	timer = setTimeout(
		() => {
			timer = undefined

			scheduleTick()

			for (const listener of listeners) {
				listener()
			}
		},
		MINUTE_MS - (Date.now() % MINUTE_MS)
	)
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)
	scheduleTick()

	return () => {
		listeners.delete(listener)

		if (listeners.size === 0 && timer !== undefined) {
			clearTimeout(timer)
			timer = undefined
		}
	}
}

function getSnapshot(): number {
	return minuteStamp(Date.now())
}

// The current time as REACTIVE STATE, quantized to the minute. A bare `Date.now()` in a render body is
// an impure read the React Compiler is free to hoist into a memo block, where it then freezes for as
// long as that block's other inputs hold — silently stale time-derived output (and, unquantized, a
// value that changes every render, which defeats memoization outright). Reading it through an external
// store keeps the render pure and re-renders subscribers exactly once per minute.
export function useNowMinute(): number {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
