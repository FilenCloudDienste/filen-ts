import { useEffect } from "react"
import { run, mergeInflightQueuesByUnion, MAX_NON_RETRYABLE_REJECTIONS } from "@filen/shared"
import chats from "@/features/chats/chats"
import { AppState } from "react-native"
import useChatsStore, { type InflightChatMessages } from "@/features/chats/store/useChats.store"
import sqlite from "@/lib/sqlite"
import { chatsQueryFetch } from "@/features/chats/queries/useChats.query"
import { unwrapSdkError, isPermanentSdkRejection } from "@/lib/sdkErrors"
import logger from "@/lib/logger"
import { OutboxSync } from "@/lib/outboxSync"

export class Sync extends OutboxSync<InflightChatMessages> {
	public constructor() {
		super({
			sqliteKvKey: "inflightChatMessages",
			logScope: "chats-sync"
		})
	}

	protected override async restoreFromDisk(): Promise<void> {
		const result = await run(() =>
			this.mutex.withPermit(async () => {
				const fromDisk = await sqlite.kvAsync.get<InflightChatMessages>(this.sqliteKvKey)

				if (!fromDisk || Object.keys(fromDisk).length === 0) {
					return false
				}

				// D1: capture the live pre-merge state so the best-effort prune below can only ever
				// drop chats that were seeded purely from THIS disk snapshot — a chat the user
				// created/messaged during restore must survive the prune.
				const liveBeforeMerge = useChatsStore.getState().inflightMessages

				// Hydrate the store FIRST, before any network call, via a functional MERGE (M4: a new
				// object every update so zustand notifies subscribers; never mutate the disk snapshot
				// or the live state in place). This must work offline: the persisted queue has to
				// become visible and deliverable for the session even when the chats-list fetch below
				// throws (offline launch). Pruning is a best-effort refinement layered on top, never a
				// gate on hydration.
				useChatsStore.getState().setInflightMessages(prev => mergeInflightQueuesByUnion(prev, fromDisk))

				// Best-effort prune of messages for chats that no longer exist. On a fetch failure
				// (e.g. offline) keep the unpruned queue rather than dropping everything. The prune
				// only applies to keys present in the disk snapshot AND absent from the live pre-merge
				// state: a chat that gained live messages before/during the restore is never pruned
				// here (chat removal is handled by purgeChatInflightState on the removal paths).
				try {
					const chatsList = await chatsQueryFetch()
					const existingChatUuids = new Set(chatsList.map(chat => chat.uuid))

					useChatsStore.getState().setInflightMessages(prev => {
						const updated = {
							...prev
						}

						for (const chatUuid of Object.keys(fromDisk)) {
							if (existingChatUuids.has(chatUuid) || liveBeforeMerge[chatUuid]) {
								continue
							}

							delete updated[chatUuid]
						}

						return updated
					})
				} catch (e) {
					logger.error("chats-sync", "failed to prune restored inflight queue", { error: e })
				}

				return true
			})
		)

		if (!result.success) {
			logger.error("chats-sync", "restoreFromDisk failed", { error: result.error })
		}

		this.resolveInit()

		// Kick sync() when disk had content AND the store still holds pending work — driven by
		// the STORE (the source of truth for pending work, including anything merged or sent
		// mid-restore), never the raw disk snapshot. sync() itself gates on isOnline(), so
		// calling it offline is a safe no-op.
		if (result.data && Object.keys(useChatsStore.getState().inflightMessages).length > 0) {
			this.sync()
		}
	}

	// Chats whose queue drained are not persisted.
	protected override toPersisted(inflightChatMessages: InflightChatMessages): InflightChatMessages {
		return Object.fromEntries(Object.entries(inflightChatMessages).filter(([_, { messages }]) => messages.length > 0))
	}

	private sync(): Promise<void> {
		return this.runPass(async signal => {
			const inflightMessages = useChatsStore.getState().inflightMessages

			if (Object.keys(inflightMessages).length === 0) {
				return null
			}

			const results = await Promise.allSettled(
				Object.entries(inflightMessages).map(async ([chatUuid, { chat, messages }]) => {
					if (messages.length === 0) {
						return
					}

					const sorted = [...messages].sort((a, b) => Number(a.sentTimestamp) - Number(b.sentTimestamp))

					for (const message of sorted) {
						if (signal.aborted) {
							return
						}

						if (!message.inner.message) {
							continue
						}

						try {
							await chats.sendMessage({
								chat,
								message: message.inner.message,
								replyTo: message.replyTo,
								inflightId: message.inflightId,
								signal
							})

							useChatsStore.getState().clearInflightError(message.inflightId)
						} catch (e) {
							if (signal.aborted) {
								return
							}

							const error = e instanceof Error ? e : (unwrapSdkError(e) ?? new Error(String(e)))

							// D4a: classify the rejection exactly like the notes sync (#40/VC3,
							// via the shared sdkRetryPolicy classifiers). Network-class errors,
							// re-auth-recoverable `Unauthenticated` errors and non-SDK errors
							// (e.g. abort) are KEEP-for-retry and never advance the drop bound.
							// Any OTHER SDK error (incl. the `Server` catch-all — the only signal
							// for a permanent rejection the SDK exposes) increments the per-message
							// consecutive-rejection counter.
							const permanent = isPermanentSdkRejection(e)
							const previousRejections =
								useChatsStore.getState().inflightErrors[message.inflightId]?.permanentRejections ?? 0
							const permanentRejections = permanent ? previousRejections + 1 : previousRejections

							useChatsStore.getState().setInflightErrors(prev => ({
								...prev,
								[message.inflightId]: {
									error,
									permanentRejections,
									message
								}
							}))

							if (permanentRejections >= MAX_NON_RETRYABLE_REJECTIONS) {
								// Drop the doomed message from the send queue so it is never
								// retried again. The error entry above stays (with the message
								// snapshot) so the failed bubble remains visible and actionable
								// (retry/remove) in the chat.
								logger.error("chats-sync", "dropping inflight message after max permanent rejections", { inflightId: message.inflightId, chatUuid, permanentRejections, error: e })

								useChatsStore.getState().dequeueInflightMessage(chatUuid, message.inflightId)
							}

							continue
						}

						useChatsStore.getState().dequeueInflightMessage(chatUuid, message.inflightId)
					}
				})
			)

			for (const r of results) {
				if (r.status === "rejected") {
					logger.error("chats-sync", "sync pass failed for a chat", { reason: r.reason })
				}
			}

			return useChatsStore.getState().inflightMessages
		})
	}

	public syncNow(): void {
		this.sync().catch(e => logger.error("chats-sync", "syncNow threw unexpectedly", { error: e }))
	}
}

export const sync = new Sync()

export const SyncHost = () => {
	useEffect(() => {
		sync.start()

		const appStateListener = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "background" || nextAppState === "active") {
				sync.syncNow()

				return
			}
		})

		return () => {
			appStateListener.remove()
		}
	}, [])

	return null
}

export default SyncHost
