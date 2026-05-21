import { useSyncExternalStore } from "react"
import { onlineManager } from "@tanstack/react-query"

/**
 * Reactive view of TanStack's onlineManager. NetInfo events feed onlineManager
 * via src/queries/onlineStatus.ts, so this hook + onlineManager.isOnline() in
 * library code share a single source of truth — no parallel NetInfo
 * subscription. useSyncExternalStore is the React-19-safe way to read an
 * external store: it correctly handles concurrent rendering and avoids the
 * stale-snapshot trap that a useState+useEffect pair can fall into when the
 * external store changes between the render and the effect.
 */
export default function useIsOnline(): boolean {
	return useSyncExternalStore(
		listener => onlineManager.subscribe(listener),
		() => onlineManager.isOnline(),
		() => true
	)
}
