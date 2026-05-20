import { onlineManager } from "@tanstack/react-query"
import offline from "@/lib/offline"
import { sync as notesSync } from "@/components/notes/sync"
import { sync as chatsSync } from "@/components/chats/sync"

let started = false
let lastOnline = onlineManager.isOnline()

/**
 * Subscribes to onlineManager once at startup and replays the sync routines
 * that previously bailed out due to being offline. Idempotent — calling
 * startReconnectListener() twice is a no-op.
 *
 * What it does NOT need to do:
 * - Refetch TanStack queries — DEFAULT_QUERY_OPTIONS.refetchOnReconnect:
 *   "always" handles that automatically. TanStack also serializes refetches
 *   per query key so there's no thunder-herd risk.
 *
 * What it DOES do on every false → true transition:
 * - offline.sync(): reconciles the offline-files store against current
 *   server state (renames, deletes, modifications). The library-level
 *   gate inside sync() means cold-start in airplane mode no-ops; this
 *   listener catches reconnect mid-session.
 * - notesSync.forceSync(): flushes any inflight note content that was
 *   accumulated offline. The existing executeNow() only fires whatever
 *   debounce happens to be queued — once a debounce has been consumed by
 *   the offline-gate early-return, executeNow is a no-op. forceSync()
 *   awaits sync() directly so the inflight store is processed.
 * - chatsSync.forceSync(): same for inflight chat messages.
 */
export function startReconnectListener(): void {
	if (started) {
		return
	}

	started = true

	onlineManager.subscribe(isOnline => {
		// Guard against duplicate events from NetInfo edge cases (initial
		// state, focus changes that fire stale values).
		if (lastOnline === isOnline) {
			return
		}

		lastOnline = isOnline

		if (!isOnline) {
			return
		}

		offline.sync().catch(console.error)
		notesSync.forceSync().catch(console.error)
		chatsSync.forceSync().catch(console.error)
	})
}
