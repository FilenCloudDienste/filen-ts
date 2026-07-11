import { useEffect } from "react"
import { onlineManager } from "@tanstack/react-query"
import { sync } from "@/features/notes/lib/sync"
import { startOutbox } from "@/features/notes/lib/outboxCoordinator"

// The notes sync outbox's driver, mounted ONCE in the authed shell (appShell) — NOT
// the notes route, because a pending outbox must flush even while the user browses drive. startOutbox()
// adopts this tab's role from the db lock (leader-owned outbox): the leader replays the durable
// outbox on mount and runs the push loop; a follower forwards edits to the leader. The
// visibilitychange + reconnect triggers force an immediate flush (a follower forwards the request).
// This host outlives route navigation and is torn down only with the authed shell / on logout; cancel()
// is therefore NOT called on unmount here (logout wires cancel() BEFORE the local wipe). pagehide/
// beforeunload get no authoritative work — durability is the immediate-persist + replay path.
export function SyncHost(): null {
	useEffect(() => {
		void startOutbox()

		const onVisibilityChange = (): void => {
			if (document.hidden) {
				sync.executeNow()
			}
		}

		document.addEventListener("visibilitychange", onVisibilityChange)

		const unsubscribeOnline = onlineManager.subscribe(isOnline => {
			if (isOnline) {
				sync.executeNow()
			}
		})

		return () => {
			document.removeEventListener("visibilitychange", onVisibilityChange)
			unsubscribeOnline()
		}
	}, [])

	return null
}

export default SyncHost
