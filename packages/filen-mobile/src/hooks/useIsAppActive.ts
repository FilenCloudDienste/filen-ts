import { useSyncExternalStore } from "react"
import { AppState } from "react-native"

function subscribe(listener: () => void): () => void {
	const subscription = AppState.addEventListener("change", listener)

	return () => {
		subscription.remove()
	}
}

// Boolean snapshot: inactive <-> background transitions don't re-render consumers.
export default function useIsAppActive(): boolean {
	return useSyncExternalStore(subscribe, () => AppState.currentState === "active", () => true)
}
