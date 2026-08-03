import {
	CopyIcon,
	Trash2Icon,
	RefreshCwIcon,
	XIcon,
	CornerUpLeftIcon,
	PencilIcon,
	ImageOffIcon,
	UserXIcon,
	type LucideIcon
} from "lucide-react"
import type { ChatMessage } from "@filen/sdk-rs"
import type { ChatsKey } from "@/lib/i18n"
import type { ChatSendState } from "@/features/chats/store/useChatsInflight"
import { isBlocked, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@/features/contacts/lib/blocking"

export type MessageActionId = "reply" | "copy" | "edit" | "delete" | "retry" | "remove" | "disableEmbed" | "block"

// "direct" (reply/copy/edit/retry/remove/disableEmbed — no confirm) vs "dialog" (delete — confirm
// first). reply/edit set composer state; retry/remove act on a failed optimistic entry; delete acts on
// a committed message; disableEmbed is the sender's own embed opt-out (confirm-free, mirrors delete's
// online-only posture minus the confirm step — see messageActions.ts's disableMessageEmbed).
interface MessageActionDescriptorShared {
	labelKey: ChatsKey
	icon: LucideIcon
	// Present-but-disabled (never absent) once set to false — same field and semantics as
	// ChatActionDescriptor's. Only applyMessageOfflineGate below ever sets it.
	enabled?: boolean
}

export type MessageActionDescriptor =
	| (MessageActionDescriptorShared & { id: "reply"; run: "direct" })
	| (MessageActionDescriptorShared & { id: "copy"; run: "direct" })
	| (MessageActionDescriptorShared & { id: "edit"; run: "direct" })
	| (MessageActionDescriptorShared & { id: "delete"; run: "dialog"; destructive: true })
	| (MessageActionDescriptorShared & { id: "retry"; run: "direct" })
	| (MessageActionDescriptorShared & { id: "remove"; run: "direct"; destructive: true })
	| (MessageActionDescriptorShared & { id: "disableEmbed"; run: "direct" })
	| (MessageActionDescriptorShared & { id: "block"; run: "direct"; destructive: true })

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
const BLOCK: MessageActionDescriptor = {
	id: "block",
	labelKey: "chatMessageActionBlock",
	icon: UserXIcon,
	run: "direct",
	destructive: true
}

// Pure per-message menu builder (mobile parity: features/chats/.../message/menu.tsx). Entries depend on
// the message's SEND STATE and whether the reader is its sender (the MESSAGE sender, `senderId ===
// userId`, NOT the chat owner — senderId is `number` on the wasm surface, coerced to BigInt before the
// compare):
//   - "failed"    → copy (if text) + retry + remove — an optimistic send that ran out of its retry
//                   budget; reply/edit/delete would target a uuid the server never learned.
//   - "pending"   → copy only (queued, not yet dispatched; no server uuid to reply to/edit yet).
//   - "sending"   → copy only, SAME as "pending" — the send call is actually outstanding and
//                   unrecallable, so retry/remove (which would act on a snapshot that delivers
//                   regardless) must stay hidden even if a stale error record from an earlier
//                   attempt would otherwise have offered them.
//   - "confirmed" → reply + copy (any decryptable message) + edit + delete (sender-only) +
//                   disableEmbed (sender-only, only when the message actually has an active embed to
//                   disable — `hasEmbeds` is the caller's own embeds.logic.ts classification, computed
//                   once per row rather than re-derived here so this stays a pure, network-free gate).
//                   An undecryptable own message still offers delete (its text can't be copied/edited).
export function messageMenuActions(
	message: ChatMessage,
	currentUserId: bigint | undefined,
	sendState: ChatSendState = "confirmed",
	hasEmbeds = false,
	blocked: BlockedUsers = EMPTY_BLOCKED_USERS
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

	const senderId = BigInt(message.senderId)
	const isSender = currentUserId !== undefined && senderId === currentUserId

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

	// Block the sender (chat side) — a committed message from someone OTHER than us who is not
	// already blocked. Gated on a known current user (never offer "block" when we can't tell whose message
	// it is) so we never surface it on our own bubble. A blocked sender's messages drop out of the unread
	// count immediately (isMessageUnread cross-references the same blocked set).
	if (
		sendState === "confirmed" &&
		currentUserId !== undefined &&
		!isSender &&
		!isBlocked({ userId: senderId, email: message.senderEmail }, blocked)
	) {
		actions.push(BLOCK)
	}

	return actions
}

// Offline-gated ids: edit/delete/disableEmbed/block all write to the SDK. reply and copy are purely local
// (composer state, clipboard); retry re-queues into the durable send outbox, which is deliberately never
// offline-gated; remove only drops a local optimistic entry.
const OFFLINE_GATED_IDS: ReadonlySet<MessageActionId> = new Set(["edit", "delete", "disableEmbed", "block"])

export function applyMessageOfflineGate(actions: MessageActionDescriptor[], isOnline: boolean): MessageActionDescriptor[] {
	if (isOnline) {
		return actions
	}

	return actions.map(action => (OFFLINE_GATED_IDS.has(action.id) ? { ...action, enabled: false } : action))
}
