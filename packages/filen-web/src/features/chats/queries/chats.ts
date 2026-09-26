import { CancelledError, focusManager, useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { queryClient } from "@/queries/client"
import { patchQuery } from "@/queries/patch"
import type { Chat } from "@filen/sdk-rs"

// One global list query, mirroring mobile's useChatsQuery / this app's own notes/queries/notes.ts
// — exactly one conversation list per session, no per-filter key. listChats() has no pagination
// (chat counts are small) and is a full-list replace on every refetch.
export const CHATS_QUERY_KEY = ["chats", "list"] as const

// The latest list read that ran entirely under a live socket: its socket epoch and when it began. A
// socket patch can create the cache without one (chatsQueryUpdate's `prev ?? []`), and events missed
// while disconnected are only reconciled by the next read, so the cache counts as synced only while
// that socket session lasts.
let listRead: { epoch: number; at: number } | null = null

// Bumped by every patch that would cancel an in-flight list read (cancelInFlightIfCached).
let listFetchCancels = 0

export function markChatsListUnsynced(): void {
	listRead = null
}

function listSynced(): boolean {
	return listRead !== null && socketLiveSince(listRead.epoch)
}

// Another device's read state (lastFocus) and mute arrive on no socket event, so returning to the tab
// re-reads the mounted list, at most once per this window: a return sooner defers the read to when the
// latest one turns this old, so such a change shows at most this long after a return. The read goes
// through chatsQueryFetch, so a socket patch that cancels it makes it read again rather than dropping it.
export const CHATS_LIST_REREAD_MS = 30_000

let deferredReread: ReturnType<typeof setTimeout> | undefined

function rereadMountedList(): void {
	if (queryClient.getQueryCache().find({ queryKey: CHATS_QUERY_KEY, exact: true })?.isActive() === true) {
		// A failed read is already logged by the query cache.
		chatsQueryFetch().catch(() => undefined)
	}
}

focusManager.subscribe(focused => {
	clearTimeout(deferredReread)

	if (!focused) {
		return
	}

	const read = listRead
	const wait = read !== null && listSynced() ? read.at + CHATS_LIST_REREAD_MS - Date.now() : 0

	if (wait <= 0) {
		rereadMountedList()

		return
	}

	deferredReread = setTimeout(() => {
		// A read since (or a drop, which the reconnect resync answers) already covers this return.
		if (listRead === read) {
			rereadMountedList()
		}
	}, wait)
})

// Plain, testable query function — same rationale as fetchNotes: the hook wrapper below is a
// one-line pass-through no node-environment test can render, so this is exported and unit-tested
// against a mocked sdkApi instead.
export async function fetchChats(): Promise<Chat[]> {
	const epoch = currentSocketEpoch()
	const at = Date.now()
	const cancels = listFetchCancels
	const chats = await sdkApi.listChats()

	// A patch that landed meanwhile cancelled this read: query-core drops what it returns, so the list never
	// reaches the cache and the read can't count as its latest.
	if (listFetchCancels === cancels) {
		listRead = epoch !== null && socketLiveSince(epoch) ? { epoch, at } : null
	}

	return chats
}

// `enabled` lets a caller subscribe to the chat-list cache WITHOUT firing its own listChats (react-
// query still feeds the observer from cache writes while disabled) — the global unread-count hook reads
// the list this way, deriving off whatever the bulk refetch has populated instead of paying a second
// list fetch of its own. Defaults to true so the sidebar's own bare call is unaffected.
//
// No refetch on mount once the list is synced: socket events patch it live, so a remount would only
// re-read what is already here. A return to the tab re-reads it on the schedule above, reconnect
// always (staleTime 0), and an errored query still retries on mount.
export function useChats(options?: { enabled?: boolean }): UseQueryResult<Chat[]> {
	return useQuery({
		queryKey: CHATS_QUERY_KEY,
		queryFn: fetchChats,
		enabled: options?.enabled ?? true,
		refetchOnMount: query => query.state.status === "error" || !listSynced(),
		refetchOnWindowFocus: false
	})
}

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

// A cache miss (nobody has mounted the chats list yet) defaults to [] so the patch still lands for
// whenever it first mounts. A patch over cached data may cancel a list read (patchQuery), which must then
// not count as a synced read.
export function chatsQueryUpdate(updater: (prev: Chat[]) => Chat[]): void {
	if (queryClient.getQueryData(CHATS_QUERY_KEY) !== undefined) {
		listFetchCancels++
	}

	patchQuery<Chat[]>(CHATS_QUERY_KEY, prev => updater(prev ?? []))
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
