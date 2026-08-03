import { useSyncExternalStore } from "react"
import { isNarrowViewport, subscribeToLayoutBreakpoint } from "@/features/shell/lib/breakpoints"

// True below the app's layout breakpoint, where the shell hosts the contextual sidebar in a drawer
// instead of the row. useSyncExternalStore, not useState+useEffect: a media change landing between
// render and the effect running would be missed (same reason useIsOnline uses it). Desktop-first
// server/default value: anything without matchMedia reads as wide, so a non-browser render can never
// boot into the drawer layout.
export function useIsNarrowViewport(): boolean {
	return useSyncExternalStore(subscribeToLayoutBreakpoint, isNarrowViewport, () => false)
}
