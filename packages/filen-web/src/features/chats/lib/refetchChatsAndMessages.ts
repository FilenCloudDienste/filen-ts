import { run, Semaphore } from "@filen/shared"
import { chatsQueryFetch, chatsQueryGet } from "@/features/chats/queries/chats"
import { fetchMessagesForChat, chatMessagesQueryGet, chatMessagesQueryUpdate, mergeNewestPage } from "@/features/chats/queries/chatMessages"

// Bulk authoritative resync: the chat list PLUS every chat's message list, all in parallel. This is the
// one mechanism that makes a client-derived unread count possible — without every chat's messages
// resident in cache, the per-message unread predicate has nothing to scan. It is also the self-heal for
// a flaky backend: a transient failure on the global-unread scalar (which this replaces) used to leave
// the rail badge wrong until the next reconnect; here the count re-derives from cache the moment any
// missing message list resolves, and this function refills those lists.
//
// Guarded by a Semaphore(1) so the callers that can fire close together — the count hook's mount-once
// trigger, its missing-messages self-heal effect, and the socket reconnect handler — collapse into one
// in-flight pass instead of stacking duplicate network fan-outs (a StrictMode double-invoke included).
const mutex = new Semaphore(1)

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

			const chats = options?.onlyMissing
				? (chatsQueryGet() ?? []).filter(chat => chatMessagesQueryGet(chat.uuid) === undefined)
				: await chatsQueryFetch()

			// Each per-chat fetch is independent; one failing must not abort the rest, so failures resolve
			// to an untouched cache rather than rejecting the whole pass.
			await Promise.all(
				chats.map(async chat => {
					try {
						const messages = await fetchMessagesForChat(chat)

						// Merge, never replace: this pulls only the newest page, and the open thread may have
						// older pages scrolled in (mergeNewestPage).
						chatMessagesQueryUpdate(chat.uuid, prev => mergeNewestPage(prev, messages))
					} catch {
						// A single flaky per-chat read leaves that chat's cache as-is; the next resync retries it.
					}
				})
			)
		},
		{ throw: false }
	)
}
