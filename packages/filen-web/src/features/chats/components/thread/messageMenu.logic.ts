import { CopyIcon, Trash2Icon, RefreshCwIcon, XIcon, type LucideIcon } from "lucide-react"
import type { ChatMessage } from "@filen/sdk-rs"
import type { ChatsKey } from "@/lib/i18n"
import type { ChatSendState } from "@/features/chats/store/useChatsInflight"

export type MessageActionId = "copy" | "delete" | "retry" | "remove"

// "direct" (copy/retry/remove — no confirm) vs "dialog" (delete — confirm first). retry/remove act on a
// failed optimistic entry (no server round-trip to confirm); delete acts on a committed message.
export type MessageActionDescriptor =
	| { id: "copy"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "delete"; labelKey: ChatsKey; icon: LucideIcon; run: "dialog"; destructive: true }
	| { id: "retry"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "remove"; labelKey: ChatsKey; icon: LucideIcon; run: "direct"; destructive: true }

const COPY: MessageActionDescriptor = { id: "copy", labelKey: "chatMessageActionCopy", icon: CopyIcon, run: "direct" }
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

// Pure per-message menu builder. Copy is available whenever there is text (absent on an undecryptable
// message, message.message === undefined). The rest depend on the message's SEND STATE:
//   - "failed"    → retry + remove (an optimistic send that ran out of its retry budget; delete does not
//                   apply — it was never committed server-side).
//   - "pending"   → copy only (a queued/in-flight send; nothing to delete or retry yet).
//   - "confirmed" → delete, SENDER-only (verified against mobile's message menu: the MESSAGE sender,
//                   `senderId === userId`, NOT the chat owner). senderId is `number` on the wasm surface
//                   (a codegen quirk), coerced to BigInt before comparing to the bigint userId.
export function messageMenuActions(
	message: ChatMessage,
	currentUserId: bigint | undefined,
	sendState: ChatSendState = "confirmed"
): MessageActionDescriptor[] {
	const actions: MessageActionDescriptor[] = []

	if (message.message !== undefined) {
		actions.push(COPY)
	}

	if (sendState === "failed") {
		actions.push(RETRY, REMOVE)

		return actions
	}

	if (sendState === "confirmed" && currentUserId !== undefined && BigInt(message.senderId) === currentUserId) {
		actions.push(DELETE_MESSAGE)
	}

	return actions
}
