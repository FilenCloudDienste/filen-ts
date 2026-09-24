import { useEffect, useSyncExternalStore } from "react"
import { notifyManager } from "@tanstack/react-query"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { queryClient } from "@/queries/client"
import { useChats } from "@/features/chats/queries/chats"
import { chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { refetchChatsAndMessages } from "@/features/chats/lib/refetchChatsAndMessages"
import { countUnreadMessages } from "@/features/chats/hooks/useChatUnreadCount"
import type { BlockedUsers } from "@filen/shared"

// The sum reads each chat's message cache without observing it, so a change to message caches alone
// re-renders nothing: the resync lands every chat's messages after the list, and a socket edit or delete
// patches a thread without touching the list. This moves on every write to, or removal of, a message
// cache, and goes into the sum as an input so its memo re-runs. One cache listener for the whole app,
// subscribed from the start so no write lands unseen before the rail subscribes.
let messagesVersion = 0
let messagesVersionNotifyPending = false
const messagesVersionListeners = new Set<() => void>()

// The part of a query-cache event this reads; the event types its query's key as any.
interface MessagesCacheEvent {
	type: string
	action?: { type?: string }
	query: { queryKey: readonly unknown[] }
}

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

function subscribeMessagesVersion(listener: () => void): () => void {
	messagesVersionListeners.add(listener)

	return () => {
		messagesVersionListeners.delete(listener)
	}
}

function getMessagesVersion(): number {
	return messagesVersion
}

export interface GlobalUnread {
	// Summed unread across every chat whose message cache is resident.
	count: number
	// True when at least one chat's message cache is still unresolved — its unread contribution is
	// unknown, so the caller triggers a bulk resync rather than under-counting silently.
	hasMissingMessages: boolean
}

// Pure global tally — sums each chat's unread over its resident message cache (read imperatively via
// `getMessages`, NOT a hook, so summing over N chats costs zero extra query observers). A chat with no
// cached messages is skipped and flags `hasMissingMessages` (not counted as 0), so the caller knows to
// heal rather than trust an under-count. Exported bare for unit testing. _messagesVersion is read only so
// memoisation keys on the message-cache version counter.
export function sumUnread(
	chats: readonly Chat[],
	getMessages: (uuid: string) => ChatMessage[] | undefined,
	userId: bigint | undefined,
	blocked: BlockedUsers,
	_messagesVersion?: number
): GlobalUnread {
	let count = 0
	let hasMissingMessages = false

	for (const chat of chats) {
		const messages = getMessages(chat.uuid)

		if (messages === undefined) {
			hasMissingMessages = true

			continue
		}

		count += countUnreadMessages(messages, chat, userId, blocked)
	}

	return { count, hasMissingMessages }
}

// Global unread count for the rail badge — client-derived, replacing the flaky getAllChatsUnreadCount
// scalar. Passively reads the chat-list cache (`enabled: false`) and sums each chat's unread off its
// resident message cache. Two resync triggers, both funneling through the Semaphore(1)-guarded bulk
// refetch (so overlapping fires collapse into one pass):
//   - mount-once: fills every chat's message cache at first shell mount (there is no per-chat message
//     fetch otherwise — web fetches lazily per opened thread).
//   - missing-messages self-heal: any chat still lacking its message cache gets just that cache fetched.
// Realtime socket cache patches keep the derived count correct between resyncs; the socket reconnect
// handler fires the same bulk refetch directly.
export function useChatsUnreadCount(userId: bigint | undefined): number {
	const chatsQuery = useChats({ enabled: false })
	const blocked = useBlockedUsers(false)
	const messagesVersion = useSyncExternalStore(subscribeMessagesVersion, getMessagesVersion)
	const chats = chatsQuery.data ?? []
	const { count, hasMissingMessages } = sumUnread(chats, chatMessagesQueryGet, userId, blocked, messagesVersion)

	// Mount-once fill. The bulk fetch's own mutex makes a StrictMode double-invoke (or an overlap with
	// the self-heal below) safe, so no mount guard of its own is needed.
	useEffect(() => {
		void refetchChatsAndMessages()
	}, [])

	// Self-heal: a chat missing its message cache means the count is under-reporting — fetch what is missing.
	useEffect(() => {
		if (hasMissingMessages) {
			void refetchChatsAndMessages({ onlyMissing: true })
		}
	}, [hasMissingMessages])

	return count
}
