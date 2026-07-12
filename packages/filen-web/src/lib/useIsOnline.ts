import { useSyncExternalStore } from "react"
import { onlineManager } from "@tanstack/react-query"

// Reactive view of TanStack's onlineManager, which react-query's default browser adapter already
// keeps in sync with `navigator.onLine` + the window `online`/`offline` events (see
// queries/client.ts) — this hook and every `onlineManager.isOnline()` read elsewhere (chats/notes
// sync hosts) share that one subscription, so the app-wide "are we online" answer never drifts.
// useSyncExternalStore is the concurrent-safe way to read an external store from a component: a
// useState+useEffect pair can miss a store change that lands between render and the effect running.
export function useIsOnline(): boolean {
	return useSyncExternalStore(
		listener => onlineManager.subscribe(listener),
		() => onlineManager.isOnline(),
		() => true
	)
}
