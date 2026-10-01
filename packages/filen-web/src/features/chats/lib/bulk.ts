import type { Chat } from "@filen/sdk-rs"
import { runBulkOutcomes, type BulkOutcome, type BulkProgress } from "@/lib/actions/bulk"
import { markChatRead, setChatMuted, deleteChat, leaveChat, type LeaveOrDeleteChatOptions } from "@/features/chats/lib/actions"

// Bulk-action layer for the chats-list multi-selection bar — every helper reuses the exact single-chat
// op + cache patch from lib/actions.ts (never a duplicated SDK call), fanned out through runBulkOutcomes
// for the same partial-success semantics every other bulk surface in this app uses. Mirrors
// features/notes/lib/bulk.ts exactly, sized down to the four actions a chat selection actually supports
// (no archive/trash lifecycle, no tags).

export function markChatsRead(chats: readonly Chat[], onSettled?: BulkProgress): Promise<BulkOutcome<Chat>> {
	return runBulkOutcomes(chats, chat => markChatRead(chat), onSettled)
}

// Explicit-target (not per-chat toggle): every selected chat is driven to the SAME `mute` value — the
// bulk bar computes that target from the selection's own majority flag (`!flags.includesMuted`, the
// same SET semantics notes' bulk pin/favorite use), never each chat's individual current state.
export function setChatsMuted(chats: readonly Chat[], mute: boolean, onSettled?: BulkProgress): Promise<BulkOutcome<Chat>> {
	return runBulkOutcomes(chats, chat => setChatMuted(chat, mute), onSettled)
}

export interface BulkDeleteOrLeaveChatsOptions {
	// Fired per-chat, BEFORE that chat leaves the cache — mirrors LeaveOrDeleteChatOptions.beforeCacheRemoval,
	// threaded through so the caller (useChatDialogHost) can navigate away first if the CURRENTLY routed
	// conversation happens to be among those permanently deleted/left in this batch.
	beforeCacheRemoval?: (chat: Chat) => void
}

export function deleteChatsPermanently(
	chats: readonly Chat[],
	opts?: BulkDeleteOrLeaveChatsOptions,
	onSettled?: BulkProgress
): Promise<BulkOutcome<Chat>> {
	return runBulkOutcomes<Chat>(
		chats,
		chat => {
			const chatOpts: LeaveOrDeleteChatOptions = { beforeCacheRemoval: () => opts?.beforeCacheRemoval?.(chat) }

			return deleteChat(chat, chatOpts)
		},
		onSettled
	)
}

export function leaveChats(
	chats: readonly Chat[],
	opts?: BulkDeleteOrLeaveChatsOptions,
	onSettled?: BulkProgress
): Promise<BulkOutcome<Chat>> {
	return runBulkOutcomes<Chat>(
		chats,
		chat => {
			const chatOpts: LeaveOrDeleteChatOptions = { beforeCacheRemoval: () => opts?.beforeCacheRemoval?.(chat) }

			return leaveChat(chat, chatOpts)
		},
		onSettled
	)
}
