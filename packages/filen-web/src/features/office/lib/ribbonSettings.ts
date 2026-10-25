import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { kvPreference } from "@/lib/storage/preference"
import { log } from "@/lib/log"

// Whether the office editors' ribbon shows its tabs only (Office's "Show tabs only", Ctrl+F1): one boolean kept on
// this device for both editors, read once a ribbon first mounts.

const preference = kvPreference({ key: "office.ribbonCollapsed.v1", schema: type("boolean"), fallback: false })

let collapsed = false
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function notify(): void {
	for (const listener of listeners) {
		listener()
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)

	loading ??= preference.get().then(
		stored => {
			if (stored !== collapsed) {
				collapsed = stored
				notify()
			}
		},
		(error: unknown) => {
			log.warn("office", "ribbon setting not read", { error })
		}
	)

	return () => {
		listeners.delete(listener)
	}
}

function current(): boolean {
	return collapsed
}

export function useRibbonCollapsed(): boolean {
	return useSyncExternalStore(subscribe, current, current)
}

export function setRibbonCollapsed(next: boolean): void {
	if (next === collapsed) {
		return
	}

	collapsed = next
	notify()
	preference.set(next).catch((error: unknown) => {
		log.warn("office", "ribbon setting not saved", { error })
	})
}
