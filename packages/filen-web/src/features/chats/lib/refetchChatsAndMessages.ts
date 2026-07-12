import { run, Semaphore } from "@filen/utils"
import { fetchChats, chatsQueryReplaceAll } from "@/features/chats/queries/chats"
import { fetchMessagesForChat, chatMessagesQueryUpdate } from "@/features/chats/queries/chatMessages"

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

export async function refetchChatsAndMessages(): Promise<void> {
	await run(
		async defer => {
			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			const chats = await fetchChats()

			if (chats.length === 0) {
				// Still publish the (empty) list so an account that had chats removed reflects it; nothing
				// to fan out over.
				chatsQueryReplaceAll(chats)

				return
			}

			// Messages first, then the list — the derived count reads both caches, and a chat row landing
			// before its messages would briefly count as "missing" and retrigger the self-heal. Each
			// per-chat fetch is independent; one failing must not abort the rest, so failures resolve to an
			// untouched cache rather than rejecting the whole pass.
			await Promise.all(
				chats.map(async chat => {
					try {
						const messages = await fetchMessagesForChat(chat)

						chatMessagesQueryUpdate(chat.uuid, () => messages)
					} catch {
						// A single flaky per-chat read leaves that chat's cache as-is; the next resync retries it.
					}
				})
			)

			chatsQueryReplaceAll(chats)
		},
		{ throw: false }
	)
}
