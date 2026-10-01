import type { Chat } from "@filen/sdk-rs"
import { i18n } from "@/lib/i18n"
import type { BulkOutcome, BulkProgress } from "@/lib/actions/bulk"
import { type ActivityKeys, activityKeys } from "@/lib/activity/activity.logic"
import type { BulkActivitySpec } from "@/lib/activity/activity"
import { accountQueryGet } from "@/queries/account"
import { chatTitle } from "@/features/chats/lib/sort"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"

// The chats' actions in the words their activity toasts use (locales/en/chats.ts, "Activity toasts").
export const CHATS_MARK_READ = activityKeys("chats:chatsMarkRead")

export const CHATS_MUTE = activityKeys("chats:chatsMute")

export const CHATS_UNMUTE = activityKeys("chats:chatsUnmute")

export const CHATS_DELETE = activityKeys("chats:chatsDelete")

export const CHATS_LEAVE = activityKeys("chats:chatsLeave")

export const CHAT_PARTICIPANTS_REMOVE = activityKeys("chats:chatParticipantsRemove")

// A conversation by the title its row shows.
export function chatActivityName(chat: Chat): string {
	return chatTitle(chat, accountQueryGet()?.id, i18n.t("chats:chatUndecryptable"), i18n.t("chats:chatJustYou"))
}

export function setMutedKeys(mute: boolean): ActivityKeys {
	return mute ? CHATS_MUTE : CHATS_UNMUTE
}

// A chats-list action over conversations as an activity, the succeeded ones dropped from the selection
// once it ends. A failed one stays selected so the user can retry without re-selecting.
export function chatsActivity(
	chats: readonly Chat[],
	keys: ActivityKeys,
	run: (chats: Chat[], onSettled: BulkProgress) => Promise<BulkOutcome<Chat>>
): BulkActivitySpec<Chat> {
	return {
		items: chats,
		keys,
		name: chatActivityName,
		run,
		onDone: outcome => {
			useChatsSelectionStore.getState().removeFromSelection(outcome.succeeded.map(chat => chat.uuid))
		}
	}
}
