import type { Chat, Contact } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { queryClient } from "@/queries/client"
import { removeQueriesAndPersisted } from "@/queries/persist"
import { accountQueryGet } from "@/queries/account"
import { chatsQueryUpsert, chatsQueryRemove } from "@/features/chats/queries/chats"
import { chatMessagesQueryKey } from "@/features/chats/queries/chatMessages"
import { purgeChatInflightState } from "@/features/chats/lib/inflight"
import { attemptOp, type ActionOutcome, type VoidActionOutcome } from "@/lib/actions/outcome"

export type { ActionOutcome, VoidActionOutcome }

// The conversation-management action layer — no send, no composer (that lives separately, gated on the
// send outbox: composer.tsx / lib/sync.ts). Every helper is a plain async function: call the SDK, then (only on
// success) patch the chats-list cache directly (confirm-then-patch, mirrors notes/lib/actions.ts).
// Nothing here calls toast — every caller (chatMenu.tsx, useChatDialogHost, createChatDialog, ...)
// resolves the outcome and surfaces `errorLabel(dto)` itself, same convention as notes.

// Chat.ownerId is a single bigint field on the Chat itself (unlike NoteParticipant's own per-row
// isOwner flag) — no participant lookup needed.
export function isChatOwner(chat: Chat, userId: bigint | undefined = accountQueryGet()?.id): boolean {
	return userId !== undefined && chat.ownerId === userId
}

function ownerGateError(): ActionOutcome<Chat> {
	return { status: "error", dto: plainErrorDTO(i18n.t("chats:chatOwnerOnlyError")) }
}

// ── Create ───────────────────────────────────────────────────────────────

// The picker (createChatDialog.tsx) treats a 0-selection submit as cancel and never calls this — the
// empty-contacts guard here is defense-in-depth for any other future call site, mirroring the notes/
// drive convention of gating twice (menu + action layer).
export async function createChat(contacts: Contact[]): Promise<ActionOutcome<Chat>> {
	if (contacts.length === 0) {
		return { status: "error", dto: plainErrorDTO(i18n.t("chats:chatCreateNoContactsError")) }
	}

	const outcome = await attemptOp(sdkApi.createChat(contacts))

	if (outcome.status === "success") {
		chatsQueryUpsert(outcome.item)
	}

	return outcome
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

	const outcome = await attemptOp(sdkApi.renameChat(chat, trimmed))

	if (outcome.status === "success") {
		chatsQueryUpsert(outcome.item)
	}

	return outcome
}

// ── Mute (any participant — a personal setting, not owner-gated) ────────

export async function setChatMuted(chat: Chat, mute: boolean): Promise<ActionOutcome<Chat>> {
	if (chat.muted === mute) {
		return { status: "success", item: chat }
	}

	const outcome = await attemptOp(sdkApi.muteChat(chat, mute))

	if (outcome.status === "success") {
		chatsQueryUpsert(outcome.item)
	}

	return outcome
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
	const outcome = await attemptOp(sdkApi.leaveChat(chat))

	if (outcome.status === "error") {
		return outcome
	}

	// The sync must never retry a queued send into a chat we just left — best-effort, never throws.
	await purgeChatInflightState(chat.uuid)

	opts?.beforeCacheRemoval?.()
	chatsQueryRemove(chat.uuid)
	removeQueriesAndPersisted(queryClient, chatMessagesQueryKey(chat.uuid))

	return { status: "success" }
}

export async function deleteChat(chat: Chat, opts?: LeaveOrDeleteChatOptions): Promise<VoidActionOutcome> {
	if (!isChatOwner(chat)) {
		return { status: "error", dto: plainErrorDTO(i18n.t("chats:chatOwnerOnlyError")) }
	}

	const outcome = await attemptOp(sdkApi.deleteChat(chat))

	if (outcome.status === "error") {
		return outcome
	}

	await purgeChatInflightState(chat.uuid)

	opts?.beforeCacheRemoval?.()
	chatsQueryRemove(chat.uuid)
	removeQueriesAndPersisted(queryClient, chatMessagesQueryKey(chat.uuid))

	return { status: "success" }
}

// ── Mark read (explicit action only — never auto-fired on thread open) ─────────────────────

// Wired from chatMenu's own "Mark as read" entry (row context menu + thread header trigger), never
// from a route-mount effect — old-web's explicit-mark model, not mobile's screen-open trigger.
// Both SDK calls fire together
// (mirrors mobile's UI-level markAsRead handler, chat.tsx: Promise.all, not allSettled — an explicit
// user action's failure should surface, unlike the send path's best-effort post-commit housekeeping).
export async function markChatRead(chat: Chat): Promise<VoidActionOutcome> {
	const outcome = await attemptOp(Promise.all([sdkApi.updateLastChatFocusTimesNow([chat]), sdkApi.markChatRead(chat)]))

	if (outcome.status === "error") {
		return outcome
	}

	const refreshed = outcome.item[0][0]

	if (refreshed) {
		// The refreshed chat carries the advanced lastFocus; the client-derived unread count (both the
		// per-row badge and the rail total) re-derives to zero for this chat on the next render off that
		// alone — no separate unread-side cache write is needed.
		chatsQueryUpsert(refreshed)
	}

	return { status: "success" }
}
