import { type } from "arktype"
import type { Chat, ChatMessage, ChatMessagePartial } from "@filen/sdk-rs"
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

// Functional, per-chat MERGE used to hydrate the disk-restored queue into the (possibly
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
// (oldest first) — the web's non-inverted dense-row order, the inverse of mobile's inverted-list
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

// arktype schema for the DURABLE outbox's read path (invalid/corrupt → dropped, the kv
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

// ── Multi-tab outbox (leader-owned) ─────────────────────────────────────────
//
// One tab (the db-lock leader) owns the sequential push loop + all disk persistence. Follower tabs forward
// each send to the leader over a dedicated BroadcastChannel and apply it OPTIMISTICALLY to their own store so
// the pending bubble paints without a round trip (composeMessageList re-injects the store queue on top of the
// confirmed message cache). The leader is authoritative: its state broadcast (the whole per-chat queue)
// reconciles followers by inflightId UNION — chat sends are append-only, so a union, never notes' newest-per-
// key overwrite. The follower's own realtime echo delivers the COMMITTED copy after the leader sends; a
// follower learns a send FAILURE only as leader-only detail (no error broadcast — same leader-owned rejection
// model as notes) — retry/remove stay leader-tab affordances.

// A single send a follower forwards to the leader: the FULLY-BUILT optimistic message (carrying its own
// inflightId, content, replyTo, sender snapshot + sentTimestamp) plus the live Chat it targets. The leader
// unions it into its queue AS-IS (idempotent by inflightId) and never rebuilds it — the send re-resolves a
// live sendable Chat regardless (sync.resolveSendableChat), so the forwarded snapshot only rides along for the
// queue key + row preview.
export interface RemoteChatEnqueue {
	chat: Chat
	message: ChatMessageWithInflightId
}

// Trust-boundary schema for a forwarded send (invalid → dropped, the channel's convention): the same
// load-bearing scalars the durable queue validates, `chat` as a non-null object only.
export const remoteChatEnqueueSchema = type({
	chat: "object",
	message: {
		inflightId: "string",
		uuid: "string",
		chat: "string",
		sentTimestamp: "bigint"
	}
}).as<RemoteChatEnqueue>()

// A bounded ledger of recently-committed inflightIds. On a leadership takeover the new leader clears its
// unacked and announces itself; a surviving follower then re-forwards its own unacked, which can carry an id
// the promoted leader has ALREADY committed + dequeued. That id is no longer in the queue, so the union-by-id
// collapse in ingestRemoteEnqueue finds nothing to fold into — without this ledger the re-forward would be
// applied as a brand-new send and pushed a SECOND time (chat sends carry no client id, so a duplicate is
// peer-visible). The leader records every committed id here and drops a re-forward whose id is present.
// Bounded by design: insertion-ordered with FIFO eviction past `capacity`, so a long-lived leader session can
// never grow it without limit — the window only needs to outlast a takeover-resend round trip.
export class CommittedIdLedger {
	private readonly ids: Set<string> = new Set<string>()
	private readonly capacity: number

	public constructor(capacity = 512) {
		this.capacity = Math.max(1, capacity)
	}

	public record(inflightId: string): void {
		// Re-record moves an id to the most-recent slot so a repeatedly-seen id is not evicted prematurely.
		if (this.ids.has(inflightId)) {
			this.ids.delete(inflightId)
		}

		this.ids.add(inflightId)

		while (this.ids.size > this.capacity) {
			const oldest = this.ids.values().next().value

			if (oldest === undefined) {
				break
			}

			this.ids.delete(oldest)
		}
	}

	public has(inflightId: string): boolean {
		return this.ids.has(inflightId)
	}

	public get size(): number {
		return this.ids.size
	}
}

// Rebuild a follower's displayed store + its still-outstanding unacked queue from the leader's authoritative
// broadcast. A forwarded send is CONFIRMED (dropped from unacked) once the leader's state carries its
// inflightId — proof the leader received it; the store then mirrors the leader for that chat, so a later drain
// (leader commits + omits it) makes the pending bubble disappear (the follower's realtime echo has by then
// delivered the committed copy). A send the leader has NOT caught up to (its inflightId absent — an in-flight
// or lost forward) keeps its unacked entry, which wins the union so the optimistic bubble is never dropped
// before the leader has it. Pure: the caller owns the unacked ref and the store write.
export function reconcileChatFollower(
	leaderState: InflightChatMessages,
	unacked: InflightChatMessages
): { store: InflightChatMessages; unacked: InflightChatMessages } {
	const remaining: InflightChatMessages = {}

	for (const chatUuid of Object.keys(unacked)) {
		const localGroup = unacked[chatUuid]

		if (!localGroup) {
			continue
		}

		const leaderIds = new Set((leaderState[chatUuid]?.messages ?? []).map(message => message.inflightId))
		const stillUnacked = localGroup.messages.filter(message => !leaderIds.has(message.inflightId))

		if (stillUnacked.length === 0) {
			continue
		}

		remaining[chatUuid] = {
			...localGroup,
			messages: stillUnacked
		}
	}

	return {
		store: mergeChatInflight(leaderState, remaining),
		unacked: remaining
	}
}
