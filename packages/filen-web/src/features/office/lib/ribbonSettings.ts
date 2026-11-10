import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"

// Whether the office editors' ribbon shows its tabs only (Office's "Show tabs only", Ctrl+F1): one boolean kept on
// this device for every editor, read during boot (lib/sdk/boot.ts) so a ribbon mounts collapsed or not from its first
// render.

const preference = preloadedPreference({
	key: "office.ribbonCollapsed.v1",
	schema: type("boolean"),
	fallback: false,
	scope: "office",
	same: (a, b) => a === b
})

export const loadRibbonCollapsed = preference.load

export function useRibbonCollapsed(): boolean {
	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export const setRibbonCollapsed = preference.set
