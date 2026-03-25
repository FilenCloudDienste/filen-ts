import { useEffect, memo } from "react"
import { run, Semaphore } from "@filen/utils"
import chats from "@/lib/chats"
import alerts from "@/lib/alerts"
import { AppState } from "react-native"
import useChatsStore, { type InflightChatMessages } from "@/stores/useChats.store"
import sqlite from "@/lib/sqlite"
import { fetchData as chatsQueryFetch } from "@/queries/useChats.query"
import { FilenSdkError } from "@filen/sdk-rs"

export class Sync {
	private readonly mutex: Semaphore = new Semaphore(1)
	private readonly storageMutex: Semaphore = new Semaphore(1)
	public readonly sqliteKvKey: string = "inflightChatMessages"
	private initDone: boolean = false

	public constructor() {
		this.restoreFromDisk()
	}

	private async waitForInit(): Promise<void> {
		while (!this.initDone) {
			await new Promise<void>(resolve => setTimeout(resolve, 100))
		}
	}

	private async restoreFromDisk() {
		const result = await run(async defer => {
			await Promise.all([this.mutex.acquire(), this.storageMutex.acquire()])

			defer(() => {
				this.mutex.release()
				this.storageMutex.release()
			})

			const fromDisk = await sqlite.kvAsync.get<InflightChatMessages>(this.sqliteKvKey)

			if (!fromDisk || Object.keys(fromDisk).length === 0) {
				return {}
			}

			const chats = await chatsQueryFetch()
			const existingChatUuids: Record<string, boolean> = chats.reduce(
				(acc, chat) => {
					acc[chat.uuid] = true

					return acc
				},
				{} as Record<string, boolean>
			)

			for (const chatUuid of Object.keys(fromDisk)) {
				// If the chat no longer exists, remove its inflight messages
				if (!existingChatUuids[chatUuid]) {
					delete fromDisk[chatUuid]
				}
			}

			useChatsStore.getState().setInflightMessages(fromDisk)

			return fromDisk
		})

		if (!result.success) {
			console.error("Error initializing chat sync:", result.error)
		}

		// We don't really care if it failed, we just proceed
		this.initDone = true

		if (Object.keys(result.data ?? {}).length > 0) {
			this.sync()
		}
	}

	public async flushToDisk(inflightChatMessages: InflightChatMessages, requireMutex: boolean = true): Promise<void> {
		const result = await run(async defer => {
			await Promise.all([!requireMutex ? Promise.resolve() : this.storageMutex.acquire(), this.waitForInit()])

			defer(() => {
				if (requireMutex) {
					this.storageMutex.release()
				}
			})

			if (
				Object.keys(inflightChatMessages).length === 0 ||
				Object.values(inflightChatMessages).every(({ messages }) => messages.length === 0)
			) {
				await sqlite.kvAsync.remove(this.sqliteKvKey)

				return
			}

			for (const [chatUuid, { messages }] of Object.entries(inflightChatMessages)) {
				if (messages.length === 0) {
					delete inflightChatMessages[chatUuid]
				}
			}

			await sqlite.kvAsync.set(this.sqliteKvKey, inflightChatMessages)
		})

		if (!result.success) {
			console.error("Error flushing chat sync to disk:", result.error)
		}
	}

	public async sync(): Promise<void> {
		const result = await run(async defer => {
			await Promise.all([this.mutex.acquire(), this.waitForInit(), this.storageMutex.acquire()])

			defer(() => {
				this.mutex.release()
				this.storageMutex.release()
			})

			const fromDisk = await sqlite.kvAsync.get<InflightChatMessages>(this.sqliteKvKey)

			if (!fromDisk || Object.keys(fromDisk).length === 0) {
				return
			}

			await Promise.all(
				Object.entries(fromDisk).map(async ([chatUuid, { chat, messages }]) => {
					if (messages.length === 0) {
						return
					}

					const sorted = messages.sort((a, b) => Number(a.sentTimestamp) - Number(b.sentTimestamp))

					// Process messages in order
					for (const message of sorted) {
						if (!message.inner.message) {
							continue
						}

						try {
							await chats.sendMessage({
								chat,
								message: message.inner.message,
								replyTo: message.replyTo,
								inflightId: message.inflightId
							})

							useChatsStore.getState().setInflightErrors(prev => {
								const updated = {
									...prev
								}

								delete updated[message.inflightId]

								return updated
							})
						} catch (e) {
							useChatsStore.getState().setInflightErrors(prev => {
								const updated = {
									...prev
								}

								updated[message.inflightId] =
									e instanceof Error ? e : FilenSdkError.hasInner(e) ? FilenSdkError.getInner(e) : new Error(String(e))

								return updated
							})

							throw e
						}

						let updatedMessages: InflightChatMessages | null = null

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

								updatedMessages = updated
							}

							return updated
						})

						if (updatedMessages) {
							await this.flushToDisk(updatedMessages, false)
						}
					}
				})
			)
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}
}

export const sync = new Sync()

export const SyncHost = memo(() => {
	useEffect(() => {
		const appStateListener = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "background") {
				sync.sync()
			}
		})

		return () => {
			appStateListener.remove()
		}
	}, [])

	return null
})

export default SyncHost
