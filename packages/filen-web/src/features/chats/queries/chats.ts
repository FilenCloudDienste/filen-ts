import { CancelledError, useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import type { Chat } from "@filen/sdk-rs"

// One global list query, mirroring mobile's useChatsQuery / this app's own notes/queries/notes.ts
// — exactly one conversation list per session, no per-filter key. listChats() has no pagination
// (chat counts are small) and is a full-list replace on every refetch.
export const CHATS_QUERY_KEY = ["chats", "list"] as const

// Whether the cache holds a server read taken since the socket last (re)connected. A socket patch can
// create the cache without one (chatsQueryUpdate's `prev ?? []`), and events missed while disconnected
// are only reconciled by the next read, so a mount trusts the cache only while this is set.
let listSynced = false

export function markChatsListUnsynced(): void {
	listSynced = false
}

// Plain, testable query function — same rationale as fetchNotes: the hook wrapper below is a
// one-line pass-through no node-environment test can render, so this is exported and unit-tested
// against a mocked sdkApi instead.
export async function fetchChats(): Promise<Chat[]> {
	const chats = await sdkApi.listChats()

	listSynced = true

	return chats
}

// `enabled` lets a caller subscribe to the chat-list cache WITHOUT firing its own listChats (react-
// query still feeds the observer from cache writes while disabled) — the global unread-count hook reads
// the list this way, deriving off whatever the bulk refetch has populated instead of paying a second
// list fetch of its own. Defaults to true so the sidebar's own bare call is unaffected.
//
// No refetch on mount once the list is synced: socket events patch it live, so a remount would only
// re-read what is already here. Focus and reconnect still refetch (staleTime 0), and an errored query
// still retries on mount.
export function useChats(options?: { enabled?: boolean }): UseQueryResult<Chat[]> {
	return useQuery({
		queryKey: CHATS_QUERY_KEY,
		queryFn: fetchChats,
		enabled: options?.enabled ?? true,
		refetchOnMount: query => query.state.status === "error" || !listSynced
	})
}

// Bumped by every patch that would cancel an in-flight list fetch (cancelInFlightIfCached).
let listFetchCancels = 0

function fetchChatsQuery(): Promise<Chat[]> {
	return queryClient.query({ queryKey: CHATS_QUERY_KEY, queryFn: fetchChats, staleTime: 0 })
}

// An authoritative list read that goes through the cache, so it joins a fetch a mounted useChats()
// already has in flight instead of issuing its own listChats, and lands in the cache on resolve. A
// patch landing mid-read cancels it, and a cancelled read settles with the patched cache (or rejects,
// when it joined another caller's fetch) rather than the server list, so it reads once more. That
// second read starts after the patch, so its result cannot overwrite it.
export async function chatsQueryFetch(): Promise<Chat[]> {
	const cancelsBefore = listFetchCancels

	try {
		const chats = await fetchChatsQuery()

		if (listFetchCancels === cancelsBefore) {
			return chats
		}
	} catch (e) {
		if (!(e instanceof CancelledError)) {
			throw e
		}
	}

	return fetchChatsQuery()
}

// Cancel-before-patch WITH the initial-fetch carve-out (notesQueryUpdate's own rule, queries/
// notes.ts): a refetch snapshotted on the server BEFORE this write would land after the patch and
// silently overwrite it — abort anything in flight first, but only when cached data already
// exists. Cancelling a query's INITIAL fetch would strand it on its loading state with nothing to
// show until the next mount/focus trigger, and the overwrite hazard only applies to data a patch
// can lose.
function cancelInFlightIfCached(): void {
	if (queryClient.getQueryData(CHATS_QUERY_KEY) !== undefined) {
		listFetchCancels++

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
// markRead all read back through this too), plus create's
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

// Synchronous cache read for a caller that needs the current chat list without subscribing via
// the hook — mirrors notesQueryGet's own rationale (a menu/action call site resolving a chat's
// live row, e.g. after a socket event, without mounting a new observer). Also the fallback
// resolver chatMessages.ts uses to turn a bare uuid back into the Chat object listMessagesBefore
// needs.
export function chatsQueryGet(): Chat[] | undefined {
	return queryClient.getQueryData<Chat[]>(CHATS_QUERY_KEY)
}
