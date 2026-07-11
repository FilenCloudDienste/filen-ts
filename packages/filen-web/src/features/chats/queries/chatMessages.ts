import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { chatsQueryGet } from "@/features/chats/queries/chats"

// Per-chat message list, keyed on uuid so switching between two threads never shows a stale read
// while the new one is still in flight — same rationale as notes' noteContentQueryKey. The cache
// holds a FLAT ChatMessage[] (ascending sentTimestamp — oldest first, newest last, matching D3's
// non-inverted dense-row layout), NOT a useInfiniteQuery page list: `loadOlderChatMessages` below
// mutates this one cache slice in place (prepend + dedupe) rather than tracking pages, so there is
// exactly one query per chat regardless of how many older pages have been pulled in.
export function chatMessagesQueryKey(chatUuid: string) {
	return ["chats", "messages", { chatUuid }] as const
}

// The pagination CURSOR (`before: bigint`, a sentTimestamp — wasm-chats study §4) deliberately
// never enters the query key above: queries/client.ts's own convention forbids bigint in a query
// key (the default hasher is JSON.stringify-based and throws on it), and — independent of that —
// this design has no per-cursor cache entry to key by in the first place. `loadOlderChatMessages`
// takes `before` as a plain function argument and folds its result into the chat's single cache
// slice; the cursor for the NEXT older page is then the caller's own concern (the oldest message
// currently in the composed list), never something this module persists or re-derives.

const INITIAL_CURSOR_OFFSET_MS = 3_600_000 // mirrors mobile's `Date.now() + 1h` initial cursor

function sortAscending(messages: readonly ChatMessage[]): ChatMessage[] {
	return [...messages].sort((a, b) => (a.sentTimestamp === b.sentTimestamp ? 0 : a.sentTimestamp < b.sentTimestamp ? -1 : 1))
}

function resolveChat(chatUuid: string): Chat | undefined {
	return chatsQueryGet()?.find(c => c.uuid === chatUuid)
}

// Exported bare, same rationale as fetchNoteContent: node-environment tests exercise this against
// a mocked sdkApi without a React render. Resolves the Chat from the chats list cache (the only
// chat source this foundation wave has — a socket-delivered chat's cache seeding is a later
// wave's concern, same carve-out notes' own socket handlers document).
export async function fetchChatMessages(chatUuid: string): Promise<ChatMessage[]> {
	const chat = resolveChat(chatUuid)

	if (!chat) {
		// True miss: return whatever's already cached rather than [] so a remount/focus/reconnect
		// re-run does not clobber a previously loaded (or, in a later wave, optimistic/socket-
		// delivered) message list just because the chats list hasn't resolved this uuid yet.
		return chatMessagesQueryGet(chatUuid) ?? []
	}

	const messages = await sdkApi.listMessagesBefore(chat, BigInt(Date.now() + INITIAL_CURSOR_OFFSET_MS))

	return sortAscending(messages)
}

export function useChatMessages(chatUuid: string): UseQueryResult<ChatMessage[]> {
	return useQuery({
		queryKey: chatMessagesQueryKey(chatUuid),
		queryFn: () => fetchChatMessages(chatUuid),
		enabled: chatUuid.length > 0
	})
}

// Cancel-before-patch WITH the initial-fetch carve-out — identical rule to chatsQueryUpdate,
// scoped per chat uuid.
function cancelInFlightIfCached(chatUuid: string): void {
	if (queryClient.getQueryData(chatMessagesQueryKey(chatUuid)) !== undefined) {
		void queryClient.cancelQueries({ queryKey: chatMessagesQueryKey(chatUuid) })
	}
}

export function chatMessagesQueryUpdate(chatUuid: string, updater: (prev: ChatMessage[]) => ChatMessage[]): void {
	cancelInFlightIfCached(chatUuid)
	queryClient.setQueryData<ChatMessage[]>(chatMessagesQueryKey(chatUuid), prev => updater(prev ?? []))
}

// Replaces (or inserts, keeping ascending order) a single message by uuid — the shape a confirmed
// edit/delete-undo/socket-reconciled message needs once later waves wire those call sites.
export function chatMessagesQueryUpsert(chatUuid: string, message: ChatMessage): void {
	chatMessagesQueryUpdate(chatUuid, prev => {
		const index = prev.findIndex(m => m.uuid === message.uuid)

		if (index === -1) {
			return sortAscending([...prev, message])
		}

		const next = prev.slice()
		next[index] = message
		return next
	})
}

export function chatMessagesQueryRemove(chatUuid: string, messageUuid: string): void {
	chatMessagesQueryUpdate(chatUuid, prev => prev.filter(m => m.uuid !== messageUuid))
}

export function chatMessagesQueryGet(chatUuid: string): ChatMessage[] | undefined {
	return queryClient.getQueryData<ChatMessage[]>(chatMessagesQueryKey(chatUuid))
}

// Fetches one older page via listMessagesBefore(chat, before) and PREPENDS it into the chat's
// single cache slice, deduped by uuid against whatever's already cached (a concurrent socket
// delivery or — in a later wave — an optimistic send could already occupy the overlap window).
// Returns the raw page (not the merged cache) so a caller can inspect `page.length` to decide
// whether more history remains, mirroring mobile's own `hasMoreRef` signal.
export async function loadOlderChatMessages(chat: Chat, before: bigint): Promise<ChatMessage[]> {
	const page = await sdkApi.listMessagesBefore(chat, before)

	chatMessagesQueryUpdate(chat.uuid, prev => {
		const existingUuids = new Set(prev.map(m => m.uuid))
		const newMessages = page.filter(m => !existingUuids.has(m.uuid))

		return sortAscending([...newMessages, ...prev])
	})

	return page
}
