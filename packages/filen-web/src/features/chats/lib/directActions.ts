import type { Chat } from "@filen/sdk-rs"
import { runBulkActivity, runOutcomeActivity } from "@/lib/activity/activity"
import { markChatRead, setChatMuted } from "@/features/chats/lib/actions"
import { markChatsRead, setChatsMuted } from "@/features/chats/lib/bulk"
import { CHATS_MARK_READ, chatActivityName, chatsActivity, setMutedKeys } from "@/features/chats/lib/activity"

// The confirm-free chat actions as activities, one definition each for the conversation menu, the bulk bar and the
// keyboard.
export function runMarkChatRead(chat: Chat): void {
	void runOutcomeActivity(chat, { keys: CHATS_MARK_READ, name: chatActivityName, run: markChatRead })
}

export function runSetChatMuted(chat: Chat, mute: boolean): void {
	void runOutcomeActivity(chat, {
		keys: setMutedKeys(mute),
		name: chatActivityName,
		run: target => setChatMuted(target, mute)
	})
}

export function runMarkChatsRead(chats: Chat[]): void {
	void runBulkActivity(chatsActivity(chats, CHATS_MARK_READ, markChatsRead))
}

export function runSetChatsMuted(chats: Chat[], mute: boolean): void {
	void runBulkActivity(chatsActivity(chats, setMutedKeys(mute), (targets, onSettled) => setChatsMuted(targets, mute, onSettled)))
}
