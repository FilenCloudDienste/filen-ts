import { type } from "arktype"
import type { ChatMessage, ChatMessagePartial } from "@filen/sdk-rs"
import type { ChatMessageWithInflightId, InflightChatMessages } from "@/features/chats/store/useChatsInflight"

// Pure, testable core of the chat send outbox — a faithful port of filen-mobile's chats sync/store
// helpers (features/chats/components/sync.tsx mergeInflight + features/chats/utils.ts
// composeMessageList). No store/IO/React access here.

// The retry classifiers + drop bound live in the shared @/lib/sdk/retry module (notes' outbox uses the
// same). Re-exported so lib/sync.ts and the tests import the whole outbox surface from one place, the
// way the notes sync.logic re-exports its own.
export { isNetworkClassError, isRetryableAuthError, isNonSdkError, MAX_NON_RETRYABLE_REJECTIONS } from "@/lib/sdk/retry"

// Minimal current-user shape the optimistic-message builder needs — a structural subset of UserInfo so
// a test can construct it without the whole account record.
export interface OptimisticSender {
	id: bigint
	email: string
	avatarUrl: string | undefined
	nickName: string | undefined
}

// Build the optimistic ChatMessage an enqueue paints immediately. Its `uuid` is SET to the inflightId
// (mobile parity: inner.uuid = inflightId) so the message-cache dedup handle exists before the server
// assigns a real uuid on commit. senderId is `number` on the wasm surface (a codegen quirk — every
// other user-id is bigint), so the bigint account id is narrowed with Number() to match the field type,
// exactly the inverse of the BigInt() coercion the self-detection reads apply.
export function buildOptimisticMessage({
	chatUuid,
	inflightId,
	content,
	replyTo,
	sentTimestamp,
	sender
}: {
	// uuid-shaped fields are the SDK's branded UuidStr, not a plain string.
	chatUuid: ChatMessage["chat"]
	inflightId: ChatMessage["uuid"]
	content: string
	replyTo: ChatMessagePartial | undefined
	sentTimestamp: bigint
	sender: OptimisticSender
}): ChatMessageWithInflightId {
	// exactOptionalPropertyTypes: an absent avatar/replyTo must OMIT the key, never set it to undefined.
	const base = {
		inflightId,
		uuid: inflightId,
		chat: chatUuid,
		senderId: Number(sender.id),
		senderEmail: sender.email,
		senderNickName: sender.nickName,
		message: content,
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp
	} satisfies Omit<ChatMessageWithInflightId, "senderAvatar" | "replyTo">

	return {
		...base,
		...(sender.avatarUrl !== undefined ? { senderAvatar: sender.avatarUrl } : {}),
		...(replyTo !== undefined ? { replyTo } : {})
	}
}

// D1 fix: functional, per-chat MERGE used to hydrate the disk-restored queue into the (possibly
// already-populated) store without clobbering a message the user sent DURING the seconds-long restore
// window (enqueue writes the store/disk outside the sync mutex). Disk seeds chats the store doesn't
// have yet; for chats present on both sides the message lists are UNIONED by inflightId with LIVE
// entries winning (anything already in the live store is newer than any disk snapshot of the same id).
// This is the load-bearing divergence from notes' mergeInflight (which keeps newest-per-uuid,
// last-write-wins) — chat sends are append-only, so a union, never an overwrite. Pure.
export function mergeChatInflight(current: InflightChatMessages, fromDisk: InflightChatMessages): InflightChatMessages {
	const merged: InflightChatMessages = {
		...current
	}

	for (const chatUuid of Object.keys(fromDisk)) {
		const diskEntry = fromDisk[chatUuid]

		if (!diskEntry) {
			continue
		}

		const currentEntry = merged[chatUuid]

		if (!currentEntry || currentEntry.messages.length === 0) {
			merged[chatUuid] = diskEntry

			continue
		}

		const liveInflightIds = new Set(currentEntry.messages.map(message => message.inflightId))
		const missingFromLive = diskEntry.messages.filter(message => !liveInflightIds.has(message.inflightId))

		if (missingFromLive.length === 0) {
			continue
		}

		merged[chatUuid] = {
			...currentEntry,
			messages: [...currentEntry.messages, ...missingFromLive]
		}
	}

	return merged
}

// Port of mobile's composeMessageList: the thread's render source, merging the confirmed message-query
// cache with the still-pending + failed optimistic entries so those bubbles SURVIVE a query refetch
// (the server doesn't know a pending send yet, so a refetch would otherwise drop it). Dedup is first-
// wins by server uuid, then by inflightId: a query message already carrying an optimistic entry (its
// uuid === the inflightId) suppresses re-adding that store entry. Confirmed messages have a real server
// uuid that never equals an inflightId, so they never collide. Returned ASCENDING by sentTimestamp
// (oldest first) — the web's non-inverted D3 dense-row order, the inverse of mobile's inverted-list
// DESC — so pending/failed entries (newest) naturally land AFTER confirmed ones.
export function composeMessageList({
	queryMessages,
	inflightMessages,
	failedMessages
}: {
	queryMessages: readonly ChatMessage[]
	inflightMessages: readonly ChatMessageWithInflightId[]
	failedMessages: readonly ChatMessageWithInflightId[]
}): ChatMessage[] {
	const byUuid = new Map<string, ChatMessage>()

	for (const message of queryMessages) {
		byUuid.set(message.uuid, message)
	}

	for (const message of [...inflightMessages, ...failedMessages]) {
		// The optimistic copy's uuid IS its inflightId, so a single uuid check catches both "already in
		// the query cache" and "same inflight entry seen twice (queued + failed)".
		if (byUuid.has(message.uuid)) {
			continue
		}

		byUuid.set(message.uuid, message)
	}

	return [...byUuid.values()].sort((a, b) => (a.sentTimestamp === b.sentTimestamp ? 0 : a.sentTimestamp < b.sentTimestamp ? -1 : 1))
}

// Adaptation A: arktype schema for the DURABLE outbox's read path (invalid/corrupt → dropped, the kv
// adapter's convention). Validates only the load-bearing scalars per entry — arktype objects allow
// undeclared keys, so the rest of the ChatMessage snapshot (and the Chat snapshot) round-trips through
// the $bigint envelope untouched; over-constraining it would drop otherwise-valid entries the moment
// the SDK adds a field (the notes schema's own lesson). `.as<InflightChatMessages>()` carries the
// trusted-boundary cast without loosening the runtime structural check.
const inflightChatMessageEntrySchema = type({
	inflightId: "string",
	uuid: "string",
	chat: "string",
	sentTimestamp: "bigint"
})

const inflightChatGroupSchema = type({
	chat: "object",
	messages: inflightChatMessageEntrySchema.array()
})

export const inflightChatMessagesSchema = type({
	"[string]": inflightChatGroupSchema
}).as<InflightChatMessages>()
