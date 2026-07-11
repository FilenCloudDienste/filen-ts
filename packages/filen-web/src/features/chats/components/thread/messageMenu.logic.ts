import { CopyIcon, Trash2Icon, RefreshCwIcon, XIcon, CornerUpLeftIcon, PencilIcon, ImageOffIcon, type LucideIcon } from "lucide-react"
import type { ChatMessage } from "@filen/sdk-rs"
import type { ChatsKey } from "@/lib/i18n"
import type { ChatSendState } from "@/features/chats/store/useChatsInflight"

export type MessageActionId = "reply" | "copy" | "edit" | "delete" | "retry" | "remove" | "disableEmbed"

// "direct" (reply/copy/edit/retry/remove/disableEmbed — no confirm) vs "dialog" (delete — confirm
// first). reply/edit set composer state; retry/remove act on a failed optimistic entry; delete acts on
// a committed message; disableEmbed is the sender's own embed opt-out (confirm-free, mirrors delete's
// online-only posture minus the confirm step — see messageActions.ts's disableMessageEmbed).
export type MessageActionDescriptor =
	| { id: "reply"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "copy"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "edit"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "delete"; labelKey: ChatsKey; icon: LucideIcon; run: "dialog"; destructive: true }
	| { id: "retry"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "remove"; labelKey: ChatsKey; icon: LucideIcon; run: "direct"; destructive: true }
	| { id: "disableEmbed"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }

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
const DISABLE_EMBED: MessageActionDescriptor = {
	id: "disableEmbed",
	labelKey: "chatMessageActionDisableEmbed",
	icon: ImageOffIcon,
	run: "direct"
}

// Pure per-message menu builder (mobile parity: features/chats/.../message/menu.tsx). Entries depend on
// the message's SEND STATE and whether the reader is its sender (the MESSAGE sender, `senderId ===
// userId`, NOT the chat owner — senderId is `number` on the wasm surface, coerced to BigInt before the
// compare):
//   - "failed"    → copy (if text) + retry + remove — an optimistic send that ran out of its retry
//                   budget; reply/edit/delete would target a uuid the server never learned.
//   - "pending"   → copy only (a queued/in-flight send; no server uuid to reply to/edit yet).
//   - "confirmed" → reply + copy (any decryptable message) + edit + delete (sender-only) +
//                   disableEmbed (sender-only, only when the message actually has an active embed to
//                   disable — `hasEmbeds` is the caller's own embeds.logic.ts classification, computed
//                   once per row rather than re-derived here so this stays a pure, network-free gate).
//                   An undecryptable own message still offers delete (its text can't be copied/edited).
export function messageMenuActions(
	message: ChatMessage,
	currentUserId: bigint | undefined,
	sendState: ChatSendState = "confirmed",
	hasEmbeds = false
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

		if (hasEmbeds) {
			actions.push(DISABLE_EMBED)
		}

		actions.push(DELETE_MESSAGE)
	}

	return actions
}
