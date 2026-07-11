import { run, Semaphore, createExecutableTimeout, createNotePreviewFromContentText } from "@filen/utils"
import { onlineManager } from "@tanstack/react-query"
import type { Note } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { i18n } from "@/lib/i18n"
import { log } from "@/lib/log"
import { toast } from "sonner"
import { kvGetJson, kvSetJson, kvDelete } from "@/lib/storage/adapter"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { fetchNotes, notesQueryGet } from "@/features/notes/queries/notes"
import useNotesInflightStore, { type InflightContent } from "@/features/notes/store/useNotesInflight"
import {
	hashNoteContent,
	buildInflightEntries,
	mergeInflight,
	inflightContentSchema,
	noteKindForPreview,
	isNetworkClassError,
	isRetryableAuthError,
	isNonSdkError,
	MAX_NON_RETRYABLE_REJECTIONS
} from "@/features/notes/lib/sync.logic"

const OUTBOX_KV_KEY = "inflightNoteContent"
const SYNC_DEBOUNCE_MS = 3000

// Read the abort flag through a function boundary so an early `if (signal.aborted) return` guard does
// not narrow later `signal.aborted` reads to a literal `false` (the signal is aborted externally by
// cancel(), mid-pass — the later checks are load-bearing, not redundant).
function isAborted(signal: AbortSignal): boolean {
	return signal.aborted
}

// A faithful single-tab port of filen-mobile's Sync class: the outbox that guarantees a note edit
// eventually reaches the server even across a window close, a lost connection, or a re-auth — fully
// fault-tolerant and idempotent (every push is a full-content overwrite). Adaptations from the mobile
// original are named inline (A durable outbox, C replay-on-launch, D triggers). The push loop is
// SINGLE-TAB scoped for now; a multi-tab leader election (only the leader flushes) is a later wave —
// the seam is marked where the loop begins.
export class Sync {
	// Serializes restore/flush/push so a reconcile write never races a push prune. mutex(1) === mobile.
	private readonly mutex: Semaphore = new Semaphore(1)
	private syncTimeout: ReturnType<typeof createExecutableTimeout> | null = null
	private readonly initPromise: Promise<void>
	private resolveInit!: () => void
	// The outbox never cancels a push in flight (no AbortSignal on the wasm note ops) — this signal
	// only gates the LOOP: it stops new pushes from starting and suppresses any post-abort disk write,
	// so a logout wipe is never resurrected by a late flush.
	private abortController: AbortController = new AbortController()
	// Per-note count of CONSECUTIVE non-network, non-auth SDK rejections. In-memory only (never
	// persisted), reset on any successful push or when the note's inflight is dropped/drained. Bounds
	// the #40 drop so a one-off transient error never loses the first edit, while a genuine permission
	// rejection still un-wedges the content query after N attempts.
	private readonly nonRetryableRejections: Map<string, number> = new Map<string, number>()

	public constructor() {
		this.initPromise = new Promise(resolve => {
			this.resolveInit = resolve
		})
	}

	// Adaptation C: replay-on-launch. Mounted once in the authed shell (SyncHost), never per route.
	public start(): void {
		void this.restoreFromDisk()
	}

	// Wired into the logout path BEFORE the local wipe: abort the loop and suppress further disk
	// writes. A fresh AbortController is installed so a subsequent start() (a later login in the same
	// tab, though logout reloads) is not permanently aborted.
	public cancel(): void {
		this.syncTimeout?.cancel()
		this.syncTimeout = null
		this.abortController.abort()
		this.abortController = new AbortController()
	}

	// Drop a note's consecutive-rejection strike count. For the editor wave's use when it clears a
	// note's inflight OUTSIDE a push pass (a remote-edit reload / history restore) — those paths never
	// kick a pass, so the start-of-pass cleanup below would otherwise carry a stale count into the
	// next editing session and drop a fresh edit after a single failure.
	public clearRejections(noteUuid: string): void {
		this.nonRetryableRejections.delete(noteUuid)
	}

	// Edit intake. Writes the outbox entry AND persists the WHOLE outbox to disk IMMEDIATELY, before
	// arming the debounce — the immediate-persist is THE survives-window-close guarantee (if the tab
	// dies during the 3s debounce, the edit is already durable and replays on next launch). Returns
	// the persist result so the editor wave can surface a failed disk write (an edit that survives in
	// memory only). `sessionBaseHash` is the hash of the editor's mount seed for a FRESH session;
	// omitting it takes the legacy no-conflict-check grace (see buildInflightEntries).
	public enqueue(note: Note, content: string, sessionBaseHash?: string | null): Promise<boolean> {
		useNotesInflightStore.getState().setInflightContent(prev => ({
			...prev,
			[note.uuid]: buildInflightEntries({
				previous: prev[note.uuid],
				note,
				content,
				now: Date.now(),
				sessionBaseHash: sessionBaseHash ?? null
			})
		}))

		// Persist FIRST (durability), then arm the debounce.
		const flushed = this.flushToDisk(useNotesInflightStore.getState().inflightContent)

		this.syncDebounced()

		return flushed
	}

	// Adaptation A: durable outbox via the kv adapter. Reports persistence failure as `false` instead
	// of throwing (it never throws). Sync-internal callers ignore the return (the next pass
	// re-flushes); the enqueue call site surfaces a `false`.
	public async flushToDisk(inflightContent: InflightContent): Promise<boolean> {
		await this.initPromise

		const result = await run(async () => {
			if (Object.keys(inflightContent).length === 0) {
				await kvDelete(OUTBOX_KV_KEY)

				return
			}

			await kvSetJson(OUTBOX_KV_KEY, inflightContent)
		})

		if (!result.success) {
			log.error("notes-sync", "flushToDisk failed; in-flight edit not persisted", result.error)
		}

		return result.success
	}

	// Adaptation C: the ONLY disk→store bridge, so it MUST hydrate the store even with no network.
	// (1) hydrate UNCONDITIONALLY via a functional merge before any network call — an offline boot
	// must not strand persisted edits. (2) reconcile against the cloud best-effort only when online;
	// a failure there must NOT undo the hydration. Then kick sync() if the STORE still holds pending
	// work (driven by the store, never the fetch result, so offline-restored inflight is queued for
	// the reconnect trigger).
	private async restoreFromDisk(): Promise<void> {
		const result = await run(async defer => {
			await this.mutex.acquire()

			defer(() => {
				this.mutex.release()
			})

			const fromDisk = await kvGetJson(OUTBOX_KV_KEY, inflightContentSchema)

			if (!fromDisk || Object.keys(fromDisk).length === 0) {
				return false
			}

			// (1) Hydrate before any network call, merging into the current store.
			useNotesInflightStore.getState().setInflightContent(prev => mergeInflight(prev, fromDisk))

			// (2) Reconcile only when online.
			if (!onlineManager.isOnline()) {
				return true
			}

			const reconcile = await run(async () => {
				const cloudNotes = await fetchNotes()
				const cloudByUuid = new Map<string, Note>()

				for (const note of cloudNotes) {
					cloudByUuid.set(note.uuid, note)
				}

				// Drop a disk-seeded entry only when its content EQUALS the freshly-fetched cloud
				// content (already synced), and drop entries for notes no longer in the cloud
				// (deleted / no longer accessible). Compare content, never mix local and server clocks.
				// The web list query carries no content, so cloud content is fetched per inflight note.
				const cloudContentByUuid = new Map<string, string>()

				for (const noteUuid of Object.keys(fromDisk)) {
					const cloudNote = cloudByUuid.get(noteUuid)

					if (!cloudNote) {
						continue
					}

					cloudContentByUuid.set(noteUuid, (await sdkApi.getNoteContent(cloudNote)) ?? "")
				}

				// Applied as a functional update so any edit made during the fetch is preserved.
				useNotesInflightStore.getState().setInflightContent(prev => {
					const updated: InflightContent = {
						...prev
					}

					for (const noteUuid of Object.keys(fromDisk)) {
						const entries = updated[noteUuid]

						if (!entries) {
							continue
						}

						if (!cloudByUuid.has(noteUuid)) {
							Reflect.deleteProperty(updated, noteUuid)

							continue
						}

						const cloudContent = cloudContentByUuid.get(noteUuid) ?? ""
						const remaining = entries.filter(c => c.content !== cloudContent)

						if (remaining.length === 0) {
							Reflect.deleteProperty(updated, noteUuid)

							continue
						}

						updated[noteUuid] = remaining
					}

					return updated
				})
			})

			if (!reconcile.success) {
				log.warn("notes-sync", "cloud reconcile after restore failed; stale inflight entries may persist", reconcile.error)
			}

			return true
		})

		if (!result.success) {
			log.error("notes-sync", "restoreFromDisk failed; unsaved edits from previous session may be lost", result.error)
		}

		this.resolveInit()

		// Kick sync() only when disk had content AND the store still holds pending work. sync() itself
		// gates on isOnline(), so calling it offline is a safe no-op that leaves the queue for reconnect.
		if (result.data && Object.keys(useNotesInflightStore.getState().inflightContent).length > 0) {
			void this.sync()
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
				this.nonRetryableRejections.clear()

				return
			}

			// Drop stale rejection counters for notes whose inflight is gone, so a fresh edit on a
			// previously-rejected note never inherits a stale count and loses part of its retry budget.
			for (const trackedUuid of this.nonRetryableRejections.keys()) {
				const entries = inflightContent[trackedUuid]

				if (!entries || entries.length === 0) {
					this.nonRetryableRejections.delete(trackedUuid)
				}
			}

			// One overwrite toast per note per pass (belt-and-braces: each note is pushed at most once).
			const toastedConflicts = new Set<string>()

			// SINGLE-TAB SEAM: the multi-tab leader adaptation gates this loop behind a leader election
			// (only the elected tab flushes) — a later wave. Today every authed tab runs its own loop.
			const results = await Promise.allSettled(
				Object.entries(inflightContent).map(async ([noteUuid, contents]) => {
					if (isAborted(signal)) {
						return
					}

					if (contents.length === 0) {
						return
					}

					const mostRecentContent = [...contents].sort((a, b) => b.timestamp - a.timestamp).at(0)

					if (!mostRecentContent) {
						return
					}

					// Resolve the LIVE note from the list cache so metadata that arrived via socket/
					// refetch (type, participants, encryption key) between the edit-time snapshot and
					// this flush is reflected in the push. Fall back to the snapshot if the note has
					// left the cache (concurrently deleted).
					const liveNote = notesQueryGet()?.find(n => n.uuid === noteUuid) ?? mostRecentContent.note

					// Capture the LOCAL author-time of the entry we are about to push BEFORE the await.
					// The prune below removes exactly what we sent (and strictly-older entries) by this
					// local clock — never the server's editedTimestamp, which would silently discard
					// every keystroke typed during the in-flight round trip.
					const syncedUpTo = mostRecentContent.timestamp

					// D3: conflict DETECTION, never prevention — local edits always win and the push is
					// unconditional. When the entry carries its session base hash, peek at the note's
					// current cloud content: if the cloud moved past our base AND past what we are about
					// to write, this push buries newer remote work and the user hears about it once.
					// Entries without a base hash push unchecked (legacy grace); a failed peek also
					// pushes unchecked (availability beats the toast).
					let overwritesNewerRemoteContent = false

					if (mostRecentContent.baseContentHash !== undefined) {
						const peek = await run(async () => (await sdkApi.getNoteContent(liveNote)) ?? "")

						if (peek.success) {
							overwritesNewerRemoteContent =
								hashNoteContent(peek.data) !== mostRecentContent.baseContentHash && peek.data !== mostRecentContent.content
						} else {
							log.warn("notes-sync", "conflict-detection peek failed; pushing without overwrite check", noteUuid, peek.error)
						}
					}

					const push = await run(async () => {
						const preview = createNotePreviewFromContentText(noteKindForPreview(liveNote.noteType), mostRecentContent.content)

						await sdkApi.setNoteContent(liveNote, mostRecentContent.content, preview)
					})

					if (!push.success) {
						// KEEP-for-retry on a network-class error, a retryable-auth error, or any non-SDK
						// throw — re-throw so allSettled records it and the entry survives to the next pass
						// (offline-safe, never counted toward the drop). For any OTHER SDK error bound the
						// drop: increment a per-note consecutive-rejection counter and only drop once it
						// reaches MAX_NON_RETRYABLE_REJECTIONS — a one-off transient keeps the edit, a
						// genuine read-only/permission rejection un-wedges the query after N attempts.
						const e = push.error

						if (isNonSdkError(e) || isNetworkClassError(e) || isRetryableAuthError(e)) {
							throw e
						}

						const rejections = (this.nonRetryableRejections.get(noteUuid) ?? 0) + 1

						if (rejections < MAX_NON_RETRYABLE_REJECTIONS) {
							this.nonRetryableRejections.set(noteUuid, rejections)

							log.warn("notes-sync", "non-retryable SDK rejection on setNoteContent; will retry", noteUuid, rejections, e)

							throw e
						}

						this.nonRetryableRejections.delete(noteUuid)

						useNotesInflightStore.getState().setInflightContent(prev => {
							const updated: InflightContent = {
								...prev
							}

							Reflect.deleteProperty(updated, noteUuid)

							return updated
						})

						log.error("notes-sync", "dropping inflight content after max non-retryable rejections; edit lost", noteUuid, e)

						return
					}

					// A successful push clears any accumulated rejection count for this note.
					this.nonRetryableRejections.delete(noteUuid)

					// The pushed content IS the cloud content now — write it into the per-note content
					// query cache so an editor reseed after the queue drains paints what the user typed,
					// never the stale pre-edit cache. dataUpdatedAt is PRESERVED so the editor's remount
					// key (this timestamp) does not advance and reset the cursor after every push.
					const contentKey = noteContentQueryKey(noteUuid)
					const previousUpdatedAt = queryClient.getQueryState<string | undefined>(contentKey)?.dataUpdatedAt

					queryClient.setQueryData<string>(
						contentKey,
						mostRecentContent.content,
						previousUpdatedAt !== undefined ? { updatedAt: previousUpdatedAt } : undefined
					)

					// The content we just pushed IS the cloud content now, so it becomes the base for
					// every entry typed during the round trip (they survive the prune). Without this the
					// next pass would flag our OWN push as a conflict against their stale session base.
					const pushedContentHash = hashNoteContent(mostRecentContent.content)

					useNotesInflightStore.getState().setInflightContent(prev => {
						const updated: InflightContent = {
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
								Reflect.deleteProperty(updated, noteUuid)
							} else {
								updated[noteUuid] = remaining
							}
						}

						return updated
					})

					// Toast only AFTER the push landed (a failed push overwrites nothing and is retried),
					// once per note per pass, and never for an aborted pass (logout stays silent).
					if (overwritesNewerRemoteContent && !isAborted(signal) && !toastedConflicts.has(noteUuid)) {
						toastedConflicts.add(noteUuid)

						const name =
							liveNote.title !== undefined && liveNote.title.length > 0 ? liveNote.title : i18n.t("notes:noteUntitled")

						toast(i18n.t("notes:noteOverwroteNewerRemoteChanges", { name }))
					}
				})
			)

			for (const r of results) {
				if (r.status === "rejected") {
					log.error("notes-sync", "failed to sync note in pass", String(r.reason))
				}
			}

			// Never flush after an aborted pass: logout aborts the loop and then wipes kv — a late flush
			// here would resurrect the previous account's plaintext queue onto disk after the wipe.
			if (!isAborted(signal)) {
				await this.flushToDisk(useNotesInflightStore.getState().inflightContent)
			}
		})

		if (!result.success) {
			if (isAborted(signal)) {
				return
			}

			log.error("notes-sync", "sync pass failed unexpectedly", result.error)
		}
	}

	// D3: the 3s debounce trigger, armed on every edit.
	public syncDebounced(): void {
		this.syncTimeout?.cancel()

		this.syncTimeout = createExecutableTimeout(() => {
			this.syncTimeout = null

			void this.sync()
		}, SYNC_DEBOUNCE_MS)
	}

	// D3: fire any pending debounce now (visibilitychange → hidden, reconnect). Falls through to a
	// direct sync() when no debounce is queued — the cold-start + offline + reconnect case, where
	// restoreFromDisk's boot sync() bailed offline without arming a debounce, so the reconnect trigger
	// would otherwise have nothing to fire.
	public executeNow(): void {
		if (this.syncTimeout) {
			this.syncTimeout.execute()

			return
		}

		void this.sync()
	}
}

export const sync = new Sync()
