import { run, Semaphore } from "@filen/utils"
import { onlineManager } from "@tanstack/react-query"
import type { Chat, ChatMessagePartial } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { asErrorDTO } from "@/lib/sdk/errors"
import { kvGetJson, kvSetJson, kvDelete } from "@/lib/storage/adapter"
import { chatsQueryUpsert, fetchChats } from "@/features/chats/queries/chats"
import { chatMessagesQueryUpdate } from "@/features/chats/queries/chatMessages"
import useChatsInflightStore, { type ChatMessageWithInflightId, type InflightChatMessages } from "@/features/chats/store/useChatsInflight"
import {
	mergeChatInflight,
	buildOptimisticMessage,
	inflightChatMessagesSchema,
	isNetworkClassError,
	isRetryableAuthError,
	isNonSdkError,
	MAX_NON_RETRYABLE_REJECTIONS,
	type OptimisticSender
} from "@/features/chats/lib/sync.logic"

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
// SINGLE-TAB scope (this wave): every authed tab runs its own loop. The multi-tab leader (one
// authoritative loop + follower forward-to-leader) is a later wave — the seam to move behind it is the
// sync() loop below, mirroring how notes' outbox was leader-gated after shipping single-tab.
export class Sync {
	// Serializes restore/flush/push so a reconcile write never races a push prune. mutex(1) === mobile.
	private readonly mutex: Semaphore = new Semaphore(1)
	private readonly initPromise: Promise<void>
	private resolveInit!: () => void
	// The outbox never cancels a push in flight (no AbortSignal on the wasm chat ops). This signal only
	// gates the LOOP: it stops new sends from starting and suppresses any post-abort disk write, so a
	// logout wipe is never resurrected by a late flush.
	private abortController: AbortController = new AbortController()

	public constructor() {
		this.initPromise = new Promise(resolve => {
			this.resolveInit = resolve
		})
	}

	// Replay-on-launch. Mounted once in the authed shell (syncHost), never per route.
	public start(): void {
		void this.restoreFromDisk()
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

		// Kick sync() only when disk had content AND the store still holds pending work — driven by the
		// STORE (the source of truth for pending work, including anything merged/sent mid-restore),
		// never the raw disk snapshot. sync() itself gates on isOnline(), so calling it offline is a
		// safe no-op that leaves the queue for the reconnect trigger.
		if (result.data && Object.keys(useChatsInflightStore.getState().inflightMessages).length > 0) {
			void this.sync()
		}
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
				Object.entries(inflightMessages).map(async ([chatUuid, { chat, messages }]) => {
					if (messages.length === 0) {
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

	// Fire a sync pass now (enqueue, visibilitychange → hidden, reconnect, boot replay). Named to match
	// the notes syncHost trigger wiring; delegates straight to the loop (chats has no debounce — mobile
	// kicks a pass on every enqueue + app-state change).
	public executeNow(): void {
		this.syncNow()
	}

	public syncNow(): void {
		this.sync().catch((e: unknown) => {
			log.error("chats-sync", "syncNow threw unexpectedly", e)
		})
	}
}

export const sync = new Sync()

// Optimistic enqueue — the survives-window-close intake, a port of mobile's input send() path. Mints a
// client-side inflightId (never wire-sent), paints the optimistic bubble into the message cache AND
// appends it to the durable per-chat queue, persists the WHOLE outbox to disk IMMEDIATELY (before any
// send), then kicks a push pass. Returns the persist result so a caller (the composer) can surface a
// failed disk write (a message that survives in memory only). Ownership of the composer UI is a later
// wave; this is the transport-level intake C4's composer and the e2e durability hook both drive.
export async function enqueueChatMessage({
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

	// Paint the bubble immediately (the query cache is the thread's confirmed-message source; the
	// composed list re-injects this from the store after a refetch — sync.logic.composeMessageList).
	chatMessagesQueryUpdate(chat.uuid, prev => [...prev.filter(m => m.uuid !== inflightId), optimistic])

	// Append to the durable queue.
	useChatsInflightStore.getState().setInflightMessages(prev => ({
		...prev,
		[chat.uuid]: {
			chat,
			messages: [...(prev[chat.uuid]?.messages ?? []), optimistic]
		}
	}))

	// Persist FIRST (durability), then kick the push.
	const flushed = await sync.flushToDisk(useChatsInflightStore.getState().inflightMessages)

	sync.syncNow()

	return flushed
}
