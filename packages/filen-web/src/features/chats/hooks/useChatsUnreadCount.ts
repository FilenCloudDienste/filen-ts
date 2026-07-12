import { useEffect } from "react"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { useChats } from "@/features/chats/queries/chats"
import { chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { refetchChatsAndMessages } from "@/features/chats/lib/refetchChatsAndMessages"
import { countUnreadMessages } from "@/features/chats/hooks/useChatUnreadCount"
import type { BlockedUsers } from "@/features/contacts/lib/blocking"

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
// heal rather than trust an under-count. Exported bare for unit testing.
export function sumUnread(
	chats: readonly Chat[],
	getMessages: (uuid: string) => ChatMessage[] | undefined,
	userId: bigint | undefined,
	blocked: BlockedUsers
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
//   - missing-messages self-heal: any chat still lacking its message cache retriggers the bulk fetch.
// Realtime socket cache patches keep the derived count correct between resyncs; the socket reconnect
// handler fires the same bulk refetch directly.
export function useChatsUnreadCount(userId: bigint | undefined): number {
	const chatsQuery = useChats({ enabled: false })
	const blocked = useBlockedUsers(false)
	const chats = chatsQuery.data ?? []
	const { count, hasMissingMessages } = sumUnread(chats, chatMessagesQueryGet, userId, blocked)

	// Mount-once fill. The bulk fetch's own mutex makes a StrictMode double-invoke (or an overlap with
	// the self-heal below) safe, so no mount guard of its own is needed.
	useEffect(() => {
		void refetchChatsAndMessages()
	}, [])

	// Self-heal: a chat missing its message cache means the count is under-reporting — pull the full set.
	useEffect(() => {
		if (hasMissingMessages) {
			void refetchChatsAndMessages()
		}
	}, [hasMissingMessages])

	return count
}
