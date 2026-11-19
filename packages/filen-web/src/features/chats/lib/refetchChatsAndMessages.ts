import { run, Semaphore } from "@filen/shared"
import type { Chat } from "@filen/sdk-rs"
import { chatsQueryFetch, chatsQueryGet } from "@/features/chats/queries/chats"
import { chatMessagesQueryGet, chatMessagesSynced, refreshNewestChatMessages } from "@/features/chats/queries/chatMessages"
import { chatUnreadProvablyZero } from "@/features/chats/lib/unread.logic"
import { getFocusedChat } from "@/features/chats/lib/focusedChat"

// Bulk authoritative resync: the chat list PLUS the message list of every chat that may hold unread
// messages, all in parallel. This is the one mechanism that makes a client-derived unread count possible
// — without those chats' messages resident in cache, the per-message unread predicate has nothing to
// scan. A chat whose list row already proves it read (chatUnreadProvablyZero) is not read: sumUnread
// counts it 0 without its messages, and its thread, left unsynced, reads them when opened. The full pass
// still reads the open thread's page whatever its row says: a mounted thread does not re-read on its
// own, so this pass is what brings in what it missed while the socket was down. It is also the
// self-heal for a flaky backend: a transient failure on the global-unread scalar (which this replaces)
// used to leave the rail badge wrong until the next reconnect; here the count re-derives from cache the
// moment any missing message list resolves, and this function refills those lists.
//
// Guarded by a Semaphore(1) so the callers that can fire close together — the count hook's mount-once
// trigger, its missing-messages self-heal effect, and the socket reconnect handler — collapse into one
// in-flight pass instead of stacking duplicate network fan-outs (a StrictMode double-invoke included).
const mutex = new Semaphore(1)

// Muted chats the last full pass did not read. A socket message can then create such a chat's cache with
// only that message, so once the chat is unmuted (by this client or another) a resident cache no longer
// means its unread backlog is resident.
const skippedMuted = new Set<string>()

// True for a chat skipped while muted that is now unmuted with a last message newer than lastFocus and a
// thread no read has synced since: its cache may miss unread messages, so the count treats it as missing.
export function chatBacklogUnread(chat: Chat): boolean {
	return skippedMuted.has(chat.uuid) && !chatUnreadProvablyZero(chat) && !chatMessagesSynced(chat.uuid)
}

// `onlyMissing` is the self-heal: no list read, just the chats whose message cache is still absent,
// decided after the mutex so a pass it queued behind has already filled what it could. The full pass
// writes the list before the messages land, which trips that self-heal every time; this is what makes
// the tripped heal cost nothing.
export async function refetchChatsAndMessages(options?: { onlyMissing?: boolean }): Promise<void> {
	await run(
		async defer => {
			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			const onlyMissing = options?.onlyMissing === true
			const listed = onlyMissing
				? (chatsQueryGet() ?? []).filter(chat => chatMessagesQueryGet(chat.uuid) === undefined || chatBacklogUnread(chat))
				: await chatsQueryFetch()
			// The open thread (MessageThread is its only enabled observer) is read on the full pass even when its row proves it read.
			const openThread = onlyMissing ? null : getFocusedChat()

			if (!onlyMissing) {
				skippedMuted.clear()
			}

			const chats = listed.filter(chat => {
				if (chat.uuid === openThread || !chatUnreadProvablyZero(chat)) {
					return true
				}

				if (!onlyMissing && chat.muted) {
					skippedMuted.add(chat.uuid)
				}

				return false
			})

			// Each per-chat fetch is independent; one failing must not abort the rest, so failures resolve
			// to an untouched cache rather than rejecting the whole pass.
			await Promise.all(
				chats.map(async chat => {
					try {
						await refreshNewestChatMessages(chat)

						skippedMuted.delete(chat.uuid)
					} catch {
						// A single flaky per-chat read leaves that chat's cache as-is; the next resync retries it.
					}
				})
			)
		},
		{ throw: false }
	)
}
