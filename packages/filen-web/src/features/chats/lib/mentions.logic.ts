import type { ChatMessage, ChatParticipant } from "@filen/sdk-rs"
import type { MessageSegment } from "@filen/shared"
import { isOwnMessage } from "@/features/chats/lib/sender"

// Why a message is addressed to the signed-in user, or null when it is not: an @everyone or an @mention of
// their email, else a reply to one of their messages (the old web app highlighted both). Their own
// messages never are. The email is the participant entry for their id, compared case-insensitively since
// the mention text is typed or completed and the address is the same either way.
export type MessageAddressing = "mention" | "reply"

export function messageAddressing(
	message: Pick<ChatMessage, "senderId" | "replyTo">,
	segments: readonly MessageSegment[],
	participants: readonly Pick<ChatParticipant, "userId" | "email">[],
	currentUserId: bigint | undefined
): MessageAddressing | null {
	if (currentUserId === undefined || isOwnMessage(message, currentUserId)) {
		return null
	}

	const ownEmail = participants.find(participant => participant.userId === currentUserId)?.email.toLowerCase()

	for (const segment of segments) {
		if (segment.kind !== "mention") {
			continue
		}

		if (segment.everyone || (ownEmail !== undefined && segment.email?.toLowerCase() === ownEmail)) {
			return "mention"
		}
	}

	if (message.replyTo !== undefined && isOwnMessage(message.replyTo, currentUserId)) {
		return "reply"
	}

	return null
}
