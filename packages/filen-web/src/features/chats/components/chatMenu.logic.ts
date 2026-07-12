import { type LucideIcon } from "lucide-react"
import { CHAT_ACTION_DEFS } from "@/features/chats/lib/actionDefs"
import { isChatUndecryptable } from "@/features/chats/lib/sort"
import type { Chat } from "@filen/sdk-rs"
import type { ChatsKey } from "@/lib/i18n"

// Dialog kinds a chat-menu entry can dispatch to the surface-level dialog host (useChatDialogHost) —
// mirrors notes' NoteActionDialogKind split. "create" is deliberately NOT here — it carries no Chat
// payload (there is nothing to act on yet) and is opened through the host's own openCreateChatDialog,
// never through a chatMenuActions descriptor.
export type ChatActionDialogKind = "rename" | "delete" | "leave" | "participants"

export type ChatActionId = "markRead" | "mute" | "participants" | "rename" | "delete" | "leave"

interface ChatActionDescriptorShared {
	id: ChatActionId
	labelKey: ChatsKey
	icon: LucideIcon
	destructive?: boolean
	// Present-but-disabled (never absent) once set to false — mirrors itemMenu.logic.ts's own field.
	// Only applyOfflineGate below ever sets it; chatMenuActions itself never disables a descriptor it
	// decides to include.
	enabled?: boolean
}

// "direct" resolves immediately (markRead/mute-toggle); "dialog" opens the surface's dialog host on
// the given kind — mutually exclusive by construction, same shape as notes' NoteActionDescriptor.
export type ChatActionDescriptor =
	(ChatActionDescriptorShared & { run: "direct" }) | (ChatActionDescriptorShared & { run: "dialog"; dialogKind: ChatActionDialogKind })

const MARK_READ: ChatActionDescriptor = { id: "markRead", ...CHAT_ACTION_DEFS.markRead, run: "direct" }
const PARTICIPANTS: ChatActionDescriptor = {
	id: "participants",
	...CHAT_ACTION_DEFS.participants,
	run: "dialog",
	dialogKind: "participants"
}
const RENAME: ChatActionDescriptor = { id: "rename", ...CHAT_ACTION_DEFS.rename, run: "dialog", dialogKind: "rename" }
const DELETE_CHAT: ChatActionDescriptor = { id: "delete", ...CHAT_ACTION_DEFS.delete, run: "dialog", dialogKind: "delete" }
const LEAVE_CHAT: ChatActionDescriptor = { id: "leave", ...CHAT_ACTION_DEFS.leave, run: "dialog", dialogKind: "leave" }

function muteDescriptor(chat: Chat): ChatActionDescriptor {
	return chat.muted ? { id: "mute", ...CHAT_ACTION_DEFS.unmute, run: "direct" } : { id: "mute", ...CHAT_ACTION_DEFS.mute, run: "direct" }
}

// Pure per-conversation menu builder shared by BOTH the sidebar row's context menu and the thread
// header's ⋮ trigger (chatMenu.tsx) — one descriptor list, gated purely on the chat's own flags +
// ownership, so it stays trivially testable without rendering anything (mirrors noteMenuActions).
// `hasUnread` is caller-computed (chatHasUnread, unread.logic.ts) rather than re-derived here so this
// stays a pure function of its own inputs, with no query-cache/account dependency of its own.
export function chatMenuActions(chat: Chat, currentUserId: bigint | undefined, hasUnread: boolean): ChatActionDescriptor[] {
	const owner = currentUserId !== undefined && chat.ownerId === currentUserId

	// An undecryptable conversation (group key didn't decrypt) can only be left or deleted — mute/
	// rename/participants/markRead all need decrypted state this chat doesn't have (mirrors mobile's
	// own undecryptable menu branch, list/chat/menu.tsx: `isOwner ? [delete] : [leave]`).
	if (isChatUndecryptable(chat)) {
		return [owner ? DELETE_CHAT : LEAVE_CHAT]
	}

	const actions: ChatActionDescriptor[] = []

	if (hasUnread) {
		actions.push(MARK_READ)
	}

	actions.push(muteDescriptor(chat), PARTICIPANTS)

	// Rename is owner-only (verified against mobile's createMenuButtons: "editName" only appears in the
	// isOwner branch); participants view/mute stay open to any participant.
	if (owner) {
		actions.push(RENAME)
	}

	// Delete (owner) vs. Leave (non-owner self-remove) — mutually exclusive, the two ways a conversation
	// can vanish from an owner's vs. a participant's own list.
	actions.push(owner ? DELETE_CHAT : LEAVE_CHAT)

	return actions
}

// Offline-gated ids: mute/rename/participants/delete/leave all write to the SDK. markRead is left
// alone — it fires constantly as a read-state side effect (opening a conversation), not a deliberate
// user mutation, and mirrors mobile leaving it ungated. "send" is the composer's own concern
// (composer.tsx) and deliberately NEVER gates offline — it queues through the durable outbox instead.
const OFFLINE_GATED_IDS: ReadonlySet<ChatActionId> = new Set(["mute", "rename", "participants", "delete", "leave"])

export function applyOfflineGate(actions: ChatActionDescriptor[], isOnline: boolean): ChatActionDescriptor[] {
	if (isOnline) {
		return actions
	}

	return actions.map(action => (OFFLINE_GATED_IDS.has(action.id) ? { ...action, enabled: false } : action))
}
