import { useCallback } from "react"
import { useFocusEffect } from "expo-router"

// Clears a selection store on focus and blur. `clear` must be a stable reference (a store action),
// or the effect re-runs every render.
export default function useClearSelectionOnFocusChange(clear: () => void): void {
	useFocusEffect(
		useCallback(() => {
			clear()

			return clear
		}, [clear])
	)
}
