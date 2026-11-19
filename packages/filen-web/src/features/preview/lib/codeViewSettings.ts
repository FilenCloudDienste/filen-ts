import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"

// How the text and code viewers show a file: wrapped lines, line numbers and the font size. One value kept on this
// device for every file (the notes editors keep their own look), read during boot (lib/sdk/boot.ts), so a viewer's
// first render shows it.

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

const preference = preloadedPreference<CodeViewSettings>({
	key: "preview.codeView.v1",
	schema: type({ wrap: "boolean", lineNumbers: "boolean", fontSize: "number" }),
	fallback: DEFAULTS,
	scope: "preview",
	same: (a, b) => a.wrap === b.wrap && a.lineNumbers === b.lineNumbers && a.fontSize === b.fontSize,
	normalize: settings => ({ ...settings, fontSize: nearestFontSize(settings.fontSize) })
})

export const loadCodeViewSettings = preference.load

export function useCodeViewSettings(): CodeViewSettings {
	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export function setCodeViewSettings(change: Partial<CodeViewSettings>): void {
	preference.set({ ...preference.get(), ...change })
}
