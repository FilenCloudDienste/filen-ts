import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { chatsQueryUpsert } from "@/features/chats/queries/chats"
import { chatMessagesQueryRemove, chatMessagesQueryUpsert } from "@/features/chats/queries/chatMessages"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"

export type { VoidActionOutcome }

// Message-level actions that need no OUTBOX. Copy-to-clipboard is a pure client affordance with
// nothing to patch, so it lives inline in messageMenu.tsx (mirrors noteMenu.tsx's own copyId handling)
// rather than here. Edit/disableEmbed are ONLINE-only / best-effort — NOT routed through the send
// outbox — mirroring mobile/old-web: only the initial SEND is fault-tolerant, an edit/embed-toggle
// targets an already-committed server uuid and a failure just surfaces its own error toast.

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

// Sender-only (gate lives in messageMenu.logic — the entry is absent for a non-sender). editMessage
// returns the re-encrypted ChatMessage (same uuid, edited=true); the returned message patches the
// thread cache so the edited marker appears without waiting for the socket echo (C5). Online-best-
// effort: a failure returns an error DTO and the caller (composer) restores the input for a retry.
export async function editMessage(chat: Chat, message: ChatMessage, newMessage: string): Promise<VoidActionOutcome> {
	let updated: ChatMessage

	try {
		updated = await runOp(sdkApi.editMessage(chat, message, newMessage))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	chatMessagesQueryUpsert(chat.uuid, updated)

	return { status: "success" }
}

// Sender-only (gate lives in messageMenu.logic's `hasEmbeds` param — the entry is absent once no
// active embed remains, including right after this itself flips it). Confirm-free (mobile/old-web
// both fire it direct off a click/hover-X, no dialog). `message.chat` (the ChatMessage's own uuid
// field) is enough to patch the right thread cache — this takes only the message, not a Chat, since
// the wasm op itself (disableMessageEmbed(message)) needs no separate chat argument either.
export async function disableMessageEmbed(message: ChatMessage): Promise<VoidActionOutcome> {
	let updated: ChatMessage

	try {
		updated = await runOp(sdkApi.disableMessageEmbed(message))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	chatMessagesQueryUpsert(message.chat, updated)

	return { status: "success" }
}
