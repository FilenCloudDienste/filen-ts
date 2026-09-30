import { useSyncExternalStore } from "react"
import { AppState, type AppStateStatus } from "react-native"

function subscribe(listener: () => void): () => void {
	const subscription = AppState.addEventListener("change", listener)

	return () => {
		subscription.remove()
	}
}

// Boolean snapshot: transitions between the other states don't re-render consumers.
export function useIsAppState(status: AppStateStatus): boolean {
	return useSyncExternalStore(subscribe, () => AppState.currentState === status, () => status === "active")
}

export default function useIsAppActive(): boolean {
	return useIsAppState("active")
}
