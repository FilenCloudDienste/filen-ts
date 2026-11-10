import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"

// Whether app.toggleSidebar has hidden the module sidebar at desktop widths: one boolean kept on this device, read
// during boot (lib/sdk/boot.ts) so the shell's first render lays the row out as the user left it, never a sidebar
// that then disappears. Below the layout breakpoint the sidebar lives in its drawer and this is not read.

const preference = preloadedPreference({
	key: "shell.sidebarHidden.v1",
	schema: type("boolean"),
	fallback: false,
	scope: "shell",
	same: (a, b) => a === b
})

export const loadSidebarHidden = preference.load

export function useSidebarHidden(): boolean {
	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export const setSidebarHidden = preference.set
