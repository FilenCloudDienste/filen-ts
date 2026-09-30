import { useEffect, useSyncExternalStore } from "react"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { useChats } from "@/features/chats/queries/chats"
import { chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { getMessagesVersion, subscribeMessagesVersion } from "@/features/chats/lib/messagesVersion"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { CONTACTS_QUERY_KEY, contactsQueryGet, fetchContacts } from "@/features/contacts/queries/contacts"
import { queryClient } from "@/queries/client"
import { noop } from "@/lib/utils"
import { refetchChatsAndMessages } from "@/features/chats/lib/refetchChatsAndMessages"
import { countUnreadMessages } from "@/features/chats/hooks/useChatUnreadCount"
import type { BlockedUsers } from "@filen/shared"

export interface GlobalUnread {
	// Summed unread across every chat whose message cache is resident.
	count: number
	// True when at least one chat's message cache is still unresolved — its unread contribution is
	// unknown, so the caller triggers a bulk resync rather than under-counting silently.
	hasMissingMessages: boolean
}

// Per-chat counts keyed by message-array identity: cached arrays are immutable (every write builds a new
// one), so an event recounts only the chat whose array changed.
const unreadByMessages = new WeakMap<
	readonly ChatMessage[],
	{ chat: Chat; userId: bigint | undefined; blocked: BlockedUsers; count: number }
>()

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

		const cached = unreadByMessages.get(messages)

		if (cached?.chat === chat && cached.userId === userId && cached.blocked === blocked) {
			count += cached.count

			continue
		}

		const chatCount = countUnreadMessages(messages, chat, userId, blocked)

		unreadByMessages.set(messages, { chat, userId, blocked, count: chatCount })

		count += chatCount
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

	// The blocked set comes from a disabled observer (an enabled one here would refetch contacts on every
	// focus app-wide), so on a session with no contacts row yet it is empty and blocked senders' unread
	// messages would count. Fetch the row once, only when there is something to count; the observer picks
	// it up and it persists for later boots.
	const hasUnread = count > 0

	useEffect(() => {
		if (hasUnread && contactsQueryGet() === undefined) {
			queryClient.query({ queryKey: CONTACTS_QUERY_KEY, queryFn: fetchContacts }).catch(noop)
		}
	}, [hasUnread])

	return count
}
