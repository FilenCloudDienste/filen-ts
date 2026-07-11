import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { chatsQueryUpsert } from "@/features/chats/queries/chats"
import { chatMessagesQueryRemove } from "@/features/chats/queries/chatMessages"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"

export type { VoidActionOutcome }

// Message-level actions LIMITED to what needs no composer this wave (scope fence: edit and
// disableMessageEmbed both land with the composer/embeds waves). Copy-to-clipboard is a pure client
// affordance with nothing to patch, so it lives inline in messageMenu.tsx (mirrors noteMenu.tsx's own
// copyId handling) rather than here.

// Sender-only (verified against mobile's message menu.tsx: `isOwner = message.senderId === userId` —
// the MESSAGE sender, not the chat owner; a chat owner cannot delete another participant's message).
// The gate itself lives in messageMenu.logic.ts's descriptor builder (the entry is absent for a non-
// sender); this function stays a plain SDK call + cache patch, same posture as every other action here.
export async function deleteMessage(chat: Chat, message: ChatMessage): Promise<VoidActionOutcome> {
	let updatedChat: Chat

	try {
		updatedChat = await runOp(sdkApi.deleteMessage(chat, message))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	chatsQueryUpsert(updatedChat)
	chatMessagesQueryRemove(chat.uuid, message.uuid)

	return { status: "success" }
}
