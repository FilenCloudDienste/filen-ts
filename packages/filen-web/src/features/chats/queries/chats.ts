import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import type { Chat } from "@filen/sdk-rs"

// One global list query, mirroring mobile's useChatsQuery / this app's own notes/queries/notes.ts
// — exactly one conversation list per session, no per-filter key. listChats() has no pagination
// (chat counts are small; wasm-chats study §1a) and is a full-list replace on every refetch.
export const CHATS_QUERY_KEY = ["chats", "list"] as const

// Plain, testable query function — same rationale as fetchNotes: the hook wrapper below is a
// one-line pass-through no node-environment test can render, so this is exported and unit-tested
// against a mocked sdkApi instead.
export async function fetchChats(): Promise<Chat[]> {
	return sdkApi.listChats()
}

export function useChats(): UseQueryResult<Chat[]> {
	return useQuery({
		queryKey: CHATS_QUERY_KEY,
		queryFn: fetchChats
	})
}

// Cancel-before-patch WITH the initial-fetch carve-out (notesQueryUpdate's own rule, queries/
// notes.ts): a refetch snapshotted on the server BEFORE this write would land after the patch and
// silently overwrite it — abort anything in flight first, but only when cached data already
// exists. Cancelling a query's INITIAL fetch would strand it on its loading state with nothing to
// show until the next mount/focus trigger, and the overwrite hazard only applies to data a patch
// can lose.
function cancelInFlightIfCached(): void {
	if (queryClient.getQueryData(CHATS_QUERY_KEY) !== undefined) {
		void queryClient.cancelQueries({ queryKey: CHATS_QUERY_KEY })
	}
}

// Confirm-then-patch (queries/client.ts's zero-useMutation convention). A cache miss (nobody has
// mounted the chats list yet) defaults to [] so the patch still lands for whenever it first
// mounts.
export function chatsQueryUpdate(updater: (prev: Chat[]) => Chat[]): void {
	cancelInFlightIfCached()
	queryClient.setQueryData<Chat[]>(CHATS_QUERY_KEY, prev => updater(prev ?? []))
}

// Replaces (or inserts) a single chat by uuid, preserving every other row's position — the
// common shape for an action that returns the one Chat it touched (rename/mute/addParticipant/
// removeParticipant/markRead reads back through this too, once C2 wires actions), plus create's
// append case.
export function chatsQueryUpsert(chat: Chat): void {
	chatsQueryUpdate(prev => {
		const index = prev.findIndex(c => c.uuid === chat.uuid)

		if (index === -1) {
			return [...prev, chat]
		}

		const next = prev.slice()
		next[index] = chat
		return next
	})
}

export function chatsQueryRemove(uuid: string): void {
	chatsQueryUpdate(prev => prev.filter(c => c.uuid !== uuid))
}

export function chatsQueryReplaceAll(chats: Chat[]): void {
	chatsQueryUpdate(() => chats)
}

// Synchronous cache read for a caller that needs the current chat list without subscribing via
// the hook — mirrors notesQueryGet's own rationale (a menu/action call site resolving a chat's
// live row, e.g. after a socket event, without mounting a new observer). Also the fallback
// resolver chatMessages.ts uses to turn a bare uuid back into the Chat object listMessagesBefore
// needs.
export function chatsQueryGet(): Chat[] | undefined {
	return queryClient.getQueryData<Chat[]>(CHATS_QUERY_KEY)
}
