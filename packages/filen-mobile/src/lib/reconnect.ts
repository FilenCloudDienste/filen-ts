import { onlineManager } from "@tanstack/react-query"
import offline from "@/features/offline/offline"
import { sync as notesSync } from "@/features/notes/components/sync"
import { sync as chatsSync } from "@/components/chats/sync"
import cameraUpload from "@/features/cameraUpload/cameraUpload"

let started = false

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
 * - notesSync.executeNow(): flushes any inflight note content that was
 *   accumulated offline. executeNow() now falls through to sync() when no
 *   debounce is queued, so the cold-start case (boot offline with inflight
 *   on disk, no typing yet, then reconnect) also drains.
 * - chatsSync.syncNow(): same for inflight chat messages.
 */
export function startReconnectListener(): void {
	if (started) {
		return
	}

	started = true

	let lastOnline = onlineManager.isOnline()

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

		cameraUpload.sync().catch(console.error)
		offline.sync().catch(console.error)
		notesSync.executeNow()
		chatsSync.syncNow()
	})
}
