import { useEffect } from "react"
import { onlineManager } from "@tanstack/react-query"
import { sync } from "@/features/chats/lib/sync"

// The chat send outbox's driver, mounted ONCE in the authed shell (appShell) — NOT the chats route,
// because a pending send must flush even while the user browses drive/notes. start() replays the
// durable outbox on mount; the visibilitychange + reconnect triggers force an immediate flush. This
// host outlives route navigation and is torn down only with the authed shell / on logout; cancel() is
// therefore NOT called on unmount here (logout wires cancel() BEFORE the local wipe, iconRail).
//
// SINGLE-TAB scope (this wave): no multi-tab leader — every authed tab runs its own outbox. The leader
// election (one authoritative loop across tabs) is a later wave; this mirrors how notes' outbox shipped
// single-tab first before its outboxCoordinator landed.
export function ChatsSyncHost(): null {
	useEffect(() => {
		sync.start()

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

export default ChatsSyncHost
