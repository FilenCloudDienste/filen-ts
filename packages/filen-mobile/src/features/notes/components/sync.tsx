import { useEffect } from "react"
import { run, Semaphore, createExecutableTimeout } from "@filen/utils"
import { onlineManager } from "@tanstack/react-query"
import notes from "@/features/notes/notes"
import alerts from "@/lib/alerts"
import { AppState } from "react-native"
import useNotesInflightStore, { type InflightContent } from "@/features/notes/store/useNotesInflight.store"
import sqlite from "@/lib/sqlite"
import { fetchData as notesWithContentQueryFetch, notesWithContentQueryGet } from "@/features/notes/queries/useNotesWithContent.query"

// #41 fix: functional, per-uuid MERGE used to hydrate the disk-restored inflight
// queue into the (possibly already-populated) store without clobbering edits the
// user typed during the seconds-long cloud-fetch reconciliation window. For each
// uuid we keep whichever side carries the newest local author-timestamp: a fresh
// store edit beats stale disk content, and disk content seeds uuids the store
// doesn't have yet. Pure — no store/IO access — so it stays trivially testable.
export function mergeInflight(current: InflightContent, fromDisk: InflightContent): InflightContent {
	const merged: InflightContent = {
		...current
	}

	for (const uuid of Object.keys(fromDisk)) {
		const diskEntries = fromDisk[uuid] ?? []
		const currentEntries = merged[uuid]

		if (!currentEntries || currentEntries.length === 0) {
			merged[uuid] = diskEntries

			continue
		}

		const newestCurrent = currentEntries.reduce((acc, c) => (c.timestamp > acc ? c.timestamp : acc), Number.NEGATIVE_INFINITY)
		const newestDisk = diskEntries.reduce((acc, c) => (c.timestamp > acc ? c.timestamp : acc), Number.NEGATIVE_INFINITY)

		// Current store edits win when they're at least as fresh as disk; otherwise
		// the disk copy is the newer record (e.g. store was empty for this uuid at
		// fetch start) and replaces it.
		if (newestCurrent >= newestDisk) {
			continue
		}

		merged[uuid] = diskEntries
	}

	return merged
}

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
		// #41 fix: this is the ONLY disk→store bridge, so it MUST hydrate the store
		// even with no network. The previous structure gated `setInflightContent` on
		// a successful cloud fetch (`listNotes` + `getNoteContent`), so an offline
		// boot threw before hydration and stranded persisted edits for the whole
		// session (reconnect's executeNow reads the empty store and no-ops). It also
		// blind-REPLACED the store from a pre-fetch snapshot, clobbering any edit the
		// user typed during the seconds-long fetch window (onValueChange writes the
		// store/disk without the sync mutex). We now: (1) hydrate unconditionally via
		// a functional MERGE before any network call, then (2) reconcile against the
		// cloud best-effort only when online.
		const result = await run(async defer => {
			await this.mutex.acquire()

			defer(() => {
				this.mutex.release()
			})

			const fromDisk = await sqlite.kvAsync.get<InflightContent>(this.sqliteKvKey)

			if (!fromDisk || Object.keys(fromDisk).length === 0) {
				return false
			}

			// (1) Hydrate UNCONDITIONALLY, before any network call, merging into the
			// current store so a concurrent edit isn't lost.
			useNotesInflightStore.getState().setInflightContent(prev => mergeInflight(prev, fromDisk))

			// (2) Reconcile against the cloud best-effort, only when online. A failure
			// here (offline, transient) must NOT undo the hydration above.
			if (!onlineManager.isOnline()) {
				return true
			}

			const reconcile = await run(async () => {
				const fromCloud = await notesWithContentQueryFetch()
				const cloudByUuid = new Map<string, string>()

				for (const note of fromCloud) {
					cloudByUuid.set(note.uuid, note.content)
				}

				// #4 principle applied to restore: drop a disk-seeded inflight entry
				// only when its content EQUALS the freshly-fetched cloud content
				// (it's already synced), and drop entries for notes no longer in the
				// cloud (deleted/no longer accessible). Compare content, never mix
				// local and server clocks. Applied as a functional update so any edit
				// made during the fetch is preserved.
				useNotesInflightStore.getState().setInflightContent(prev => {
					const updated = {
						...prev
					}

					for (const noteUuid of Object.keys(fromDisk)) {
						const entries = updated[noteUuid]

						if (!entries) {
							continue
						}

						if (!cloudByUuid.has(noteUuid)) {
							delete updated[noteUuid]

							continue
						}

						const cloudContent = cloudByUuid.get(noteUuid) ?? ""
						const remaining = entries.filter(c => c.content !== cloudContent)

						if (remaining.length === 0) {
							delete updated[noteUuid]

							continue
						}

						updated[noteUuid] = remaining
					}

					return updated
				})
			})

			if (!reconcile.success) {
				console.error("Error reconciling note sync against cloud:", reconcile.error)
			}

			return true
		})

		if (!result.success) {
			console.error("Error initializing note sync:", result.error)
		}

		this.resolveInit()

		// #41 fix: kick sync() when we restored something from disk AND the store
		// still holds pending work — driven by the STORE (the source of truth for
		// pending work), never the fetch result, so offline-restored inflight is
		// queued for the reconnect listener. `result.data` only reports whether disk
		// had content (so an empty-disk boot never kicks). sync() itself gates on
		// isOnline(), so calling it offline is a safe no-op.
		if (result.data && Object.keys(useNotesInflightStore.getState().inflightContent).length > 0) {
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
		if (!onlineManager.isOnline()) {
			return
		}

		const signal = this.abortController.signal

		const result = await run(async defer => {
			await Promise.all([this.mutex.acquire(), this.initPromise])

			defer(() => {
				this.mutex.release()
			})

			const inflightContent = useNotesInflightStore.getState().inflightContent

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

					// #34 fix: resolve the live note from the query cache so that any
					// metadata changes (type, participants, encryptionKey) that arrived
					// via socket between the render-time snapshot and the debounce flush
					// are reflected in the setContent call. Fall back to the snapshot
					// if the note is no longer in the cache (e.g. concurrently deleted).
					const cachedNotes = notesWithContentQueryGet()
					const liveNote = cachedNotes?.find(n => n.uuid === noteUuid) ?? mostRecentContent.note

					// #4 fix: capture the LOCAL author-time of the entry we are about to
					// push BEFORE the await. The prune below must remove exactly the
					// content we actually sent (and strictly-older entries), never use the
					// server's `editedTimestamp`. The two are different clocks in the same
					// unit (`timestamp` is local Date.now() author-time; `editedTimestamp`
					// is the server's response time), so pruning by the server clock
					// silently discards every keystroke typed during the in-flight
					// setContent round trip (their local timestamp falls below the server
					// time). Comparing local-vs-local preserves those edits for the
					// rescheduled debounce and is immune to device-clock skew.
					const syncedUpTo = mostRecentContent.timestamp

					await notes.setContent({
						note: liveNote,
						content: mostRecentContent.content,
						signal
					})

					useNotesInflightStore.getState().setInflightContent(prev => {
						const updated = {
							...prev
						}

						if (updated[noteUuid]) {
							updated[noteUuid] = updated[noteUuid].filter(c => c.timestamp > syncedUpTo)

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

			await this.flushToDisk(useNotesInflightStore.getState().inflightContent)
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
		// Fall through to a direct sync() when no debounce is queued. This
		// catches the cold-start + offline + reconnect case: restoreFromDisk
		// runs sync() at boot, which bails because we're offline, but does NOT
		// schedule a debounce — so when the reconnect listener later calls
		// executeNow() there's nothing for the timeout's execute() to fire.
		// Without this fallthrough, inflight from the previous session would
		// sit on disk forever until the user typed (which retriggers
		// syncDebounced) or backgrounded/foregrounded the app at the right
		// moment.
		if (this.syncTimeout) {
			this.syncTimeout.execute()

			return
		}

		this.sync().catch(console.error)
	}
}

export const sync = new Sync()

export const SyncHost = () => {
	useEffect(() => {
		sync.start()

		const appStateListener = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "background" || nextAppState === "active") {
				sync.executeNow()

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
