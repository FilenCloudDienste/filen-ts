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
				return {}
			}

			// Hydrate the store FIRST, before any network call. This must work offline: the
			// persisted queue has to become visible and deliverable for the session even when
			// the chats-list fetch below throws (offline launch). Pruning is a best-effort
			// refinement layered on top, never a gate on hydration.
			useChatsStore.getState().setInflightMessages(fromDisk)

			// Best-effort prune of messages for chats that no longer exist. On a fetch failure
			// (e.g. offline) keep the unpruned queue rather than dropping everything.
			try {
				const chatsList = await chatsQueryFetch()
				const existingChatUuids = new Set(chatsList.map(chat => chat.uuid))

				for (const chatUuid of Object.keys(fromDisk)) {
					if (!existingChatUuids.has(chatUuid)) {
						delete fromDisk[chatUuid]
					}
				}

				useChatsStore.getState().setInflightMessages(fromDisk)
			} catch (e) {
				console.error("Error pruning restored chat sync queue:", e)
			}

			return fromDisk
		})

		if (!result.success) {
			console.error("Error initializing chat sync:", result.error)
		}

		this.resolveInit()

		if (Object.keys(result.data ?? {}).length > 0) {
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

							useChatsStore.getState().setInflightErrors(prev => {
								const updated = {
									...prev
								}

								updated[message.inflightId] =
									e instanceof Error ? e : FilenSdkError.hasInner(e) ? FilenSdkError.getInner(e) : new Error(String(e))

								return updated
							})

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

			await this.flushToDisk(useChatsStore.getState().inflightMessages)
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
