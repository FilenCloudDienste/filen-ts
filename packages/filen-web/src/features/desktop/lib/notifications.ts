import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { contactDisplayName, type BlockedUsers } from "@filen/shared"
import { isMessageUnread } from "@/features/chats/lib/unread.logic"
import { isOwnMessage, isSenderBlocked } from "@/features/chats/lib/sender"
import { chatTitle } from "@/features/chats/lib/sort"

// The OS truncates long bodies anyway; this only bounds what the page hands it.
export const NOTIFICATION_BODY_MAX_LENGTH = 200

export interface NotificationContent {
	title: string
	body: string
}

export interface ChatNotificationLabels {
	undecryptableChat: string
	soloFallback: string
	undecryptableMessage: string
}

// A new message is worth a notification when it counts as unread (someone else's, sender not blocked, chat not
// muted: the same @filen/shared rule the unread badge counts). A chat not cached yet (its first message can
// beat the chat itself) has no mute state to read, so only the sender checks apply.
export function chatMessageNotification(
	message: ChatMessage,
	chat: Chat | undefined,
	userId: bigint | undefined,
	blocked: BlockedUsers,
	labels: ChatNotificationLabels
): NotificationContent | null {
	if (userId === undefined) {
		return null
	}

	const notify =
		chat === undefined
			? !isOwnMessage(message, userId) && !isSenderBlocked(message, blocked)
			: isMessageUnread(message, chat, userId, blocked)

	if (!notify) {
		return null
	}

	const sender = contactDisplayName({ email: message.senderEmail, nickName: message.senderNickName })
	const text = (message.message ?? labels.undecryptableMessage).slice(0, NOTIFICATION_BODY_MAX_LENGTH)

	if (chat === undefined) {
		return { title: sender, body: text }
	}

	// A group names the chat and prefixes the sender; a conversation with one other person is titled by them.
	return {
		title: chatTitle(chat, userId, labels.undecryptableChat, labels.soloFallback),
		body: chat.participants.length > 2 ? `${sender}: ${text}` : text
	}
}
