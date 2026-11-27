import { CHAT_ACTION_DEFS } from "@/features/chats/lib/actionDefs"
import { isChatOwner, isChatUndecryptable } from "@/features/chats/lib/sort"
import type { Chat } from "@filen/sdk-rs"
import { type ActionDescriptor } from "@/lib/actionDescriptor"
import type { ChatsKey } from "@/lib/i18n"

// Dialog kinds a chat-menu entry can dispatch to the surface-level dialog host (useChatDialogHost) —
// mirrors notes' NoteActionDialogKind split. "create" is deliberately NOT here — it carries no Chat
// payload (there is nothing to act on yet) and is opened through the host's own openCreateChatDialog,
// never through a chatMenuActions descriptor.
export type ChatActionDialogKind = "rename" | "delete" | "leave" | "participants"

export type ChatActionId = "markRead" | "mute" | "participants" | "rename" | "copyId" | "delete" | "leave"

// `enabled` mirrors drive's descriptors' own field; only applyOfflineGate below ever sets it.
export type ChatActionDescriptor = ActionDescriptor<ChatsKey, ChatActionId, ChatActionDialogKind> & { enabled?: boolean }

const MARK_READ: ChatActionDescriptor = { id: "markRead", ...CHAT_ACTION_DEFS.markRead, run: "direct" }
const PARTICIPANTS: ChatActionDescriptor = {
	id: "participants",
	...CHAT_ACTION_DEFS.participants,
	run: "dialog",
	dialogKind: "participants"
}
const RENAME: ChatActionDescriptor = { id: "rename", ...CHAT_ACTION_DEFS.rename, run: "dialog", dialogKind: "rename" }
// Read-only clipboard utility (old-web parity): the uuid is known even for an undecryptable conversation.
const COPY_ID: ChatActionDescriptor = { id: "copyId", ...CHAT_ACTION_DEFS.copyId, run: "direct" }
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
	const owner = isChatOwner(chat, currentUserId)

	// An undecryptable conversation (group key didn't decrypt) can only be left or deleted — mute/
	// rename/participants/markRead all need decrypted state this chat doesn't have; Copy ID needs only the uuid (mirrors mobile's
	// own undecryptable menu branch, list/chat/menu.tsx: `isOwner ? [delete] : [leave]`).
	if (isChatUndecryptable(chat)) {
		return [COPY_ID, owner ? DELETE_CHAT : LEAVE_CHAT]
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

	actions.push(COPY_ID)

	// Delete (owner) vs. Leave (non-owner self-remove) — mutually exclusive, the two ways a conversation
	// can vanish from an owner's vs. a participant's own list.
	actions.push(owner ? DELETE_CHAT : LEAVE_CHAT)

	return actions
}

// Offline-gated ids, shared with the bulk bar (chatsBulkActionBar.logic.ts) so one chat and several
// chats gate alike: mute/rename/delete/leave all write to the SDK. Participants only opens the chat info
// panel, whose writes are gated one by one, so it stays open offline. markRead is left
// alone — it fires constantly as a read-state side effect (opening a conversation), not a deliberate
// user mutation, and mirrors mobile leaving it ungated. "send" is the composer's own concern
// (composer.tsx) and deliberately NEVER gates offline — it queues through the durable outbox instead.
export const CHAT_OFFLINE_GATED_IDS: ReadonlySet<ChatActionId> = new Set(["mute", "rename", "delete", "leave"])

export function applyOfflineGate(actions: ChatActionDescriptor[], isOnline: boolean): ChatActionDescriptor[] {
	if (isOnline) {
		return actions
	}

	return actions.map(action => (CHAT_OFFLINE_GATED_IDS.has(action.id) ? { ...action, enabled: false } : action))
}
