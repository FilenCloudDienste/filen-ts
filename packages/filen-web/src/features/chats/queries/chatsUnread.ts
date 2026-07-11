import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"

// Global unread-message count across every conversation — the icon-rail Chats badge (in-app
// signals only, no favicon/title/OS notifications). `bigint` is fine in query DATA
// (queries/client.ts); there is no param here so no bigint-in-KEY question arises either.
//
// Per-row/per-chat unread state in the ChatsSidebar is NOT this — it is derived client-side from
// each chat's own lastMessage vs. lastFocus (mobile's chatSelectors.ts: isMessageUnread /
// chatHasUnread), never a per-chat SDK round trip (getChatUnreadCount is deliberately unwired —
// sdk.worker.ts's Chats section comment). That selector lives in the sidebar component itself; this
// query only owns the ONE global count getAllChatsUnreadCount actually returns.
export const CHATS_UNREAD_QUERY_KEY = ["chats", "unread"] as const

export async function fetchChatsUnread(): Promise<bigint> {
	return sdkApi.getAllChatsUnreadCount()
}

export function useChatsUnread(): UseQueryResult<bigint> {
	return useQuery({
		queryKey: CHATS_UNREAD_QUERY_KEY,
		queryFn: fetchChatsUnread
	})
}

// Confirm-then-patch write path (for nudging this count down after a local mark-read, without
// waiting for a full refetch — not yet wired to a caller). No cancel-before-patch guard here, unlike
// chatsQueryUpdate/chatMessagesQueryUpdate: this cache holds a single scalar with no per-item
// identity to clobber, so a stale in-flight refetch landing after this write simply overwrites it
// back to server truth — the same outcome a cancel would have produced, minus the extra call.
export function chatsUnreadQuerySet(count: bigint): void {
	queryClient.setQueryData<bigint>(CHATS_UNREAD_QUERY_KEY, count)
}

export function chatsUnreadQueryGet(): bigint | undefined {
	return queryClient.getQueryData<bigint>(CHATS_UNREAD_QUERY_KEY)
}
