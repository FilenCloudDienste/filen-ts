import { useEffect } from "react"
import { run, Semaphore, createExecutableTimeout } from "@filen/utils"
import { onlineManager } from "@tanstack/react-query"
import { xxHash32 } from "js-xxhash"
import notes from "@/features/notes/notes"
import alerts from "@/lib/alerts"
import i18n from "@/lib/i18n"
import { noteDisplayTitle } from "@/lib/decryption"
import { AppState } from "react-native"
import useNotesInflightStore, { type InflightContent } from "@/features/notes/store/useNotesInflight.store"
import sqlite from "@/lib/sqlite"
import { fetchData as notesWithContentQueryFetch, notesWithContentQueryGet } from "@/features/notes/queries/useNotesWithContent.query"
import { noteContentQueryUpdate, noteContentQueryDataUpdatedAt } from "@/features/notes/queries/useNoteContent.query"
import { unwrapSdkError, isNetworkClassError, isRetryableAuthError } from "@/lib/sdkErrors"
import logger from "@/lib/logger"

// D3: cheap stable content hash used for overwrite-conflict DETECTION (same xxHash32 the
// fileCache/cameraUpload dedup paths use). Persisted inside inflight entries as
// `baseContentHash`, so the algorithm must stay stable across app versions — changing it
// only costs a one-pass grace (entries fall back to the legacy no-hash path), never data.
export function hashNoteContent(content: string): string {
	return xxHash32(content).toString(16)
}

// #40 / VC3: a genuine read-only/permission rejection (the server replies with a non-network,
// non-auth error) must eventually DROP so the wedged content query re-enables — but a TRANSIENT
// non-network error (e.g. a one-off `ErrorKind.Server`, the catch-all for non-`internal_error` API
// failures) must NOT lose the first edit. We bound the drop: only after this many CONSECUTIVE
// non-network, non-auth SDK rejections for the same note do we discard its inflight content.
export const MAX_NON_RETRYABLE_REJECTIONS = 3

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
	// VC3: per-note count of CONSECUTIVE non-network, non-auth SDK rejections. Transient (in
	// memory only — never persisted to disk), reset on any successful sync or when the note's
	// inflight is dropped/drained. Bounds the #40 drop so a one-off `Server` error never loses
	// the first edit, while a genuine permission rejection still un-wedges after N attempts.
	private readonly nonRetryableRejections: Map<string, number> = new Map<string, number>()

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
				logger.warn("notes-sync", "cloud reconcile after restore failed; stale inflight entries may persist", { error: reconcile.error })
			}

			return true
		})

		if (!result.success) {
			logger.error("notes-sync", "restoreFromDisk failed; unsaved edits from previous session may be lost", { error: result.error })
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

	// M3: reports persistence failure as `false` instead of throwing (it still never
	// throws). Sync-internal callers ignore the return (the next pass re-flushes);
	// COMPONENT call sites must surface a `false` — a failing SQLite write means the
	// user's edit survives in memory only and would otherwise die with zero signal.
	public async flushToDisk(inflightContent: InflightContent): Promise<boolean> {
		await this.initPromise

		const result = await run(async () => {
			if (Object.keys(inflightContent).length === 0) {
				await sqlite.kvAsync.remove(this.sqliteKvKey)

				return
			}

			await sqlite.kvAsync.set(this.sqliteKvKey, inflightContent)
		})

		if (!result.success) {
			logger.error("notes-sync", "flushToDisk failed; in-flight edit not persisted", { error: result.error })
		}

		return result.success
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
				this.nonRetryableRejections.clear()

				return
			}

			// VC3: drop stale rejection counters for notes whose inflight is gone (drained,
			// cleared via the remote-edit reload, or pruned on reconcile). Otherwise a fresh
			// edit on a previously-rejected note would inherit a stale count and lose part of
			// its retry budget.
			for (const trackedUuid of this.nonRetryableRejections.keys()) {
				const entries = inflightContent[trackedUuid]

				if (!entries || entries.length === 0) {
					this.nonRetryableRejections.delete(trackedUuid)
				}
			}

			// D3: one overwrite toast per note per pass. Each note is pushed at most once per
			// pass anyway (only its most recent entry goes out), so this is belt-and-braces
			// against ever stacking duplicate toasts for the same note.
			const toastedConflicts = new Set<string>()

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

					// D3: conflict DETECTION, never prevention — local edits always win and the
					// push below is unconditional (user decision: no prompts, no blocking). When
					// the entry carries its session's base hash, peek at the note's current cloud
					// content first: if the cloud moved past our base AND past what we are about
					// to write, this push buries someone else's newer work in the note's history,
					// and the user must hear about it once — a silent overwrite ("users won't
					// know history has it") is the failure being prevented. Entries WITHOUT a
					// base hash (persisted by older app versions) push unchecked — a one-time
					// grace instead of migration machinery. A failed peek also pushes unchecked:
					// availability beats the toast.
					let overwritesNewerRemoteContent = false

					if (mostRecentContent.baseContentHash !== undefined) {
						try {
							const cloudContent = (await notes.getContent({ note: liveNote, signal })) ?? ""

							overwritesNewerRemoteContent =
								hashNoteContent(cloudContent) !== mostRecentContent.baseContentHash &&
								cloudContent !== mostRecentContent.content
						} catch (e) {
							// Availability beats the toast — push without the check.
							logger.warn("notes-sync", "conflict-detection peek failed; pushing without overwrite check", { noteUuid, error: e })
						}
					}

					try {
						await notes.setContent({
							note: liveNote,
							content: mostRecentContent.content,
							signal
						})
					} catch (e) {
						// #40 hardening: a read-only / shared / history note whose edit
						// reaches sync (e.g. Quill failed to enforce readOnly) is rejected
						// by the server with a permanent error. The old behaviour kept the
						// entry forever, so every sync re-attempted it and `hasInflightContent`
						// stayed true — permanently DISABLING the note's content query
						// (`enabled: !hasInflightContent`) and wedging the editor.
						//
						// VC3 (data-loss fix): the previous drop fired on ANY non-network SDK
						// error, so a TRANSIENT `Server` (the catch-all for non-`internal_error`
						// API errors) or an `Unauthenticated` (re-auth-recoverable, e.g. right
						// after a password change) silently destroyed a real edit on a WRITABLE
						// note. The SDK exposes only `kind()`/`message()` (no permission code),
						// so we cannot positively identify a permission rejection — `Server` is
						// the only signal and it is a catch-all. We therefore:
						//   1. KEEP-for-retry on a network-class error (re-throw, existing path).
						//   2. KEEP-for-retry on an `Unauthenticated` error (re-throw — it resolves
						//      once the session refreshes; never count it toward the drop bound).
						//   3. For any OTHER non-network SDK error (incl. the `Server` catch-all),
						//      BOUND the drop: increment a per-note consecutive-rejection counter
						//      and only drop once it reaches MAX_NON_RETRYABLE_REJECTIONS. A
						//      one-off transient error keeps the edit (re-throw to retry); a
						//      genuine read-only/permission rejection still un-wedges the query
						//      after N attempts.
						//   4. Any non-SDK error (e.g. abort) is re-thrown unchanged.
						const unwrapped = unwrapSdkError(e)

						if (!unwrapped || isNetworkClassError(e) || isRetryableAuthError(e)) {
							throw e
						}

						const previousRejections = this.nonRetryableRejections.get(noteUuid) ?? 0
						const rejections = previousRejections + 1

						if (rejections < MAX_NON_RETRYABLE_REJECTIONS) {
							this.nonRetryableRejections.set(noteUuid, rejections)

							logger.warn("notes-sync", "non-retryable SDK rejection on setContent; will retry", { noteUuid, rejections, maxRejections: MAX_NON_RETRYABLE_REJECTIONS, error: e })

							throw e
						}

						this.nonRetryableRejections.delete(noteUuid)

						useNotesInflightStore.getState().setInflightContent(prev => {
							const updated = {
								...prev
							}

							delete updated[noteUuid]

							return updated
						})

						logger.error("notes-sync", "dropping inflight content after max non-retryable rejections; edit lost", { noteUuid, rejections, error: e })

						return
					}

					// A successful push clears any accumulated rejection count for this note.
					this.nonRetryableRejections.delete(noteUuid)

					// The pushed content IS the cloud content now — write it into the per-note
					// content query cache so any editor reseed after the inflight queue drains
					// paints exactly what the user typed, never the stale pre-edit cache (the
					// query is disabled while inflight and staleTime: Infinity, so nothing else
					// refreshes it after a push). dataUpdatedAt is PRESERVED: the editor's
					// remount key is this timestamp, so advancing it would remount the WebView
					// (cursor reset) after every push — preserving it updates the data invisibly.
					// A never-fetched note has no mounted editor keyed on it, so the fresh
					// timestamp fallback there is safe.
					noteContentQueryUpdate({
						params: {
							uuid: noteUuid
						},
						updater: mostRecentContent.content,
						dataUpdatedAt: noteContentQueryDataUpdatedAt({
							uuid: noteUuid
						})
					})

					// D3: the content we just pushed IS the cloud content now, so it becomes the
					// base for every entry typed during the round trip (they survive the prune
					// below). Without this refresh the next pass would compare those entries
					// against their stale session base and flag our OWN push as a conflict.
					const pushedContentHash = hashNoteContent(mostRecentContent.content)

					useNotesInflightStore.getState().setInflightContent(prev => {
						const updated = {
							...prev
						}

						const entries = updated[noteUuid]

						if (entries) {
							const remaining = entries
								.filter(c => c.timestamp > syncedUpTo)
								.map(c => ({
									...c,
									baseContentHash: pushedContentHash
								}))

							if (remaining.length === 0) {
								delete updated[noteUuid]
							} else {
								updated[noteUuid] = remaining
							}
						}

						return updated
					})

					// D3: toast only AFTER the push landed (a failed push overwrites nothing and
					// is retried — the next pass re-detects), once per note per pass, and never
					// for an aborted pass (logout must stay silent).
					if (overwritesNewerRemoteContent && !signal.aborted && !toastedConflicts.has(noteUuid)) {
						toastedConflicts.add(noteUuid)

						alerts.normal(
							i18n.t("note_overwrote_newer_remote_changes", {
								name: noteDisplayTitle(liveNote)
							})
						)
					}
				})
			)

			for (const r of results) {
				if (r.status === "rejected") {
					logger.error("notes-sync", "failed to sync note in pass", { reason: String(r.reason) })
				}
			}

			// D2: never flush after an aborted pass. Logout aborts in-flight sync (Phase 2)
			// and later wipes SQLite (Phase 6) — a late flush here would resurrect the
			// previous account's plaintext queue onto disk after the wipe. Mirrors the
			// chats sync fix.
			if (!signal.aborted) {
				await this.flushToDisk(useNotesInflightStore.getState().inflightContent)
			}
		})

		if (!result.success) {
			if (signal.aborted) {
				return
			}

			logger.error("notes-sync", "sync pass failed unexpectedly", { error: result.error })
			alerts.error(result.error)
		}
	}

	public syncDebounced(): void {
		this.syncTimeout?.cancel()

		this.syncTimeout = createExecutableTimeout(() => {
			this.sync().catch(e => logger.error("notes-sync", "unhandled exception in debounced sync", { error: e }))
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

		this.sync().catch(e => logger.error("notes-sync", "unhandled exception in executeNow sync", { error: e }))
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
