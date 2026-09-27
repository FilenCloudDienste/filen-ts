import { AppState } from "react-native"
import useAppStore from "@/stores/useApp.store"

// The root overlay rule: a global prompt or toast surfaces only while the app is in front and no biometric
// lock covers it. A native alert raised under the lock draws over it, file or note name included.
export function isUnlockedForeground(): boolean {
	return useAppStore.getState().biometricUnlocked === true && AppState.currentState === "active"
}

// Resolves once isUnlockedForeground() holds, at once when it already does.
export function whenUnlockedForeground(): Promise<void> {
	if (isUnlockedForeground()) {
		return Promise.resolve()
	}

	return new Promise(resolve => {
		const check = () => {
			if (!isUnlockedForeground()) {
				return
			}

			unsubscribeApp()
			appState.remove()
			resolve()
		}

		const unsubscribeApp = useAppStore.subscribe((state, prev) => {
			if (state.biometricUnlocked !== prev.biometricUnlocked) {
				check()
			}
		})
		const appState = AppState.addEventListener("change", check)
	})
}

// alerts.normal shows a toast for 3 s. A toast shown sooner covers the one before it (iOS keeps no queue).
const TOAST_GAP_MS = 3200

// One editor's toasts: shown once the app is unlocked and in front, one after another, keeping only the latest
// of each kind while it waits (so a routine notice never displaces a more important one), and none after
// dispose() (the editor went away), so a lock does not end in a burst of stale toasts.
export function createUnlockedToaster(show: (message: string) => void): {
	notify: (kind: string, message: string) => void
	dispose: () => void
} {
	const pending = new Map<string, string>()
	let waiting = false
	let disposed = false
	// When the last toast went up, so the next one waits for it to go.
	let lastShownAt = 0
	let timer: ReturnType<typeof setTimeout> | null = null

	const drain = () => {
		timer = null

		if (disposed) {
			return
		}

		const next = pending.entries().next()

		if (next.done === true) {
			waiting = false

			return
		}

		// Locked again since: the rest waits for the next unlock.
		if (!isUnlockedForeground()) {
			void whenUnlockedForeground().then(drain)

			return
		}

		const [kind, message] = next.value
		const wait = lastShownAt + TOAST_GAP_MS - Date.now()

		if (wait > 0) {
			timer = setTimeout(drain, wait)

			return
		}

		pending.delete(kind)
		lastShownAt = Date.now()
		show(message)
		timer = setTimeout(drain, TOAST_GAP_MS)
	}

	return {
		notify: (kind, message) => {
			if (disposed) {
				return
			}

			// Re-inserted, so the order is that of each kind's latest notice.
			pending.delete(kind)
			pending.set(kind, message)

			if (waiting) {
				return
			}

			waiting = true

			void whenUnlockedForeground().then(drain)
		},
		dispose: () => {
			disposed = true
			pending.clear()

			if (timer !== null) {
				clearTimeout(timer)
				timer = null
			}
		}
	}
}

// Notices too important for a one-line toast (a save that went over, or somewhere other than, the file being
// edited): a native alert with a title and a message, once the app is unlocked and in front, the latest of
// each kind while it waits. Kept after the editor closes, as they are about a save already made. Alerts show
// one at a time (prompts serializes them).
export function createUnlockedNotices(
	showAlert: (title: string, message: string) => Promise<void>
): (kind: string, title: string, message: string) => void {
	const pending = new Map<string, { title: string; message: string }>()
	let waiting = false

	return (kind, title, message) => {
		pending.delete(kind)
		pending.set(kind, { title, message })

		if (waiting) {
			return
		}

		waiting = true

		void (async () => {
			for (;;) {
				// Before each alert: the app may have locked again after the one before.
				await whenUnlockedForeground()

				const next = pending.entries().next()

				if (next.done === true) {
					break
				}

				const [nextKind, notice] = next.value

				pending.delete(nextKind)
				await showAlert(notice.title, notice.message).catch(() => undefined)
			}

			waiting = false
		})()
	}
}
