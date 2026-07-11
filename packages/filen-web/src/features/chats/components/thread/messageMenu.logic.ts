import { CopyIcon, Trash2Icon, RefreshCwIcon, XIcon, CornerUpLeftIcon, PencilIcon, type LucideIcon } from "lucide-react"
import type { ChatMessage } from "@filen/sdk-rs"
import type { ChatsKey } from "@/lib/i18n"
import type { ChatSendState } from "@/features/chats/store/useChatsInflight"

export type MessageActionId = "reply" | "copy" | "edit" | "delete" | "retry" | "remove"

// "direct" (reply/copy/edit/retry/remove — no confirm) vs "dialog" (delete — confirm first). reply/edit
// set composer state; retry/remove act on a failed optimistic entry; delete acts on a committed message.
export type MessageActionDescriptor =
	| { id: "reply"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "copy"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "edit"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "delete"; labelKey: ChatsKey; icon: LucideIcon; run: "dialog"; destructive: true }
	| { id: "retry"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "remove"; labelKey: ChatsKey; icon: LucideIcon; run: "direct"; destructive: true }

const REPLY: MessageActionDescriptor = { id: "reply", labelKey: "chatMessageActionReply", icon: CornerUpLeftIcon, run: "direct" }
const COPY: MessageActionDescriptor = { id: "copy", labelKey: "chatMessageActionCopy", icon: CopyIcon, run: "direct" }
const EDIT: MessageActionDescriptor = { id: "edit", labelKey: "chatMessageActionEdit", icon: PencilIcon, run: "direct" }
const DELETE_MESSAGE: MessageActionDescriptor = {
	id: "delete",
	labelKey: "chatMessageActionDelete",
	icon: Trash2Icon,
	run: "dialog",
	destructive: true
}
const RETRY: MessageActionDescriptor = { id: "retry", labelKey: "chatMessageActionRetry", icon: RefreshCwIcon, run: "direct" }
const REMOVE: MessageActionDescriptor = {
	id: "remove",
	labelKey: "chatMessageActionRemove",
	icon: XIcon,
	run: "direct",
	destructive: true
}

// Pure per-message menu builder (mobile parity: features/chats/.../message/menu.tsx). Entries depend on
// the message's SEND STATE and whether the reader is its sender (the MESSAGE sender, `senderId ===
// userId`, NOT the chat owner — senderId is `number` on the wasm surface, coerced to BigInt before the
// compare):
//   - "failed"    → copy (if text) + retry + remove — an optimistic send that ran out of its retry
//                   budget; reply/edit/delete would target a uuid the server never learned.
//   - "pending"   → copy only (a queued/in-flight send; no server uuid to reply to/edit yet).
//   - "confirmed" → reply + copy (any decryptable message) + edit + delete (sender-only). An
//                   undecryptable own message still offers delete (its text can't be copied/edited).
export function messageMenuActions(
	message: ChatMessage,
	currentUserId: bigint | undefined,
	sendState: ChatSendState = "confirmed"
): MessageActionDescriptor[] {
	const actions: MessageActionDescriptor[] = []
	const hasText = message.message !== undefined

	if (sendState === "failed") {
		if (hasText) {
			actions.push(COPY)
		}

		actions.push(RETRY, REMOVE)

		return actions
	}

	const isSender = currentUserId !== undefined && BigInt(message.senderId) === currentUserId

	// Reply/edit target a committed server uuid — confirmed only (a pending send carries its inflightId
	// as its uuid, which the server doesn't know).
	if (sendState === "confirmed" && hasText) {
		actions.push(REPLY)
	}

	if (hasText) {
		actions.push(COPY)
	}

	if (sendState === "confirmed" && isSender) {
		if (hasText) {
			actions.push(EDIT)
		}

		actions.push(DELETE_MESSAGE)
	}

	return actions
}
