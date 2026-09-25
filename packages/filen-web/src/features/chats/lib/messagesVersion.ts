import { notifyManager } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"

// The rail's unread sum (useChatsUnreadCount) reads each chat's message cache without observing it, so a
// change to message caches alone re-renders nothing: the resync lands every chat's messages after the list,
// and a socket edit or delete patches a thread without touching the list. This moves on every write to, or
// removal of, a message cache, and goes into the sum as an input so its memo re-runs. One cache listener
// for the whole app, subscribed from the start so no write lands unseen before the rail subscribes.
let messagesVersion = 0
let messagesVersionNotifyPending = false
const messagesVersionListeners = new Set<() => void>()

// The part of a query-cache event this reads; the event types its query's key as any.
interface MessagesCacheEvent {
	type: string
	action?: { type?: string }
	query: { queryKey: readonly unknown[] }
}

// A removal counts: query-core's gc drops a message cache nothing observes (browser timers wrap GC_TIME to
// about 21 days), and the sum then finds it missing and heals it. Sign-out's wipe renders nothing, as it
// detaches the badges first.
function isChatMessagesChange(event: MessagesCacheEvent): boolean {
	return (
		(event.type === "removed" || (event.type === "updated" && event.action?.type === "success")) &&
		event.query.queryKey[0] === "chats" &&
		event.query.queryKey[1] === "messages"
	)
}

queryClient.getQueryCache().subscribe(event => {
	if (!isChatMessagesChange(event)) {
		return
	}

	messagesVersion++

	// Writes landing before the scheduled flush share one notification, delivered in the same batch as the
	// query observers' own, so a fan-out's burst doesn't re-render once per write.
	if (messagesVersionNotifyPending) {
		return
	}

	messagesVersionNotifyPending = true

	notifyManager.schedule(() => {
		messagesVersionNotifyPending = false

		for (const listener of messagesVersionListeners) {
			listener()
		}
	})
})

export function subscribeMessagesVersion(listener: () => void): () => void {
	messagesVersionListeners.add(listener)

	return () => {
		messagesVersionListeners.delete(listener)
	}
}

export function getMessagesVersion(): number {
	return messagesVersion
}

// Sign-out runs this before its wipe. Writes to message caches keep landing until the reload (socket events
// already sent, a parked own-message echo, a read the wipe doesn't cancel), and a rail render would read its
// account and contact requests back into the emptied cache.
export function detachUnreadBadges(): void {
	messagesVersionListeners.clear()
}
