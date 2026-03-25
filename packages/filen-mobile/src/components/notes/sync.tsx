import { useEffect, memo } from "react"
import { run, Semaphore, createExecutableTimeout } from "@filen/utils"
import notes from "@/lib/notes"
import alerts from "@/lib/alerts"
import { AppState } from "react-native"
import useNotesStore, { type InflightContent } from "@/stores/useNotes.store"
import sqlite from "@/lib/sqlite"
import { fetchData as notesWithContentQueryFetch } from "@/queries/useNotesWithContent.query"

export class Sync {
	private readonly mutex: Semaphore = new Semaphore(1)
	private readonly storageMutex: Semaphore = new Semaphore(1)
	private syncTimeout: ReturnType<typeof createExecutableTimeout> | null = null
	public readonly sqliteKvKey: string = "inflightNoteContent"
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

			const fromDisk = await sqlite.kvAsync.get<InflightContent>(this.sqliteKvKey)

			if (!fromDisk || Object.keys(fromDisk).length === 0) {
				return {}
			}

			const fromCloud = await notesWithContentQueryFetch()
			const fromCloudEditedTimestamp: Record<string, number> = fromCloud.reduce(
				(acc, note) => {
					acc[note.uuid] = Number(note.editedTimestamp)

					return acc
				},
				{} as Record<string, number>
			)

			for (const noteUuid of Object.keys(fromDisk)) {
				// If the note no longer exists in the cloud, remove its inflight contents
				if (!fromCloudEditedTimestamp[noteUuid]) {
					delete fromDisk[noteUuid]
				} else {
					const editedTimestamp = fromCloudEditedTimestamp[noteUuid]

					for (const [uuid, contents] of Object.entries(fromDisk)) {
						if (noteUuid === uuid) {
							// Remove any contents that are older than the cloud note's edited timestamp
							fromDisk[noteUuid] = contents.filter(c => c.timestamp > editedTimestamp)
						}

						if (fromDisk[noteUuid] && fromDisk[noteUuid].length === 0) {
							delete fromDisk[noteUuid]
						}
					}
				}
			}

			useNotesStore.getState().setInflightContent(fromDisk)

			return fromDisk
		})

		if (!result.success) {
			console.error("Error initializing note sync:", result.error)
		}

		// We don't really care if it failed, we just proceed
		this.initDone = true

		if (Object.keys(result.data ?? {}).length > 0) {
			this.sync()
		}
	}

	public async flushToDisk(inflightContent: InflightContent, requireMutex: boolean = true): Promise<void> {
		const result = await run(async defer => {
			await Promise.all([!requireMutex ? Promise.resolve() : this.storageMutex.acquire(), this.waitForInit()])

			defer(() => {
				if (requireMutex) {
					this.storageMutex.release()
				}
			})

			if (Object.keys(inflightContent).length === 0) {
				await sqlite.kvAsync.remove(this.sqliteKvKey)

				return
			}

			await sqlite.kvAsync.set(this.sqliteKvKey, inflightContent)
		})

		if (!result.success) {
			console.error("Error flushing note sync to disk:", result.error)
		}
	}

	private async sync(): Promise<void> {
		const result = await run(async defer => {
			await Promise.all([this.mutex.acquire(), this.waitForInit(), this.storageMutex.acquire()])

			defer(() => {
				this.mutex.release()
				this.storageMutex.release()
			})

			const fromDisk = await sqlite.kvAsync.get<InflightContent>(this.sqliteKvKey)

			if (!fromDisk || Object.keys(fromDisk).length === 0) {
				return
			}

			await Promise.all(
				Object.entries(fromDisk).map(async ([_, contents]) => {
					if (contents.length === 0) {
						return
					}

					const mostRecentContent = contents.sort((a, b) => b.timestamp - a.timestamp).at(0)

					if (!mostRecentContent) {
						return
					}

					const updatedNote = await notes.setContent({
						note: mostRecentContent.note,
						content: mostRecentContent.content
					})

					let updatedContent: InflightContent | null = null

					useNotesStore.getState().setInflightContent(prev => {
						const updated = {
							...prev
						}

						for (const [noteUuid, contents] of Object.entries(updated)) {
							if (noteUuid === mostRecentContent.note.uuid) {
								// Remove contents that have been synced
								updated[noteUuid] = contents.filter(c => c.timestamp > Number(updatedNote.editedTimestamp))
							}

							if (updated[noteUuid] && updated[noteUuid].length === 0) {
								delete updated[noteUuid]
							}
						}

						updatedContent = updated

						return updated
					})

					if (updatedContent) {
						await this.flushToDisk(updatedContent, false)
					}
				})
			)
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}

	public syncDebounced(): void {
		this.syncTimeout?.cancel()

		this.syncTimeout = createExecutableTimeout(() => {
			this.sync().catch(console.error)
		}, 3000)
	}

	public executeNow(): void {
		this.syncTimeout?.execute()
	}
}

export const sync = new Sync()

export const SyncHost = memo(() => {
	useEffect(() => {
		const appStateListener = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "background") {
				sync.executeNow()
			}
		})

		return () => {
			appStateListener.remove()
		}
	}, [])

	return null
})

export default SyncHost
