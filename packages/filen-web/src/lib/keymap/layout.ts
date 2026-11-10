import { useSyncExternalStore } from "react"
import type { KeyboardLayout } from "@filen/shared/keymap"

// The user's keyboard layout, for labels: shortcuts match by physical key (@filen/shared/keymap), so a key is shown
// with the character the layout prints on it. Keyboard.getLayoutMap() exists in Chromium (and so Electron) only;
// elsewhere, or when it is refused (a frame without the keyboard-map permission), this stays null and labels use US
// names. Read once, then again when the window regains focus, the moment a layout switched in another app or the
// system tray shows up; listeners hear only a real change.

interface LayoutMapSource {
	getLayoutMap(): Promise<ReadonlyMap<string, string>>
}

let layout: KeyboardLayout | null = null
let signature = ""
const listeners = new Set<() => void>()

function source(): LayoutMapSource | undefined {
	if (typeof navigator === "undefined") {
		return undefined
	}

	const keyboard: unknown = Reflect.get(navigator, "keyboard")

	return typeof keyboard === "object" && keyboard !== null && typeof Reflect.get(keyboard, "getLayoutMap") === "function"
		? (keyboard as LayoutMapSource)
		: undefined
}

async function refresh(keyboard: LayoutMapSource): Promise<void> {
	let map: ReadonlyMap<string, string>

	try {
		map = await keyboard.getLayoutMap()
	} catch {
		return
	}

	let next = ""

	for (const [code, character] of map) {
		next += `${code}=${character};`
	}

	if (next === signature) {
		return
	}

	signature = next
	layout = map

	for (const listener of listeners) {
		listener()
	}
}

let started = false

function start(): void {
	const keyboard = source()

	if (started || keyboard === undefined) {
		return
	}

	started = true
	void refresh(keyboard)
	window.addEventListener("focus", () => {
		void refresh(keyboard)
	})
}

export function keyboardLayout(): KeyboardLayout | null {
	start()

	return layout
}

export function subscribeKeyboardLayout(listener: () => void): () => void {
	start()
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}

function serverLayout(): KeyboardLayout | null {
	return null
}

export function useKeyboardLayout(): KeyboardLayout | null {
	return useSyncExternalStore(subscribeKeyboardLayout, keyboardLayout, serverLayout)
}
