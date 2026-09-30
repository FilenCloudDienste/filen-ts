import { useEffect } from "react"
import {
	run,
	createExecutableTimeout,
	MAX_NON_RETRYABLE_REJECTIONS,
	hashNoteContent,
	mergeInflight,
	pruneAndRebaseNoteOutboxAfterPush,
	reconcileNoteOutboxAgainstCloud
} from "@filen/shared"
import { onlineManager } from "@tanstack/react-query"
import notes from "@/features/notes/notes"
import alerts from "@/lib/alerts"
import i18n from "@/lib/i18n"
import { noteDisplayTitle } from "@/lib/decryption"
import { AppState } from "react-native"
import useNotesInflightStore, {
	type InflightContent,
	INFLIGHT_CONTENT_SQLITE_KV_KEY,
	hasInflightEntries,
	newestInflightEntry
} from "@/features/notes/store/useNotesInflight.store"
import { type Note } from "@/types"
import sqlite from "@/lib/sqlite"
import { fetchData as notesQueryFetch, notesQueryGet } from "@/features/notes/queries/useNotesQuery"
import { noteContentQueryUpdate, noteContentQueryDataUpdatedAt } from "@/features/notes/queries/useNoteContent.query"
import { isPermanentSdkRejection } from "@/lib/sdkErrors"
import logger from "@/lib/logger"
import events from "@/lib/events"
import { whenUnlockedForeground } from "@/lib/unlockedForeground"
import { OutboxSync } from "@/lib/outboxSync"

// The note's newest outbox entry, when it was typed on `base` (none left, or rebased: undefined).
function newestEntryOnBase(noteUuid: string, base: string): InflightContent[string][number] | undefined {
	const newest = newestInflightEntry(useNotesInflightStore.getState().inflightContent[noteUuid])

	return newest?.baseContentHash === base ? newest : undefined
}

// Waits between re-drives of a failed push: 30s, 2m, then every 10m.
export const PUSH_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const

export class Sync extends OutboxSync<InflightContent> {
	private syncTimeout: ReturnType<typeof createExecutableTimeout> | null = null
	// VC3: per-note count of CONSECUTIVE non-network, non-auth SDK rejections. Transient (in
	// memory only — never persisted to disk), reset on any successful sync or when the note's
	// inflight is dropped/drained. Bounds the #40 drop so a one-off `Server` error never loses
	// the first edit, while a genuine permission rejection still un-wedges after N attempts.
	private readonly nonRetryableRejections: Map<string, number> = new Map<string, number>()
	// Notes whose remote-edit prompt is open, by open prompt count: passes leave them alone, so the answer
	// decides what the cloud holds rather than a debounce firing under the prompt.
	private readonly holds: Map<string, number> = new Map<string, number>()
	// Each note the running pass is working on, from its conflict peek until its push is recorded.
	private readonly passes: Map<string, Promise<void>> = new Map<string, Promise<void>>()
	// Notes open in an editor, by editor count: one of them answers an edit made elsewhere that a pass finds.
	private readonly editors: Map<string, number> = new Map<string, number>()
	// Notes a pass handed an edit made elsewhere to their editor, until a push of them lands.
	private readonly handedOff: Set<string> = new Set<string>()
	// When each note's last successful conflict peek began.
	private readonly peeks: Map<string, number> = new Map<string, number>()
	// Notes whose last push failed in a way the next attempt can fix (network, session), re-driven on a
	// backoff timer (scheduleRetry): the one exception to the SDK owning retries, so an edit does not wait
	// for the next keystroke, foreground or reconnect. A rejection counted toward the drop bound is not.
	private readonly failed: Set<string> = new Set<string>()
	private retryTimer: ReturnType<typeof setTimeout> | null = null
	// Which of PUSH_RETRY_DELAYS_MS the next re-drive waits; back to the first after any push lands.
	private retryStep = 0
	private pushLanded = false

	public constructor() {
		super({
			sqliteKvKey: INFLIGHT_CONTENT_SQLITE_KV_KEY,
			logScope: "notes-sync"
		})
	}

	public override cancel(): void {
		this.syncTimeout?.cancel()
		this.syncTimeout = null
		super.cancel()
		this.failed.clear()
		this.retryStep = 0
		this.pushLanded = false
		this.pauseRetry()
	}

	// No re-drive pending: in the background, offline, or on the way out. What resumes it (foreground,
	// reconnect) runs a pass, which schedules again.
	public pauseRetry(): void {
		if (this.retryTimer !== null) {
			clearTimeout(this.retryTimer)
			this.retryTimer = null
		}
	}

	// After a pass: one timer for the whole sync, and only while a push failed, the app is in front and online.
	private scheduleRetry(): void {
		const inflightContent = useNotesInflightStore.getState().inflightContent

		// A failed note whose edits went since (loaded over, deleted) needs nothing more.
		for (const noteUuid of this.failed) {
			if (!hasInflightEntries(inflightContent, noteUuid)) {
				this.failed.delete(noteUuid)
			}
		}

		if (this.pushLanded || this.failed.size === 0) {
			this.retryStep = 0
		}

		this.pushLanded = false
		this.pauseRetry()

		if (this.failed.size === 0 || AppState.currentState !== "active" || !onlineManager.isOnline()) {
			return
		}

		const delay = PUSH_RETRY_DELAYS_MS[Math.min(this.retryStep, PUSH_RETRY_DELAYS_MS.length - 1)] ?? 600_000

		this.retryTimer = setTimeout(() => {
			this.retryTimer = null

			// Backgrounded or offline meanwhile (Android keeps JS timers running): the foreground or reconnect
			// re-drives it.
			if (AppState.currentState !== "active" || !onlineManager.isOnline()) {
				return
			}

			this.retryStep++
			// The normal mutexed pass (a pending debounce runs now instead): never a second push of a note.
			this.executeNow()
		}, delay)
	}

	// Drops a note's unsynced edits outside a sync pass (remote-edit reload, restoreFromHistory) so no pass
	// pushes them over the version being loaded. VC3: resets its strike count too — no pass sees the empty
	// state to clear it, so the next editing session would otherwise drop a fresh edit after one failure.
	public async discardInflight(noteUuid: string): Promise<boolean> {
		useNotesInflightStore.getState().setInflightContent(prev => {
			const updated = {
				...prev
			}

			delete updated[noteUuid]

			return updated
		})

		this.nonRetryableRejections.delete(noteUuid)

		return await this.flushToDisk(useNotesInflightStore.getState().inflightContent)
	}

	// The note is open in an editor until the returned detach(), which answers edits made elsewhere that a
	// pass's conflict peek finds (noteContentEdited) instead of the pass pushing over them.
	public attachEditor(noteUuid: string): () => void {
		this.editors.set(noteUuid, (this.editors.get(noteUuid) ?? 0) + 1)

		let detached = false

		return () => {
			if (detached) {
				return
			}

			detached = true

			const count = (this.editors.get(noteUuid) ?? 1) - 1

			if (count > 0) {
				this.editors.set(noteUuid, count)

				return
			}

			this.editors.delete(noteUuid)

			// An edit made elsewhere a pass handed over may have gone unanswered: the next pass pushes over it,
			// with the overwrite toast, rather than the edits waiting for an unrelated trigger.
			if (this.handedOff.has(noteUuid) && hasInflightEntries(useNotesInflightStore.getState().inflightContent, noteUuid)) {
				this.syncDebounced()
			}
		}
	}

	// Whether a conflict peek of the note began at or after `since` and read the cloud: a check after a
	// socket reconnect has nothing to add then (the peek found no edit, or handed it to the editor).
	public peekedSince(noteUuid: string, since: number): boolean {
		return (this.peeks.get(noteUuid) ?? -1) >= since
	}

	// Keeps passes off a note until release(). `settled` resolves once a pass already working on it (its
	// conflict peek, then its push) has finished and been recorded, so what is read after it is what the
	// server ended with.
	public hold(noteUuid: string): { settled: Promise<void>; release: () => void } {
		this.holds.set(noteUuid, (this.holds.get(noteUuid) ?? 0) + 1)

		let released = false
		const ignore = () => undefined

		return {
			settled: (this.passes.get(noteUuid) ?? Promise.resolve()).then(ignore, ignore),
			release: () => {
				if (released) {
					return
				}

				released = true

				const count = (this.holds.get(noteUuid) ?? 1) - 1

				if (count > 0) {
					this.holds.set(noteUuid, count)

					return
				}

				this.holds.delete(noteUuid)

				// A pass skipped the note meanwhile: its edits would otherwise wait for the next keystroke.
				if (hasInflightEntries(useNotesInflightStore.getState().inflightContent, noteUuid)) {
					this.syncDebounced()
				}
			}
		}
	}

	protected override async restoreFromDisk(): Promise<void> {
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
		const result = await run(() =>
			this.mutex.withPermit(async () => {
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
					const signal = this.abortController.signal

					// Metadata-only list: tells us which disk-seeded notes still exist in the cloud.
					// Content is no longer carried by the list — fetch it on demand below, and ONLY
					// for the notes that actually have disk-seeded inflight (never the whole account;
					// the old bulk per-note getNoteContent fan-out is exactly what we removed).
					const cloudNotes = await notesQueryFetch({ signal })
					const cloudByUuid = new Map<string, Note>()

					for (const note of cloudNotes) {
						cloudByUuid.set(note.uuid, note)
					}

					// Per-note content, fetched only for disk-inflight notes that still exist. A
					// failed fetch leaves the entry untouched (availability beats reconcile — the
					// next sync pass re-pushes it) rather than being pruned or dropped.
					const contentByUuid = new Map<string, string>()

					await Promise.all(
						Object.keys(fromDisk).map(async noteUuid => {
							const note = cloudByUuid.get(noteUuid)

							if (!note) {
								return
							}

							try {
								const cloudContent = await notes.getContent({ note, signal })

								// `undefined` means the body EXISTS but could not be decrypted — an empty
								// note returns "". Coalescing it to "" would make the prune below read a
								// deliberate "I cleared this note" draft as already-synced and discard it.
								// Treat it like a failed fetch: keep the entry, let the next pass decide.
								if (typeof cloudContent === "string") {
									contentByUuid.set(noteUuid, cloudContent)
								}
							} catch (e) {
								logger.warn("notes-sync", "restore reconcile: getContent failed; keeping inflight entry", {
									noteUuid,
									error: e
								})
							}
						})
					)

					// #4 principle applied to restore: drop a disk-seeded inflight entry already synced with
					// the cloud or orphaned (note gone) — see notesOutboxReconcile.ts for the full rule. Applied
					// as a functional update so any edit made during the fetch is preserved.
					useNotesInflightStore
						.getState()
						.setInflightContent(prev =>
							reconcileNoteOutboxAgainstCloud(prev, Object.keys(fromDisk), new Set(cloudByUuid.keys()), contentByUuid)
						)
				})

				if (!reconcile.success) {
					logger.warn("notes-sync", "cloud reconcile after restore failed; stale inflight entries may persist", {
						error: reconcile.error
					})
				}

				return true
			})
		)

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

	private sync(): Promise<void> {
		return this.runPass(
			async signal => {
				const inflightContent = useNotesInflightStore.getState().inflightContent

				if (Object.keys(inflightContent).length === 0) {
					this.nonRetryableRejections.clear()

					return null
				}

				// VC3: drop stale rejection counters for notes whose inflight is gone (drained,
				// cleared via the remote-edit reload, or pruned on reconcile). Otherwise a fresh
				// edit on a previously-rejected note would inherit a stale count and lose part of
				// its retry budget.
				for (const trackedUuid of this.nonRetryableRejections.keys()) {
					if (!hasInflightEntries(inflightContent, trackedUuid)) {
						this.nonRetryableRejections.delete(trackedUuid)
					}
				}

				// D3: one overwrite toast per note per pass. Each note is pushed at most once per
				// pass anyway (only its most recent entry goes out), so this is belt-and-braces
				// against ever stacking duplicate toasts for the same note.
				const toastedConflicts = new Set<string>()

				const results = await Promise.allSettled(
					Object.entries(inflightContent).map(async ([noteUuid, contents]) => {
						if (signal.aborted || this.holds.has(noteUuid)) {
							return
						}

						const mostRecentContent = newestInflightEntry(contents)

						if (!mostRecentContent) {
							return
						}

						let finishPass: () => void = () => undefined

						this.passes.set(
							noteUuid,
							new Promise<void>(resolve => {
								finishPass = resolve
							})
						)

						try {
							await this.pushNote(noteUuid, mostRecentContent, signal, toastedConflicts)
						} finally {
							this.passes.delete(noteUuid)
							finishPass()
						}
					})
				)

				for (const r of results) {
					if (r.status === "rejected") {
						logger.error("notes-sync", "failed to sync note in pass", { reason: String(r.reason) })
					}
				}

				return useNotesInflightStore.getState().inflightContent
			},
			() => this.scheduleRetry()
		)
	}

	// One note's share of a pass: its conflict peek, then its push. Registered in `passes` by the caller.
	private async pushNote(
		noteUuid: string,
		snapshot: InflightContent[string][number],
		signal: AbortSignal,
		toastedConflicts: Set<string>
	): Promise<void> {
		// #34 fix: resolve the live note from the query cache so that any
		// metadata changes (type, participants, encryptionKey) that arrived
		// via socket between the render-time snapshot and the debounce flush
		// are reflected in the setContent call. Fall back to the snapshot
		// if the note is no longer in the cache (e.g. concurrently deleted).
		const cachedNotes = notesQueryGet()
		const liveNote = cachedNotes?.find(n => n.uuid === noteUuid) ?? snapshot.note

		// D3: conflict DETECTION, never prevention — local edits win and the push below
		// goes out (user decision: no blocking), except for a note open in an editor,
		// whose user is asked instead, as over an edit the socket reported. When
		// the entry carries its session's base hash, peek at the note's current cloud
		// content first: if the cloud moved past our base AND past what we are about
		// to write, this push buries someone else's newer work in the note's history,
		// and the user must hear about it once — a silent overwrite ("users won't
		// know history has it") is the failure being prevented. Entries WITHOUT a
		// base hash (persisted by older app versions) push unchecked — a one-time
		// grace instead of migration machinery. A failed peek also pushes unchecked:
		// availability beats the toast.
		let mostRecentContent = snapshot
		// What the peek read (undecryptable reads as ""), undefined when there was no peek or it failed.
		let cloudContent: string | undefined
		let cloudDecrypted = false

		if (snapshot.baseContentHash !== undefined) {
			const peekStartedAt = Date.now()

			try {
				const peeked = await notes.getContent({ note: liveNote, signal })

				cloudContent = peeked ?? ""
				cloudDecrypted = typeof peeked === "string"
			} catch (e) {
				// Availability beats the toast — push without the check.
				logger.warn("notes-sync", "conflict-detection peek failed; pushing without overwrite check", {
					noteUuid,
					error: e
				})
			}

			// A prompt opened during the peek.
			if (this.holds.has(noteUuid)) {
				return
			}

			// Only a peek this pass acted on counts: one abandoned under a hold found nothing out.
			if (cloudContent !== undefined) {
				this.peeks.set(noteUuid, peekStartedAt)
			}

			// Its answer, or typing, may have changed the outbox meanwhile. Typing on the same base leaves the
			// peek valid, so the newest entry goes out; a discard (Load theirs) or a rebase (Keep mine) leaves
			// nothing to push here, and the release schedules the pass that pushes on the new base.
			const newest = newestEntryOnBase(noteUuid, snapshot.baseContentHash)

			if (newest === undefined) {
				return
			}

			mostRecentContent = newest
		}

		// #4 fix: capture the LOCAL author-time of the entry we are about to
		// push BEFORE the await. The prune below must remove exactly the
		// content we actually sent (and strictly-older entries), never use the
		// server's `editedTimestamp`. The two are different clocks in the same
		// unit (`timestamp` is local Date.now() author-time; `editedTimestamp`
		// is the server's response time), so pruning by the server clock
		// silently discards every keystroke typed during the in-flight
		// setContent round trip (their local timestamp falls below the server
		// time). Comparing local-vs-local preserves those edits for the
		// rescheduled debounce and is immune to device-clock skew. Captured once the entry to push is
		// settled: typing during the peek pushes the newest.
		const syncedUpTo = mostRecentContent.timestamp
		const overwritesNewerRemoteContent =
			cloudContent !== undefined &&
			hashNoteContent(cloudContent) !== mostRecentContent.baseContentHash &&
			cloudContent !== mostRecentContent.content

		// The note is open in an editor: its user decides, as over an edit the socket reported (the socket
		// was down, say, while the app was in the background). Nothing is pushed until they answer.
		if (overwritesNewerRemoteContent && cloudDecrypted && cloudContent !== undefined && this.editors.has(noteUuid)) {
			this.handedOff.add(noteUuid)

			events.emit("noteContentEdited", {
				noteUuid,
				content: cloudContent
			})

			return
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
			if (!isPermanentSdkRejection(e)) {
				// Re-driven on the backoff timer; an aborted pass (logout) is not a failure.
				if (!signal.aborted) {
					this.failed.add(noteUuid)
				}

				throw e
			}

			// Counted toward the drop bound: never re-driven by the timer, which would only hasten the drop.
			this.failed.delete(noteUuid)

			const previousRejections = this.nonRetryableRejections.get(noteUuid) ?? 0
			const rejections = previousRejections + 1

			if (rejections < MAX_NON_RETRYABLE_REJECTIONS) {
				this.nonRetryableRejections.set(noteUuid, rejections)

				logger.warn("notes-sync", "non-retryable SDK rejection on setContent; will retry", {
					noteUuid,
					rejections,
					maxRejections: MAX_NON_RETRYABLE_REJECTIONS,
					error: e
				})

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

			logger.error("notes-sync", "dropping inflight content after max non-retryable rejections; edit lost", {
				noteUuid,
				rejections,
				error: e
			})

			return
		}

		// A successful push clears any accumulated rejection count for this note.
		this.nonRetryableRejections.delete(noteUuid)
		this.handedOff.delete(noteUuid)
		this.failed.delete(noteUuid)
		this.pushLanded = true

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

			const remaining = pruneAndRebaseNoteOutboxAfterPush(updated[noteUuid], syncedUpTo, pushedContentHash)

			if (remaining === undefined) {
				delete updated[noteUuid]
			} else {
				updated[noteUuid] = remaining
			}

			return updated
		})

		// D3: toast only AFTER the push landed (a failed push overwrites nothing and
		// is retried — the next pass re-detects), once per note per pass, and never
		// for an aborted pass (logout must stay silent).
		if (overwritesNewerRemoteContent && !signal.aborted && !toastedConflicts.has(noteUuid)) {
			toastedConflicts.add(noteUuid)

			const message = i18n.t("note_overwrote_newer_remote_changes", {
				name: noteDisplayTitle(liveNote)
			})

			// Never over the biometric lock, nor from the background (Android toasts show over other apps).
			void whenUnlockedForeground().then(() => {
				if (!signal.aborted) {
					alerts.normal(message)
				}
			})
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
				// No re-drive waits out the background; the pass on return schedules one again.
				if (nextAppState === "background") {
					sync.pauseRetry()
				}

				sync.executeNow()

				return
			}
		})

		return () => {
			appStateListener.remove()
			sync.pauseRetry()
		}
	}, [])

	return null
}

export default SyncHost
