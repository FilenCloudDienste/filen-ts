import { CHAT_ACTION_DEFS } from "@/features/chats/lib/actionDefs"
import { type ChatSelectionFlags } from "@/features/chats/lib/selectionFlags"
import { type ActionDescriptor } from "@/lib/actionDescriptor"
import { type ChatsKey } from "@/lib/i18n"

// Dialog kinds the chats bulk-action bar can ask useChatDialogHost to open — disjoint from
// ChatActionDialogKind (chatMenu.logic.ts) since neither of these ever carries a single Chat. Mirrors
// notes' NoteBulkDialogActionKind split.
export type ChatBulkDialogActionKind = "deleteSelected" | "leaveSelected"

export type ChatBulkActionDescriptor = ActionDescriptor<ChatsKey, "markRead" | "mute" | "delete" | "leave", ChatBulkDialogActionKind>

// Pure gating builder for the chats bulk-action bar — mirrors notesBulkActionBar.logic.ts's
// noteBulkActions (flag-gated descriptor list, testable without rendering anything). Reuses the exact
// same label/icon facts (CHAT_ACTION_DEFS) chatMenu.logic.ts's own per-chat menu builds from, so a
// single-chat action and its bulk counterpart can never drift apart in wording or iconography.
export function chatBulkActions(flags: ChatSelectionFlags): ChatBulkActionDescriptor[] {
	const descriptors: ChatBulkActionDescriptor[] = []

	// markRead/mute both need decrypted chat state — suppressed whole-selection-wide once any selected
	// chat is undecryptable, mirroring chatMenuActions' own per-chat undecryptable branch (which drops
	// everything except Delete/Leave).
	if (!flags.includesUndecryptable) {
		if (flags.includesUnread) {
			descriptors.push({ id: "markRead", ...CHAT_ACTION_DEFS.markRead, run: "direct" })
		}

		// SET semantics, like notes' bulk pin/favorite: the label/icon reflect the value this bar will
		// apply to the WHOLE selection, not any single chat's own current flag.
		descriptors.push({
			id: "mute",
			...(flags.includesMuted ? CHAT_ACTION_DEFS.unmute : CHAT_ACTION_DEFS.mute),
			run: "direct"
		})
	}

	// Delete (owner) / Leave (non-owner) survive includesUndecryptable — pure-uuid dispositions, same as
	// chatMenuActions' own undecryptable branch which offers exactly one of these two.
	if (flags.everyOwned) {
		descriptors.push({ id: "delete", ...CHAT_ACTION_DEFS.delete, run: "dialog", dialogKind: "deleteSelected" })
	}

	if (flags.noneOwned) {
		descriptors.push({ id: "leave", ...CHAT_ACTION_DEFS.leave, run: "dialog", dialogKind: "leaveSelected" })
	}

	return descriptors
}

// Mirrors the per-chat menu's offline gate (chatMenu.logic.ts's OFFLINE_GATED_IDS): mute/delete/leave
// write to the SDK and can only fail offline; markRead stays ungated, as it does per chat.
const OFFLINE_GATED_BULK_IDS: ReadonlySet<ChatBulkActionDescriptor["id"]> = new Set(["mute", "delete", "leave"])

export function isChatBulkActionOfflineDisabled(id: ChatBulkActionDescriptor["id"], isOnline: boolean): boolean {
	return !isOnline && OFFLINE_GATED_BULK_IDS.has(id)
}
