import { useSyncExternalStore } from "react"

// State a mode tool shares between its panel and its page overlays (one per page shown): one value, one editor at a
// time across pages. Reset when the tool finishes.

export interface PdfToolState<T> {
	readonly get: () => T
	readonly set: (value: T) => void
	readonly subscribe: (listener: () => void) => () => void
}

export function pdfToolState<T>(initial: T): PdfToolState<T> {
	let value = initial
	const listeners = new Set<() => void>()

	return {
		get: () => value,
		set: next => {
			if (Object.is(next, value)) return

			value = next

			for (const listener of listeners) listener()
		},
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		}
	}
}

export function usePdfToolState<T>(state: PdfToolState<T>): T {
	return useSyncExternalStore(state.subscribe, state.get, state.get)
}
