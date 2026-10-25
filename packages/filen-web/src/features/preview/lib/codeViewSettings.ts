import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { kvPreference } from "@/lib/storage/preference"
import { log } from "@/lib/log"

// How the text and code viewers show a file: wrapped lines, line numbers and the font size. One value kept on this
// device for every file (the notes editors keep their own look), read once a viewer first mounts.

export interface CodeViewSettings {
	readonly wrap: boolean
	readonly lineNumbers: boolean
	// px.
	readonly fontSize: number
}

export const CODE_FONT_SIZES: readonly number[] = [11, 12, 13, 14, 16, 18, 20, 24]
// The editor's size before there was a choice (a monospace font's default in the browsers).
export const CODE_DEFAULT_FONT_SIZE = 13
const DEFAULTS: CodeViewSettings = { wrap: true, lineNumbers: true, fontSize: CODE_DEFAULT_FONT_SIZE }

function nearestFontSize(size: number): number {
	return CODE_FONT_SIZES.reduce((best, candidate) => (Math.abs(candidate - size) < Math.abs(best - size) ? candidate : best))
}

const preference = kvPreference({
	key: "preview.codeView.v1",
	schema: type({ wrap: "boolean", lineNumbers: "boolean", fontSize: "number" }),
	fallback: DEFAULTS,
	normalize: settings => ({ ...settings, fontSize: nearestFontSize(settings.fontSize) })
})

let settings: CodeViewSettings = DEFAULTS
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
			// A change made before the stored value arrived wins.
			if (settings === DEFAULTS) {
				settings = stored
				notify()
			}
		},
		(error: unknown) => {
			log.warn("preview", "code view settings not read", { error })
		}
	)

	return () => {
		listeners.delete(listener)
	}
}

function current(): CodeViewSettings {
	return settings
}

export function useCodeViewSettings(): CodeViewSettings {
	return useSyncExternalStore(subscribe, current, current)
}

export function setCodeViewSettings(change: Partial<CodeViewSettings>): void {
	const next = { ...settings, ...change }

	if (next.wrap === settings.wrap && next.lineNumbers === settings.lineNumbers && next.fontSize === settings.fontSize) {
		return
	}

	settings = next
	notify()
	preference.set(next).catch((error: unknown) => {
		log.warn("preview", "code view settings not saved", { error })
	})
}
