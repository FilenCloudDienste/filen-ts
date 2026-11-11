import { create } from "zustand"
import type { DesktopPrefs, DesktopPrefsPatch } from "@filen/shared/desktop"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"

// This page's mirror of the desktop shell's prefs (kept by main in userData). null until read, and always in a
// browser. Only this page changes them, itself or through main's download directory dialog (chooseDownloadDirectory
// patches the mirror with what main stored), so one read per page load stays current.
export const useDesktopPrefs = create<{ prefs: DesktopPrefs | null }>(() => ({ prefs: null }))

let loading: Promise<void> | null = null

export function loadDesktopPrefs(): Promise<void> {
	const bridge = desktopBridge()

	if (bridge === undefined) {
		return Promise.resolve()
	}

	loading ??= bridge.prefs.get().then(
		prefs => {
			useDesktopPrefs.setState({ prefs })
		},
		(error: unknown) => {
			loading = null
			log.warn("desktop", "prefs could not be read", error)
		}
	)

	return loading
}

// Rejects when main refuses or cannot store the change; the mirror then keeps the prefs in effect.
export async function setDesktopPref(patch: DesktopPrefsPatch): Promise<void> {
	const bridge = desktopBridge()

	if (bridge === undefined) {
		return
	}

	useDesktopPrefs.setState({ prefs: await bridge.prefs.set(patch) })
}

// Main's directory picker; main stores a chosen directory before answering, so only the mirror needs it.
export async function chooseDownloadDirectory(): Promise<void> {
	const bridge = desktopBridge()

	if (bridge === undefined) {
		return
	}

	const choice = await bridge.transfers.chooseDownloadDirectory()

	if (choice.status === "chosen") {
		useDesktopPrefs.setState(state => (state.prefs === null ? state : { prefs: { ...state.prefs, downloadDirectory: choice.path } }))
	}
}
