import { type LucideIcon } from "lucide-react"
import { CHAT_ACTION_DEFS } from "@/features/chats/lib/actionDefs"
import { type ChatSelectionFlags } from "@/features/chats/lib/selectionFlags"
import { type ChatsKey } from "@/lib/i18n"

// Dialog kinds the chats bulk-action bar can ask useChatDialogHost to open — disjoint from
// ChatActionDialogKind (chatMenu.logic.ts) since neither of these ever carries a single Chat. Mirrors
// notes' NoteBulkDialogActionKind split.
export type ChatBulkDialogActionKind = "deleteSelected" | "leaveSelected"

interface ChatBulkActionDescriptorShared {
	id: "markRead" | "mute" | "delete" | "leave"
	labelKey: ChatsKey
	icon: LucideIcon
	destructive?: boolean
}

// "direct" resolves immediately (markRead/mute-toggle); "dialog" asks the host to open the given
// bulk-confirm kind — mirrors chatMenu.logic.ts's own ChatActionDescriptor union and notes'
// NoteBulkActionDescriptor, sized down (chats have no submenu-driven bulk action).
export type ChatBulkActionDescriptor =
	| (ChatBulkActionDescriptorShared & { run: "direct" })
	| (ChatBulkActionDescriptorShared & { run: "dialog"; dialogKind: ChatBulkDialogActionKind })

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
