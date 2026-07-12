import { useSyncExternalStore } from "react"
import { onlineManager } from "@tanstack/react-query"

// TanStack's OnlineManager hard-codes its initial state to `true` at construction and only ever
// updates it from a subsequent window `online`/`offline` *event* — it never reads `navigator.onLine`
// on its own. A cold load that starts already offline (a real path here: the app ships a service
// worker that can serve the shell entirely from cache while offline) would otherwise report "online"
// until some later transition fires, which never happens if the device was offline before the tab
// loaded. Seed once, as a module-level side effect that runs on import — before any component can
// read this hook's first render — so the manager's initial value matches reality.
if (typeof navigator !== "undefined") {
	onlineManager.setOnline(navigator.onLine)
}

// Reactive view of TanStack's onlineManager, seeded above and kept in sync afterwards by the window
// `online`/`offline` events it subscribes to internally — this hook and every `onlineManager.isOnline()`
// read elsewhere (chats/notes sync hosts) share that one subscription, so the app-wide "are we online"
// answer never drifts. useSyncExternalStore is the concurrent-safe way to read an external store from
// a component: a useState+useEffect pair can miss a store change that lands between render and the
// effect running.
export function useIsOnline(): boolean {
	return useSyncExternalStore(
		listener => onlineManager.subscribe(listener),
		() => onlineManager.isOnline(),
		() => true
	)
}
