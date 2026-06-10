import { useEffect } from "react"
import { run, Semaphore } from "@filen/utils"
import { onlineManager } from "@tanstack/react-query"
import chats from "@/features/chats/chats"
import alerts from "@/lib/alerts"
import { AppState } from "react-native"
import useChatsStore, { type InflightChatMessages } from "@/features/chats/store/useChats.store"
import sqlite from "@/lib/sqlite"
import { fetchData as chatsQueryFetch } from "@/features/chats/queries/useChats.query"
import { FilenSdkError } from "@filen/sdk-rs"
import { unwrapSdkError, isNetworkClassError, isRetryableAuthError } from "@/lib/sdkErrors"

// D4a (ported from notes sync #40/VC3): a message whose send is rejected by the server with a
// PERMANENT error (non-network, non-auth SDK rejection) must eventually stop being retried —
// otherwise every sync pass re-attempts it forever. But a TRANSIENT non-network error (e.g. a
// one-off `ErrorKind.Server`, the catch-all for non-`internal_error` API failures) must NOT lose
// the message. We bound the drop: only after this many CONSECUTIVE non-network, non-auth SDK
// rejections for the same message do we drop it from the send queue. The error entry (which
// carries the counter and a message snapshot) is kept so the failure stays visible in the chat
// until the user retries or removes it.
export const MAX_NON_RETRYABLE_REJECTIONS = 3

// D1 fix: functional, per-chat MERGE used to hydrate the disk-restored inflight queue into the
// (possibly already-populated) store without clobbering a message the user sent during the
// seconds-long restore window (input's send() writes the store/disk without the sync mutex).
// Disk seeds chats the store doesn't have yet; for chats present on both sides the message lists
// are unioned by inflightId with LIVE entries winning (anything in the live store is newer than
// any disk snapshot of the same id). Pure — no store/IO access — so it stays trivially testable.
export function mergeInflight(current: InflightChatMessages, fromDisk: InflightChatMessages): InflightChatMessages {
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

export class Sync {
	private readonly mutex: Semaphore = new Semaphore(1)
	public readonly sqliteKvKey: string = "inflightChatMessages"
	private readonly initPromise: Promise<void>
	private resolveInit!: () => void
	private abortController: AbortController = new AbortController()

	public constructor() {
		this.initPromise = new Promise(resolve => {
			this.resolveInit = resolve
		})
	}

	public start(): void {
		this.restoreFromDisk()
	}

	public cancel(): void {
		this.abortController.abort()
		this.abortController = new AbortController()
	}

	private async restoreFromDisk() {
		const result = await run(async defer => {
			await this.mutex.acquire()

			defer(() => {
				this.mutex.release()
			})

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
			useChatsStore.getState().setInflightMessages(prev => mergeInflight(prev, fromDisk))

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
				console.error("Error pruning restored chat sync queue:", e)
			}

			return true
		})

		if (!result.success) {
			console.error("Error initializing chat sync:", result.error)
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

	public async flushToDisk(inflightChatMessages: InflightChatMessages): Promise<void> {
		await this.initPromise

		const result = await run(async () => {
			const filtered = Object.fromEntries(Object.entries(inflightChatMessages).filter(([_, { messages }]) => messages.length > 0))

			if (Object.keys(filtered).length === 0) {
				await sqlite.kvAsync.remove(this.sqliteKvKey)

				return
			}

			await sqlite.kvAsync.set(this.sqliteKvKey, filtered)
		})

		if (!result.success) {
			console.error("Error flushing chat sync to disk:", result.error)
		}
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

			const inflightMessages = useChatsStore.getState().inflightMessages

			if (Object.keys(inflightMessages).length === 0) {
				return
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

							useChatsStore.getState().setInflightErrors(prev => {
								const updated = {
									...prev
								}

								delete updated[message.inflightId]

								return updated
							})
						} catch (e) {
							if (signal.aborted) {
								return
							}

							const error =
								e instanceof Error ? e : FilenSdkError.hasInner(e) ? FilenSdkError.getInner(e) : new Error(String(e))

							// D4a: classify the rejection exactly like the notes sync (#40/VC3,
							// via the shared src/lib/sdkErrors classifiers). Network-class errors,
							// re-auth-recoverable `Unauthenticated` errors and non-SDK errors
							// (e.g. abort) are KEEP-for-retry and never advance the drop bound.
							// Any OTHER SDK error (incl. the `Server` catch-all — the only signal
							// for a permanent rejection the SDK exposes) increments the per-message
							// consecutive-rejection counter.
							const unwrapped = unwrapSdkError(e)
							const isPermanentRejection = unwrapped !== null && !isNetworkClassError(e) && !isRetryableAuthError(e)
							const previousRejections =
								useChatsStore.getState().inflightErrors[message.inflightId]?.permanentRejections ?? 0
							const permanentRejections = isPermanentRejection ? previousRejections + 1 : previousRejections

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
								console.error(
									`[ChatsSync] Dropping inflight message ${message.inflightId} after ${permanentRejections} consecutive non-retryable errors:`,
									e
								)

								useChatsStore.getState().setInflightMessages(prev => {
									const existing = prev[chatUuid]

									if (!existing) {
										return prev
									}

									const remaining = existing.messages.filter(m => m.inflightId !== message.inflightId)
									const updated = {
										...prev
									}

									if (remaining.length === 0) {
										delete updated[chatUuid]
									} else {
										updated[chatUuid] = {
											...existing,
											messages: remaining
										}
									}

									return updated
								})
							}

							continue
						}

						useChatsStore.getState().setInflightMessages(prev => {
							const updated = {
								...prev
							}

							if (updated[chatUuid]) {
								updated[chatUuid] = {
									...updated[chatUuid],
									messages: (updated[chatUuid]?.messages ?? []).filter(m => m.inflightId !== message.inflightId)
								}

								if (updated[chatUuid].messages.length === 0) {
									delete updated[chatUuid]
								}
							}

							return updated
						})
					}
				})
			)

			for (const r of results) {
				if (r.status === "rejected") {
					console.error("[ChatsSync] Failed to sync chat:", r.reason)
				}
			}

			// D2: never flush after an aborted pass. Logout aborts in-flight sync (Phase 2) and
			// later wipes SQLite (Phase 6) — a late flush here would resurrect the previous
			// account's plaintext queue onto disk after the wipe.
			if (!signal.aborted) {
				await this.flushToDisk(useChatsStore.getState().inflightMessages)
			}
		})

		if (!result.success) {
			if (signal.aborted) {
				return
			}

			console.error(result.error)
			alerts.error(result.error)
		}
	}

	public syncNow(): void {
		this.sync().catch(console.error)
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
