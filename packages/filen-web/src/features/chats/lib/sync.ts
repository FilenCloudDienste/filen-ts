import { run, Semaphore } from "@filen/utils"
import { onlineManager } from "@tanstack/react-query"
import type { Chat, ChatMessagePartial } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { asErrorDTO } from "@/lib/sdk/errors"
import { kvGetJson, kvSetJson, kvDelete } from "@/lib/storage/adapter"
import { type OutboxChannelTransport } from "@/lib/storage/outboxChannel"
import { chatsQueryUpsert, chatsQueryGet, chatsQueryReplaceAll, fetchChats } from "@/features/chats/queries/chats"
import { chatMessagesQueryUpdate } from "@/features/chats/queries/chatMessages"
import useChatsInflightStore, { type ChatMessageWithInflightId, type InflightChatMessages } from "@/features/chats/store/useChatsInflight"
import {
	mergeChatInflight,
	reconcileChatFollower,
	buildOptimisticMessage,
	inflightChatMessagesSchema,
	isNetworkClassError,
	isRetryableAuthError,
	isNonSdkError,
	MAX_NON_RETRYABLE_REJECTIONS,
	type OptimisticSender,
	type RemoteChatEnqueue
} from "@/features/chats/lib/sync.logic"

// The multi-tab transport (leader-owned outbox): a follower forwards a send to the leader and asks it to
// flush; the leader broadcasts the authoritative per-chat queue + a hello on takeover. `E` is one forwarded
// send, `S` the whole queue. A single-tab install attaches NO transport, so every forward/broadcast is a
// guarded no-op and the leader path stays byte-identical to the pre-multi-tab outbox.
export type ChatOutboxTransport = OutboxChannelTransport<RemoteChatEnqueue, InflightChatMessages>

const OUTBOX_KV_KEY = "inflightChatMessages"

// Read the abort flag through a function boundary so an early guard does not narrow later reads to a
// literal `false` — the signal is aborted externally by cancel(), mid-pass; the later checks are
// load-bearing.
function isAborted(signal: AbortSignal): boolean {
	return signal.aborted
}

// A faithful port of filen-mobile's chats Sync class (features/chats/components/sync.tsx): the durable
// outbox that guarantees a chat message eventually reaches the server across a window close, a lost
// connection or a re-auth. Chat sends are APPEND-only and NOT idempotent (sendChatMessage takes no
// client id), so — unlike the notes outbox's overwrite-idempotent full-content push — fault tolerance
// rests on TEMPORAL commit-boundary discipline: sendChatMessage's resolution is the single commit
// point, and everything after it is best-effort/never-rethrow so the retry path never re-fires a
// committed send. The documented residual (same as mobile ships): a crash in the window between
// server-commit and outbox-dequeue replays as a duplicate on relaunch — rare, bounded, accepted; there
// is no server dedupe token in this SDK to close it.
//
// Leader-owned outbox across tabs: exactly one tab (the db-lock leader) runs the sequential push loop and
// owns all disk persistence. A `role` of "leader" is the DEFAULT and its every code path is unchanged from
// the single-tab outbox, so a lone tab (and the whole unit battery, which never attaches a transport) behaves
// byte-identically. A follower tab flips `role` to "follower": its send applies OPTIMISTICALLY to the local
// store AND forwards to the leader, its executeNow forwards a flush request, and it never touches disk or runs
// the loop (duplicate wire-sends are peer-visible — chat sends carry no client id — so only ONE loop may ever
// run). On leader death the db lock hands leadership to a follower, which calls promoteToLeader() and runs the
// SAME replay-on-launch machinery. The coordinator (outboxCoordinator.ts) wires the channel + db-lock signal.
export class Sync {
	// Serializes restore/flush/push so a reconcile write never races a push prune. mutex(1) === mobile.
	private readonly mutex: Semaphore = new Semaphore(1)
	private readonly initPromise: Promise<void>
	private resolveInit!: () => void
	// The outbox never cancels a push in flight (no AbortSignal on the wasm chat ops). This signal only
	// gates the LOOP: it stops new sends from starting and suppresses any post-abort disk write, so a
	// logout wipe is never resurrected by a late flush.
	private abortController: AbortController = new AbortController()
	// Multi-tab state. `role` defaults to "leader" so a lone tab and every unit test are the unchanged
	// single-tab path. `transport` is null until the coordinator wires a channel (single-tab: stays null,
	// every broadcast/forward is a no-op). `unacked` is FOLLOWER-only: the sends this tab has applied
	// optimistically + forwarded but the leader has not yet confirmed via a state broadcast — they win the
	// follower's union (so the optimistic bubble is never lost) and are re-sent on takeover.
	private role: "leader" | "follower" = "leader"
	private transport: ChatOutboxTransport | null = null
	private unacked: InflightChatMessages = {}

	public constructor() {
		this.initPromise = new Promise(resolve => {
			this.resolveInit = resolve
		})
	}

	// The coordinator reads this to route incoming channel messages by CURRENT role (role flips live on
	// promotion), so a single dispatcher stays correct across a takeover.
	public get outboxRole(): "leader" | "follower" {
		return this.role
	}

	// Wire the multi-tab transport (coordinator only). A single-tab install never calls this, leaving every
	// forward/broadcast a guarded no-op.
	public attachTransport(transport: ChatOutboxTransport): void {
		this.transport = transport
	}

	// Replay-on-launch. Mounted once in the authed shell (syncHost), never per route.
	public start(): void {
		void this.restoreFromDisk()
	}

	// Follower start: adopt the follower role and ask the leader for its current state so a chat another tab
	// already has pending renders its bubble here too. Never touches disk and never runs the loop.
	public startAsFollower(): void {
		this.role = "follower"
		this.transport?.requestState()
	}

	// Promotion (this follower just won the db lock after the leader died). Flip to leader, announce so any
	// OTHER followers re-send their unacked, then run the EXISTING replay-on-launch machinery: our optimistic
	// sends already live in the store, and restoreFromDisk merges them with whatever the dead leader persisted
	// (mergeChatInflight), prunes gone chats, and sends. restoreFromDisk only kicks a pass when DISK had
	// content, so force one when the store holds carried-over optimistic work the dead leader never persisted.
	//
	// Handoff window (documented, mobile-parity residual): the dead leader dequeues a committed send from the
	// in-memory store and THEN persists (sync() flushes after the pass). A crash BETWEEN server-commit and
	// that flush leaves the committed send still on disk → the promoted leader replays it → a duplicate. This
	// is the same server-commit↔dequeue race the single-tab outbox already documents; leadership handoff adds
	// no NEW double-send because only one loop ever runs — the promoted tab starts its loop only after the old
	// one is gone (the db lock is released on death), never concurrently.
	public promoteToLeader(): void {
		this.role = "leader"
		// Our optimistic sends are authoritative now (they live in the store); clear the follower ledger.
		this.unacked = {}
		this.transport?.broadcastLeaderHello()

		void run(async () => {
			await this.restoreFromDisk()

			if (Object.keys(useChatsInflightStore.getState().inflightMessages).length > 0) {
				this.syncNow()
			}

			this.broadcastState()
		})
	}

	// LEADER: ingest a send a follower forwarded. Union it into the queue by inflightId (idempotent — a
	// re-forward on takeover collapses), paint the leader's own message cache, persist and broadcast once
	// durable, then kick a pass — exactly the leader-side of a local send.
	public ingestRemoteEnqueue(msg: RemoteChatEnqueue): void {
		if (this.role !== "leader") {
			return
		}

		this.applyLeaderOptimistic(msg.chat, msg.message)

		void this.flushToDisk(useChatsInflightStore.getState().inflightMessages).then(() => {
			this.broadcastState()
		})

		this.syncNow()
	}

	// FOLLOWER: reconcile against the leader's authoritative queue broadcast. Drops unacked sends the leader
	// has confirmed (present by inflightId), keeps the ones it has not (they win the union), and replaces the
	// store with the reconciled view so a leader-side commit + drain clears this tab's pending bubble too.
	public applyLeaderState(state: InflightChatMessages): void {
		if (this.role !== "follower") {
			return
		}

		const reconciled = reconcileChatFollower(state, this.unacked)

		this.unacked = reconciled.unacked
		useChatsInflightStore.getState().setInflightMessages(() => reconciled.store)
	}

	// FOLLOWER: on a new leader announcing itself, re-forward every still-unacked send so a send that was in
	// flight to (or lost by) the dead leader reaches the new one. Idempotent by inflightId at the leader.
	public resendUnacked(): void {
		if (this.role !== "follower") {
			return
		}

		for (const group of Object.values(this.unacked)) {
			for (const message of group.messages) {
				this.transport?.sendEnqueue({ chat: group.chat, message })
			}
		}
	}

	// Broadcast the leader's current authoritative queue to followers (no-op unless leader with a transport).
	// Called after every durable state change and on a follower's state request.
	public broadcastState(): void {
		if (this.role !== "leader") {
			return
		}

		this.transport?.broadcastState(useChatsInflightStore.getState().inflightMessages)
	}

	// Paint the optimistic bubble into the leader's own message cache (belt-and-braces — composeMessageList
	// re-injects from the store) AND union it into the durable queue by inflightId. Shared by a local leader
	// send and a follower forward the leader ingests.
	private applyLeaderOptimistic(chat: Chat, message: ChatMessageWithInflightId): void {
		chatMessagesQueryUpdate(chat.uuid, prev => [...prev.filter(m => m.uuid !== message.uuid), message])

		useChatsInflightStore.getState().setInflightMessages(prev => ({
			...prev,
			[chat.uuid]: {
				chat,
				messages: [...(prev[chat.uuid]?.messages.filter(m => m.inflightId !== message.inflightId) ?? []), message]
			}
		}))
	}

	// The send intake, routed by role. A leader paints + persists + kicks the loop (returns the persist
	// result so the composer can surface a failed disk write); a follower applies optimistically to its own
	// store, tracks the send as unacked and forwards it to the leader (returns true — the optimistic apply
	// cannot fail locally, and durability is the leader's immediate-persist; a lost forward re-sends on the
	// next takeover). Mints the client-side inflightId (never wire-sent) and builds the optimistic message.
	public async enqueue({
		chat,
		content,
		replyTo,
		sender
	}: {
		chat: Chat
		content: string
		replyTo?: ChatMessagePartial
		sender: OptimisticSender
	}): Promise<boolean> {
		const inflightId = crypto.randomUUID()
		const optimistic = buildOptimisticMessage({
			chatUuid: chat.uuid,
			inflightId,
			content,
			replyTo,
			sentTimestamp: BigInt(Date.now()),
			sender
		})

		if (this.role === "follower") {
			return this.followerEnqueue(chat, optimistic)
		}

		this.applyLeaderOptimistic(chat, optimistic)

		// Persist FIRST (durability), then broadcast (no-op single-tab) and kick the push.
		const flushed = await this.flushToDisk(useChatsInflightStore.getState().inflightMessages)

		this.broadcastState()
		this.syncNow()

		return flushed
	}

	// FOLLOWER send: apply the optimistic bubble to THIS tab's store (composeMessageList re-injects it as a
	// pending bubble — no query-cache paint, the leader owns the commit swap + the realtime echo delivers the
	// committed copy), track it as unacked, and forward it to the leader. No disk write and no loop here.
	private followerEnqueue(chat: Chat, optimistic: ChatMessageWithInflightId): Promise<boolean> {
		useChatsInflightStore.getState().setInflightMessages(prev => ({
			...prev,
			[chat.uuid]: {
				chat,
				messages: [...(prev[chat.uuid]?.messages.filter(m => m.inflightId !== optimistic.inflightId) ?? []), optimistic]
			}
		}))

		this.unacked = mergeChatInflight(this.unacked, {
			[chat.uuid]: {
				chat,
				messages: [optimistic]
			}
		})

		this.transport?.sendEnqueue({ chat, message: optimistic })

		return Promise.resolve(true)
	}

	// Wired into the logout path BEFORE the local wipe: abort the loop and suppress further disk writes.
	// A fresh controller is installed so a later start() in the same tab is not permanently aborted.
	public cancel(): void {
		this.abortController.abort()
		this.abortController = new AbortController()
	}

	// Reports persistence failure as `false` instead of throwing (it never throws). Sync-internal
	// callers ignore the return (the next pass re-flushes); the enqueue call site surfaces a `false` —
	// a failed disk write means the message survives in memory only and would otherwise die with zero
	// signal.
	public async flushToDisk(inflightChatMessages: InflightChatMessages): Promise<boolean> {
		// The leader owns the disk. A follower NEVER persists (two tabs writing the one kv key is exactly the
		// clobber the leader/follower election exists to prevent) — and its initPromise never resolves
		// (restoreFromDisk is leader-only), so an
		// await here would hang. Report success so a follower-side purge/retry (in-memory only) still completes;
		// the leader's own copy of that event flushes the real disk state.
		if (this.role === "follower") {
			return true
		}

		await this.initPromise

		const result = await run(async () => {
			const filtered = Object.fromEntries(Object.entries(inflightChatMessages).filter(([, { messages }]) => messages.length > 0))

			if (Object.keys(filtered).length === 0) {
				await kvDelete(OUTBOX_KV_KEY)

				return
			}

			await kvSetJson(OUTBOX_KV_KEY, filtered)
		})

		if (!result.success) {
			log.error("chats-sync", "flushToDisk failed; queued message not persisted", result.error)
		}

		return result.success
	}

	// Replay-on-launch: the ONLY disk→store bridge, so it MUST hydrate the store even with no network.
	// (1) hydrate UNCONDITIONALLY via mergeChatInflight (union-by-inflightId) before any network call —
	// an offline boot must not strand persisted sends. (2) best-effort PRUNE of queued messages for
	// chats that no longer exist, reconciled against the freshly-fetched chats list — mobile's exact
	// restore reconcile (there is no content/time-window match; the temporal dedupe is the commit-
	// boundary discipline in sync(), not a restore-time comparison). A fetch failure keeps the unpruned
	// queue rather than dropping everything. Then kick sync() only when disk had content AND the store
	// still holds pending work.
	private async restoreFromDisk(): Promise<void> {
		const result = await run(async defer => {
			await this.mutex.acquire()

			defer(() => {
				this.mutex.release()
			})

			const fromDisk = await kvGetJson(OUTBOX_KV_KEY, inflightChatMessagesSchema)

			if (!fromDisk || Object.keys(fromDisk).length === 0) {
				return false
			}

			// Capture the live pre-merge state so the prune below can only ever drop chats seeded PURELY
			// from this disk snapshot — a chat the user messaged during restore must survive the prune.
			const liveBeforeMerge = useChatsInflightStore.getState().inflightMessages

			useChatsInflightStore.getState().setInflightMessages(prev => mergeChatInflight(prev, fromDisk))

			if (!onlineManager.isOnline()) {
				return true
			}

			const prune = await run(async () => {
				const chatsList = await fetchChats()
				const existingChatUuids = new Set<string>(chatsList.map(chat => chat.uuid))

				// Warm the list cache with LIVE chats so the push loop resolves a sendable chat WITHOUT a
				// per-pass network read — the send never uses the disk-restored snapshot (resolveSendableChat).
				chatsQueryReplaceAll(chatsList)

				useChatsInflightStore.getState().setInflightMessages(prev => {
					const updated: InflightChatMessages = {
						...prev
					}

					for (const chatUuid of Object.keys(fromDisk)) {
						if (existingChatUuids.has(chatUuid) || liveBeforeMerge[chatUuid]) {
							continue
						}

						Reflect.deleteProperty(updated, chatUuid)
					}

					return updated
				})
			})

			if (!prune.success) {
				log.error("chats-sync", "failed to prune restored inflight queue", prune.error)
			}

			return true
		})

		if (!result.success) {
			log.error("chats-sync", "restoreFromDisk failed; unsent messages from previous session may be lost", result.error)
		}

		this.resolveInit()

		// Publish the restored/reconciled queue so any follower already present reflects it (no-op single-tab).
		// A follower that joins later drives its own catch-up via requestState().
		this.broadcastState()

		// Kick sync() only when disk had content AND the store still holds pending work — driven by the
		// STORE (the source of truth for pending work, including anything merged/sent mid-restore),
		// never the raw disk snapshot. sync() itself gates on isOnline(), so calling it offline is a
		// safe no-op that leaves the queue for the reconnect trigger.
		if (result.data && Object.keys(useChatsInflightStore.getState().inflightMessages).length > 0) {
			void this.sync()
		}
	}

	// Resolve a LIVE, sendable Chat by uuid for the push loop. The durable queue's persisted `chat` is a
	// DISK-REVIVED plain object, NOT a live wasm-backed Chat handle: the web SDK surface (opaque wasm
	// handles) diverges from mobile's plain uniffi records, so feeding that revived object to the wasm
	// sendChatMessage never resolves — it wedges the loop after a replay-on-launch (mobile can send its
	// snapshot; web must not). So the send ALWAYS resolves a fresh chat here: the warm list cache first
	// (restore + the sidebar both seed it), a targeted getChat on a cache miss. The stored `chat` snapshot
	// survives in the queue only for the conversation-row preview, never to send.
	private async resolveSendableChat(chatUuid: string): Promise<Chat | undefined> {
		const cached = chatsQueryGet()?.find(chat => chat.uuid === chatUuid)

		if (cached) {
			return cached
		}

		return sdkApi.getChat(chatUuid)
	}

	// The single commit boundary. sendChatMessage's resolution IS the point after which the message is
	// irreversibly accepted server-side (carried back on the returned chat's lastMessage). Everything
	// after that resolution is best-effort and MUST NOT re-throw — otherwise the loop below would treat
	// a committed send as failed and retry it, creating a peer-visible duplicate (no client id means
	// each retry is a brand-new message). Throws ONLY when the send itself (the commit) fails.
	private async pushMessage(chat: Chat, message: ChatMessageWithInflightId): Promise<void> {
		const inflightId = message.inflightId
		// The commit. A throw here propagates to the loop's catch (a genuine send failure).
		const updatedChat = await sdkApi.sendChatMessage(chat, message.message ?? "", message.replyTo)

		// ── Past the commit boundary: never re-throw below this line. ──
		const lastMessage = updatedChat.lastMessage

		// Reconcile the query caches off the committed chat: refresh the conversation row (new
		// lastMessage/timestamp) and, in the message list, drop the optimistic in-flight copy (uuid ===
		// inflightId) plus any prior copy of the same server uuid, then append the committed message.
		chatsQueryUpsert(updatedChat)

		if (lastMessage) {
			chatMessagesQueryUpdate(chat.uuid, prev => [
				...prev.filter(m => m.uuid !== lastMessage.uuid && m.uuid !== inflightId),
				lastMessage
			])
		} else {
			// No committed message on the returned chat (unexpected SDK state) — still drop the
			// optimistic copy so the queue clears and the send is not retried.
			log.error("chats-sync", "sendMessage: no lastMessage on committed chat", chat.uuid, inflightId)
			chatMessagesQueryUpdate(chat.uuid, prev => prev.filter(m => m.uuid !== inflightId))
		}

		// Post-commit housekeeping is best-effort — a rejection here must NOT bubble.
		await Promise.allSettled([sdkApi.markChatRead(updatedChat), sdkApi.updateLastChatFocusTimesNow([updatedChat])])
	}

	private async sync(): Promise<void> {
		if (!onlineManager.isOnline()) {
			return
		}

		const signal = this.abortController.signal

		const result = await run(async defer => {
			await Promise.all([this.mutex.acquire(), this.initPromise])

			defer(() => {
				this.mutex.release()
			})

			const inflightMessages = useChatsInflightStore.getState().inflightMessages

			if (Object.keys(inflightMessages).length === 0) {
				return
			}

			const results = await Promise.allSettled(
				Object.entries(inflightMessages).map(async ([chatUuid, { messages }]) => {
					if (messages.length === 0) {
						return
					}

					// Resolve a LIVE chat for the send — NEVER the disk-restored snapshot (resolveSendableChat).
					const chat = await this.resolveSendableChat(chatUuid)

					if (isAborted(signal)) {
						return
					}

					if (!chat) {
						// Unresolvable right now (list not yet fetched / transient miss). Keep the queue for a
						// later trigger; a genuinely deleted chat is pruned at restore, never dropped here.
						return
					}

					// Sequential per chat, oldest-first — message ORDER is load-bearing for a chat.
					const sorted = [...messages].sort((a, b) =>
						a.sentTimestamp === b.sentTimestamp ? 0 : a.sentTimestamp < b.sentTimestamp ? -1 : 1
					)

					for (const message of sorted) {
						if (isAborted(signal)) {
							return
						}

						if (message.message === undefined) {
							continue
						}

						try {
							await this.pushMessage(chat, message)

							// Success: clear any error record for this send.
							useChatsInflightStore.getState().setInflightErrors(prev => {
								if (prev[message.inflightId] === undefined) {
									return prev
								}

								const updated = {
									...prev
								}

								Reflect.deleteProperty(updated, message.inflightId)

								return updated
							})
						} catch (e) {
							if (isAborted(signal)) {
								return
							}

							// Classify the rejection with the shared outbox classifiers. Network-class,
							// re-auth-recoverable Unauthenticated, and non-SDK errors are KEEP-for-retry
							// and never advance the drop bound. Any OTHER SDK error (incl. the `Server`
							// catch-all — the only permanent-rejection signal the SDK exposes) increments
							// the per-message consecutive-rejection counter.
							const isPermanentRejection = !isNonSdkError(e) && !isNetworkClassError(e) && !isRetryableAuthError(e)
							const previousRejections =
								useChatsInflightStore.getState().inflightErrors[message.inflightId]?.permanentRejections ?? 0
							const permanentRejections = isPermanentRejection ? previousRejections + 1 : previousRejections

							useChatsInflightStore.getState().setInflightErrors(prev => ({
								...prev,
								[message.inflightId]: {
									error: asErrorDTO(e),
									permanentRejections,
									message
								}
							}))

							if (permanentRejections >= MAX_NON_RETRYABLE_REJECTIONS) {
								// Drop the doomed message from the queue so it is never retried again. The
								// error record above STAYS (with the snapshot) so the failed bubble remains
								// visible and actionable (retry/remove) in the thread.
								log.error(
									"chats-sync",
									"dropping inflight message after max permanent rejections",
									chatUuid,
									message.inflightId,
									permanentRejections
								)
								this.dequeue(chatUuid, message.inflightId)

								continue
							}

							// Keep-for-retry (or transient below the bound): leave the entry queued. Stop
							// this chat's sequential pass so ordering is preserved — a later trigger retries.
							return
						}

						// Committed: remove from the queue (drop the chat key when empty).
						this.dequeue(chatUuid, message.inflightId)
					}
				})
			)

			for (const r of results) {
				if (r.status === "rejected") {
					log.error("chats-sync", "sync pass failed for a chat", String(r.reason))
				}
			}

			// Never flush after an aborted pass: logout aborts the loop and then wipes kv — a late flush
			// here would resurrect the previous account's plaintext queue onto disk after the wipe.
			if (!isAborted(signal)) {
				await this.flushToDisk(useChatsInflightStore.getState().inflightMessages)
				// Followers learn a send committed + drained (pending bubble clears) from this post-pass broadcast.
				this.broadcastState()
			}
		})

		if (!result.success) {
			if (isAborted(signal)) {
				return
			}

			log.error("chats-sync", "sync pass threw unexpectedly", result.error)
		}
	}

	// Remove one message from a chat's queue, dropping the chat key when its queue drains. No-op when
	// the entry is already gone (a concurrent remove/purge).
	private dequeue(chatUuid: string, inflightId: string): void {
		useChatsInflightStore.getState().setInflightMessages(prev => {
			const existing = prev[chatUuid]

			if (!existing) {
				return prev
			}

			const remaining = existing.messages.filter(m => m.inflightId !== inflightId)

			if (remaining.length === existing.messages.length) {
				return prev
			}

			const updated = {
				...prev
			}

			if (remaining.length === 0) {
				Reflect.deleteProperty(updated, chatUuid)
			} else {
				updated[chatUuid] = {
					...existing,
					messages: remaining
				}
			}

			return updated
		})
	}

	// Fire a sync pass now (visibilitychange, reconnect, boot replay). A follower owns no loop — forward the
	// flush request to the leader instead of running a pass here. Named to match the notes syncHost trigger
	// wiring; the leader delegates straight to the loop (chats has no debounce — mobile kicks a pass on every
	// enqueue + app-state change).
	public executeNow(): void {
		if (this.role === "follower") {
			this.transport?.sendExecuteNow()

			return
		}

		this.syncNow()
	}

	public syncNow(): void {
		this.sync().catch((e: unknown) => {
			log.error("chats-sync", "syncNow threw unexpectedly", e)
		})
	}
}

export const sync = new Sync()

// Optimistic enqueue — the survives-window-close intake, a port of mobile's input send() path, routed
// through the leader-owned outbox (sync.enqueue). On the leader it mints a client-side inflightId (never
// wire-sent), paints the optimistic bubble into the message cache AND appends it to the durable per-chat
// queue, persists the WHOLE outbox to disk IMMEDIATELY (before any send), then kicks a push pass; on a
// follower it applies optimistically to the store and forwards the send to the leader. Returns the persist
// result (leader) / true (follower) so the composer can surface a failed disk write. Both the composer and
// the e2e durability hook drive this.
export async function enqueueChatMessage(params: {
	chat: Chat
	content: string
	replyTo?: ChatMessagePartial
	sender: OptimisticSender
}): Promise<boolean> {
	return sync.enqueue(params)
}
