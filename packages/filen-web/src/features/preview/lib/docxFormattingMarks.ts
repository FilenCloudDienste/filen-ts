import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { kvPreference } from "@/lib/storage/preference"
import { log } from "@/lib/log"

// Whether the Word document editor shows formatting marks (Word's Show/Hide ¶, Ctrl+Shift+8): one boolean kept on
// this device for every document, as Word keeps it, read once an editor first mounts. Never in the file.

const preference = kvPreference({ key: "preview.docxFormattingMarks.v1", schema: type("boolean"), fallback: false })

let shown = false
// A change made before the stored value arrived wins over it.
let changed = false
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
			if (!changed && stored !== shown) {
				shown = stored
				notify()
			}
		},
		(error: unknown) => {
			log.warn("preview", "formatting marks setting not read", { error })
		}
	)

	return () => {
		listeners.delete(listener)
	}
}

function current(): boolean {
	return shown
}

export function useDocxFormattingMarks(): boolean {
	return useSyncExternalStore(subscribe, current, current)
}

export function setDocxFormattingMarks(next: boolean): void {
	if (next === shown) {
		return
	}

	shown = next
	changed = true
	notify()
	preference.set(next).catch((error: unknown) => {
		log.warn("preview", "formatting marks setting not saved", { error })
	})
}
