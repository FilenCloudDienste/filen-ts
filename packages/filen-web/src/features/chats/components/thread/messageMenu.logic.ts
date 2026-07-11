import { CopyIcon, Trash2Icon, type LucideIcon } from "lucide-react"
import type { ChatMessage } from "@filen/sdk-rs"
import type { ChatsKey } from "@/lib/i18n"

export type MessageActionId = "copy" | "delete"

// "direct" (copy — pure clipboard write, no cache patch) vs "dialog" (delete — confirm first). No
// "submenu" kind this wave (edit/reply/embed-disable are out of scope — the composer/embeds waves own
// those).
export type MessageActionDescriptor =
	| { id: "copy"; labelKey: ChatsKey; icon: LucideIcon; run: "direct" }
	| { id: "delete"; labelKey: ChatsKey; icon: LucideIcon; run: "dialog"; destructive: true }

const COPY: MessageActionDescriptor = { id: "copy", labelKey: "chatMessageActionCopy", icon: CopyIcon, run: "direct" }
const DELETE_MESSAGE: MessageActionDescriptor = {
	id: "delete",
	labelKey: "chatMessageActionDelete",
	icon: Trash2Icon,
	run: "dialog",
	destructive: true
}

// Pure per-message menu builder — mirrors chatMenu.logic.ts's shape at message granularity. Copy is
// available whenever there is text to copy (absent on an undecryptable message, message.message ===
// undefined). Delete is SENDER-only — verified against mobile's message menu.tsx:
// `isOwner = info.item.inner.senderId === userId`, the MESSAGE sender, NOT the chat owner (a chat
// owner cannot delete another participant's message). senderId is `number` on the wasm surface, not
// bigint (a codegen quirk — wasm-chats §2.4) — coerced to BigInt before comparing to the bigint
// userId, same rule unread.logic.ts's own self-check already applies; never a raw `===`.
export function messageMenuActions(message: ChatMessage, currentUserId: bigint | undefined): MessageActionDescriptor[] {
	const actions: MessageActionDescriptor[] = []

	if (message.message !== undefined) {
		actions.push(COPY)
	}

	if (currentUserId !== undefined && BigInt(message.senderId) === currentUserId) {
		actions.push(DELETE_MESSAGE)
	}

	return actions
}
