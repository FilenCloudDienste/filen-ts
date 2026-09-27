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

// One editor's toasts: shown once the app is unlocked and in front, only the latest while it waits, and none
// after dispose() (the editor went away), so a lock does not end in a burst of stale toasts.
export function createUnlockedToaster(show: (message: string) => void): { notify: (message: string) => void; dispose: () => void } {
	let pending: string | null = null
	let waiting = false
	let disposed = false

	return {
		notify: message => {
			if (disposed) {
				return
			}

			pending = message

			if (waiting) {
				return
			}

			waiting = true

			void whenUnlockedForeground().then(() => {
				const next = pending

				waiting = false
				pending = null

				if (!disposed && next !== null) {
					show(next)
				}
			})
		},
		dispose: () => {
			disposed = true
			pending = null
		}
	}
}
