import { useEffect, memo } from "react"
import { run, Semaphore, createExecutableTimeout } from "@filen/utils"
import { onlineManager } from "@tanstack/react-query"
import notes from "@/lib/notes"
import alerts from "@/lib/alerts"
import { AppState } from "react-native"
import useNotesStore, { type InflightContent } from "@/stores/useNotes.store"
import sqlite from "@/lib/sqlite"
import { fetchData as notesWithContentQueryFetch } from "@/queries/useNotesWithContent.query"

export class Sync {
	private readonly mutex: Semaphore = new Semaphore(1)
	private syncTimeout: ReturnType<typeof createExecutableTimeout> | null = null
	public readonly sqliteKvKey: string = "inflightNoteContent"
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
		this.syncTimeout?.cancel()
		this.syncTimeout = null
		this.abortController.abort()
		this.abortController = new AbortController()
	}

	private async restoreFromDisk() {
		const result = await run(async defer => {
			await this.mutex.acquire()

			defer(() => {
				this.mutex.release()
			})

			const fromDisk = await sqlite.kvAsync.get<InflightContent>(this.sqliteKvKey)

			if (!fromDisk || Object.keys(fromDisk).length === 0) {
				return {}
			}

			const fromCloud = await notesWithContentQueryFetch()
			const fromCloudEditedTimestamp: Record<string, number> = {}

			for (const note of fromCloud) {
				fromCloudEditedTimestamp[note.uuid] = Number(note.editedTimestamp)
			}

			for (const noteUuid of Object.keys(fromDisk)) {
				const editedTimestamp = fromCloudEditedTimestamp[noteUuid]

				if (!editedTimestamp) {
					delete fromDisk[noteUuid]

					continue
				}

				fromDisk[noteUuid] = fromDisk[noteUuid]!.filter(c => c.timestamp > editedTimestamp)

				if (fromDisk[noteUuid]!.length === 0) {
					delete fromDisk[noteUuid]
				}
			}

			useNotesStore.getState().setInflightContent(fromDisk)

			return fromDisk
		})

		if (!result.success) {
			console.error("Error initializing note sync:", result.error)
		}

		this.resolveInit()

		if (Object.keys(result.data ?? {}).length > 0) {
			this.sync()
		}
	}

	public async flushToDisk(inflightContent: InflightContent): Promise<void> {
		await this.initPromise

		const result = await run(async () => {
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
		// No network → no point firing notes.setContent. Inflight content stays in
		// SQLite; the reconnect listener calls forceSync() once we come back online.
		if (!onlineManager.isOnline()) {
			return
		}

		const signal = this.abortController.signal

		const result = await run(async defer => {
			await Promise.all([this.mutex.acquire(), this.initPromise])

			defer(() => {
				this.mutex.release()
			})

			const inflightContent = useNotesStore.getState().inflightContent

			if (Object.keys(inflightContent).length === 0) {
				return
			}

			const results = await Promise.allSettled(
				Object.entries(inflightContent).map(async ([noteUuid, contents]) => {
					if (signal.aborted) {
						return
					}

					if (contents.length === 0) {
						return
					}

					const mostRecentContent = [...contents].sort((a, b) => b.timestamp - a.timestamp).at(0)

					if (!mostRecentContent) {
						return
					}

					const updatedNote = await notes.setContent({
						note: mostRecentContent.note,
						content: mostRecentContent.content,
						signal
					})

					useNotesStore.getState().setInflightContent(prev => {
						const updated = {
							...prev
						}

						if (updated[noteUuid]) {
							updated[noteUuid] = updated[noteUuid].filter(c => c.timestamp > Number(updatedNote.editedTimestamp))

							if (updated[noteUuid].length === 0) {
								delete updated[noteUuid]
							}
						}

						return updated
					})
				})
			)

			for (const r of results) {
				if (r.status === "rejected") {
					console.error("[NotesSync] Failed to sync note:", r.reason)
				}
			}

			await this.flushToDisk(useNotesStore.getState().inflightContent)
		})

		if (!result.success) {
			if (signal.aborted) {
				return
			}

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

	// Forces an immediate sync attempt regardless of pending debounce state.
	// Used by the reconnect listener (src/lib/reconnect.ts) since executeNow()
	// only fires whatever debounce happens to be queued — and an offline-induced
	// early-return inside sync() will have already consumed any prior debounce.
	public async forceSync(): Promise<void> {
		await this.sync()
	}
}

export const sync = new Sync()

export const SyncHost = memo(() => {
	useEffect(() => {
		sync.start()

		const appStateListener = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "background") {
				sync.executeNow()

				return
			}

			// Active transition: cover the gap where (a) the previous offline-gate
			// bail consumed the debounce without rescheduling, (b) the user came
			// back to the app after writing offline and there's been no new
			// keystroke to trigger the debounce, or (c) reconnect.ts missed the
			// transition because onlineManager.isOnline() was already true at
			// boot. forceSync() awaits sync() directly and re-evaluates the
			// online gate at call time, so a stale inflight is flushed as soon
			// as the runtime is actually online.
			if (nextAppState === "active") {
				sync.forceSync().catch(console.error)
			}
		})

		return () => {
			appStateListener.remove()
		}
	}, [])

	return null
})

export default SyncHost
