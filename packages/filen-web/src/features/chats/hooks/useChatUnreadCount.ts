import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { useChatMessages } from "@/features/chats/queries/chatMessages"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { isMessageUnread } from "@/features/chats/lib/unread.logic"
import type { BlockedUsers } from "@/features/contacts/lib/blocking"

// Pure per-chat unread tally — the number of messages in `messages` that count as unread for `chat`
// (isMessageUnread: newer than lastFocus, not ours, not from a blocked sender, chat not muted). Exported
// bare so the derivation is unit-testable without a React render.
export function countUnreadMessages(
	messages: readonly ChatMessage[],
	chat: Chat,
	userId: bigint | undefined,
	blocked: BlockedUsers
): number {
	let count = 0

	for (const message of messages) {
		if (isMessageUnread(message, chat, userId, blocked)) {
			count++
		}
	}

	return count
}

// Per-chat numeric unread count — a PASSIVE cache read (`enabled: false`), so a rendered row never fires
// its own listMessagesBefore; it derives off whatever the bulk refetch (or the open thread) has already
// populated for this chat. A chat whose message cache is still unresolved reads as 0 here (the global
// count hook is what notices the gap and triggers a self-heal). Blocked users come from the same passive
// contacts read the drive sharedIn filter uses — fail-open (0 blocked) until contacts are warm.
export function useChatUnreadCount(chat: Chat, userId: bigint | undefined): number {
	const messagesQuery = useChatMessages(chat.uuid, { enabled: false })
	const blocked = useBlockedUsers(false)

	if (messagesQuery.data === undefined) {
		return 0
	}

	return countUnreadMessages(messagesQuery.data, chat, userId, blocked)
}
