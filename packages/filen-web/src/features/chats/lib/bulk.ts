import type { Chat } from "@filen/sdk-rs"
import { type ErrorDTO } from "@/lib/sdk/errors"
import { runBulk, type BulkOutcome } from "@/features/drive/lib/bulk"
import { markChatRead, setChatMuted, deleteChat, leaveChat, type LeaveOrDeleteChatOptions } from "@/features/chats/lib/actions"

// Bulk-action layer for the chats-list multi-selection bar — every helper reuses the exact single-chat
// op + cache patch from lib/actions.ts (never a duplicated SDK call), fanned out through drive's generic
// runBulk for the same partial-success semantics every other bulk surface in this app uses. Mirrors
// features/notes/lib/bulk.ts exactly, sized down to the four actions a chat selection actually supports
// (no archive/trash lifecycle, no tags).

// Adapts any never-throwing outcome-returning helper above into runBulk's throw-on-failure per-item
// contract — mirrors notes' runNotesBulk / contacts' runContactsBulk exactly.
function runChatsBulk<T>(
	items: readonly T[],
	perItem: (item: T) => Promise<{ status: "success" } | { status: "error"; dto: ErrorDTO }>
): Promise<BulkOutcome<T>> {
	return runBulk([...items], async item => {
		const outcome = await perItem(item)

		if (outcome.status === "error") {
			// Mirrors runOp/runNotesBulk: a plain ErrorDTO thrown intact is what runBulk's per-item catch
			// (and the BulkFailure.error it produces) expects to receive.
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberate, see above
			throw outcome.dto
		}
	})
}

export function markChatsRead(chats: readonly Chat[]): Promise<BulkOutcome<Chat>> {
	return runChatsBulk(chats, chat => markChatRead(chat))
}

// Explicit-target (not per-chat toggle): every selected chat is driven to the SAME `mute` value — the
// bulk bar computes that target from the selection's own majority flag (`!flags.includesMuted`, the
// same SET semantics notes' bulk pin/favorite use), never each chat's individual current state.
export function setChatsMuted(chats: readonly Chat[], mute: boolean): Promise<BulkOutcome<Chat>> {
	return runChatsBulk(chats, chat => setChatMuted(chat, mute))
}

export interface BulkDeleteOrLeaveChatsOptions {
	// Fired per-chat, BEFORE that chat leaves the cache — mirrors LeaveOrDeleteChatOptions.beforeCacheRemoval,
	// threaded through so the caller (useChatDialogHost) can navigate away first if the CURRENTLY routed
	// conversation happens to be among those permanently deleted/left in this batch.
	beforeCacheRemoval?: (chat: Chat) => void
}

export function deleteChatsPermanently(chats: readonly Chat[], opts?: BulkDeleteOrLeaveChatsOptions): Promise<BulkOutcome<Chat>> {
	return runChatsBulk<Chat>(chats, chat => {
		const chatOpts: LeaveOrDeleteChatOptions = { beforeCacheRemoval: () => opts?.beforeCacheRemoval?.(chat) }

		return deleteChat(chat, chatOpts)
	})
}

export function leaveChats(chats: readonly Chat[], opts?: BulkDeleteOrLeaveChatsOptions): Promise<BulkOutcome<Chat>> {
	return runChatsBulk<Chat>(chats, chat => {
		const chatOpts: LeaveOrDeleteChatOptions = { beforeCacheRemoval: () => opts?.beforeCacheRemoval?.(chat) }

		return leaveChat(chat, chatOpts)
	})
}
