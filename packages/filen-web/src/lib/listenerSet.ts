import { log } from "@/lib/log"

export interface ListenerSet<T> {
	subscribe: (listener: (value: T) => void) => () => void
	emit: (value: T) => void
	clear: () => void
}

// A module-level subscriber set. A throwing listener is logged under `scope` and never aborts the fan-out.
export function createListenerSet<T = void>(scope: string): ListenerSet<T> {
	const listeners = new Set<(value: T) => void>()

	return {
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		emit: value => {
			for (const listener of listeners) {
				try {
					listener(value)
				} catch (e) {
					log.error(scope, "listener threw", e)
				}
			}
		},
		clear: () => {
			listeners.clear()
		}
	}
}
