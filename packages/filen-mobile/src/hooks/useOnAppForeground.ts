import { useEffect } from "react"
import { AppState } from "react-native"

// Runs `callback` on every transition to "active". Holds no state, so it never re-renders the host
// (unlike useIsAppActive). Pass a stable or compiler-memoized callback: a new identity re-subscribes.
export default function useOnAppForeground(callback: () => void): void {
	useEffect(() => {
		const subscription = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active") {
				callback()
			}
		})

		return () => {
			subscription.remove()
		}
	}, [callback])
}
