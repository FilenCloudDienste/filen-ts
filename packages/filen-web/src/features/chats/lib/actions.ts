import type { Chat, Contact, UserInfo } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { chatsQueryUpsert, chatsQueryRemove } from "@/features/chats/queries/chats"
import { chatMessagesQueryKey } from "@/features/chats/queries/chatMessages"
import { purgeChatInflightState } from "@/features/chats/lib/inflight"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type ActionOutcome, type VoidActionOutcome } from "@/lib/actions/outcome"

export type { ActionOutcome, VoidActionOutcome }

// The conversation-management action layer — no send, no composer (that lives separately, gated on the
// send outbox: composer.tsx / lib/sync.ts). Every helper is a plain async function: call the SDK, then (only on
// success) patch the chats-list cache directly (confirm-then-patch, mirrors notes/lib/actions.ts).
// Nothing here calls toast — every caller (chatMenu.tsx, useChatDialogHost, createChatDialog, ...)
// resolves the outcome and surfaces `errorLabel(dto)` itself, same convention as notes.

// Same rationale as notes' currentUserId(): the account query is warm by the time any chat surface can
// render, so a cache miss degrades to undefined rather than throwing — every owner-gate below treats an
// unresolved id as "not the owner" (the safer default; the SDK itself is the final authority anyway).
function currentUserId(): bigint | undefined {
	return queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)?.id
}

// Chat.ownerId is a single bigint field on the Chat itself (unlike NoteParticipant's own per-row
// isOwner flag) — no participant lookup needed.
export function isChatOwner(chat: Chat, userId: bigint | undefined = currentUserId()): boolean {
	return userId !== undefined && chat.ownerId === userId
}

function ownerGateError(): ActionOutcome<Chat> {
	const message = i18n.t("chats:chatOwnerOnlyError")

	return { status: "error", dto: { species: "plain", message, label: message } }
}

// ── Create ───────────────────────────────────────────────────────────────

// The picker (createChatDialog.tsx) treats a 0-selection submit as cancel and never calls this — the
// empty-contacts guard here is defense-in-depth for any other future call site, mirroring the notes/
// drive convention of gating twice (menu + action layer).
export async function createChat(contacts: Contact[]): Promise<ActionOutcome<Chat>> {
	if (contacts.length === 0) {
		const message = i18n.t("chats:chatCreateNoContactsError")
		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	let chat: Chat

	try {
		chat = await runOp(sdkApi.createChat(contacts))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	chatsQueryUpsert(chat)

	return { status: "success", item: chat }
}

// ── Rename (owner-only) ──────────────────────────────────────────────────

// No-op on empty/unchanged (mirrors notes' setNoteTitle) — a blank or identical value never reaches
// the SDK at all.
export async function renameChat(chat: Chat, name: string): Promise<ActionOutcome<Chat>> {
	if (!isChatOwner(chat)) {
		return ownerGateError()
	}

	const trimmed = name.trim()

	if (trimmed.length === 0 || trimmed === (chat.name ?? "")) {
		return { status: "success", item: chat }
	}

	let updated: Chat

	try {
		updated = await runOp(sdkApi.renameChat(chat, trimmed))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	chatsQueryUpsert(updated)

	return { status: "success", item: updated }
}

// ── Mute (any participant — a personal setting, not owner-gated) ────────

export async function setChatMuted(chat: Chat, mute: boolean): Promise<ActionOutcome<Chat>> {
	if (chat.muted === mute) {
		return { status: "success", item: chat }
	}

	let updated: Chat

	try {
		updated = await runOp(sdkApi.muteChat(chat, mute))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	chatsQueryUpsert(updated)

	return { status: "success", item: updated }
}

// ── Leave (non-owner self-remove) / Delete (owner) ───────────────────────

export interface LeaveOrDeleteChatOptions {
	// Fired once the SDK confirms, BEFORE the chat is stripped from the cache — the caller's chance to
	// navigate away first if this chat is the currently-routed one (mirrors notes' deleteNote/leaveNote
	// beforeCacheRemoval; the router-native equivalent of mobile's deferred-cache-removal nav-race guard).
	beforeCacheRemoval?: () => void
}

// Mirrors mobile's chats.leave: no internal ownership gate (any participant, owner included, can leave
// — the UI only ever exposes this to non-owners since Delete covers the owner's own exit).
export async function leaveChat(chat: Chat, opts?: LeaveOrDeleteChatOptions): Promise<VoidActionOutcome> {
	try {
		await runOp(sdkApi.leaveChat(chat))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	// The sync must never retry a queued send into a chat we just left — best-effort, never throws.
	await purgeChatInflightState(chat.uuid)

	opts?.beforeCacheRemoval?.()
	chatsQueryRemove(chat.uuid)
	queryClient.removeQueries({ queryKey: chatMessagesQueryKey(chat.uuid) })

	return { status: "success" }
}

export async function deleteChat(chat: Chat, opts?: LeaveOrDeleteChatOptions): Promise<VoidActionOutcome> {
	if (!isChatOwner(chat)) {
		const message = i18n.t("chats:chatOwnerOnlyError")
		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	try {
		await runOp(sdkApi.deleteChat(chat))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	await purgeChatInflightState(chat.uuid)

	opts?.beforeCacheRemoval?.()
	chatsQueryRemove(chat.uuid)
	queryClient.removeQueries({ queryKey: chatMessagesQueryKey(chat.uuid) })

	return { status: "success" }
}

// ── Mark read (explicit action only — never auto-fired on thread open) ─────────────────────

// Wired from chatMenu's own "Mark as read" entry (row context menu + thread header trigger), never
// from a route-mount effect — old-web's explicit-mark model, not mobile's screen-open trigger.
// Both SDK calls fire together
// (mirrors mobile's UI-level markAsRead handler, chat.tsx: Promise.all, not allSettled — an explicit
// user action's failure should surface, unlike the send path's best-effort post-commit housekeeping).
export async function markChatRead(chat: Chat): Promise<VoidActionOutcome> {
	let updatedChats: Chat[]

	try {
		;[updatedChats] = await Promise.all([runOp(sdkApi.updateLastChatFocusTimesNow([chat])), runOp(sdkApi.markChatRead(chat))])
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	const refreshed = updatedChats[0]

	if (refreshed) {
		chatsQueryUpsert(refreshed)
	}

	return { status: "success" }
}
