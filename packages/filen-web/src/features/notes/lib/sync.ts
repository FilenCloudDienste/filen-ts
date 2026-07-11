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
import useNotesInflightStore, { type InflightContent, type InflightEntry } from "@/features/notes/store/useNotesInflight"
import {
	hashNoteContent,
	buildInflightEntries,
	mergeInflight,
	inflightContentSchema,
	noteKindForPreview,
	isNetworkClassError,
	isRetryableAuthError,
	isNonSdkError,
	reconcileFollower,
	remoteEnqueueToPatch,
	newestEntry,
	type RemoteEnqueue,
	MAX_NON_RETRYABLE_REJECTIONS
} from "@/features/notes/lib/sync.logic"

const OUTBOX_KV_KEY = "inflightNoteContent"
const SYNC_DEBOUNCE_MS = 3000

// Multi-tab transport: a follower forwards edits to the leader and asks it to flush;
// the leader broadcasts authoritative state + a hello on takeover. The Sync class depends only on this
// seam — the wiring over a real BroadcastChannel lives in outboxCoordinator.ts; tests mock it. A
// single-tab install attaches NO transport, so every call below is a guarded no-op and the leader path
// stays byte-identical to the pre-multi-tab outbox.
export interface OutboxTransport {
	// follower → leader
	sendEnqueue: (msg: RemoteEnqueue) => void
	sendExecuteNow: () => void
	requestState: () => void
	// leader → followers
	broadcastState: (state: InflightContent) => void
	broadcastLeaderHello: () => void
}

// Read the abort flag through a function boundary so an early `if (signal.aborted) return` guard does
// not narrow later `signal.aborted` reads to a literal `false` (the signal is aborted externally by
// cancel(), mid-pass — the later checks are load-bearing, not redundant).
function isAborted(signal: AbortSignal): boolean {
	return signal.aborted
}

// A faithful port of filen-mobile's Sync class: the outbox that guarantees a note edit eventually
// reaches the server even across a window close, a lost connection, or a re-auth — fully fault-tolerant
// and idempotent (every push is a full-content overwrite). This web port adds a durable outbox, replay
// on launch, visibilitychange/reconnect triggers, and leader-owned multi-tab coordination on top of the
// mobile original.
//
// Leader-owned outbox across tabs: exactly one tab (the db-lock leader) runs the push loop and
// owns all disk persistence. A `role` of "leader" is the DEFAULT and its every code path is unchanged
// from the single-tab outbox, so a lone tab (and the whole unit battery, which never attaches a
// transport) behaves byte-identically. A follower tab flips `role` to "follower": its enqueue applies
// optimistically to the local store AND forwards to the leader, its executeNow forwards a flush
// request, and it never touches disk or runs the loop. On leader death the db lock hands leadership to
// a follower, which calls promoteToLeader() and runs the SAME replay-on-launch machinery.
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
	// how quickly a note's inflight entries get dropped (MAX_NON_RETRYABLE_REJECTIONS) so a one-off
	// transient error never loses the first edit, while a genuine permission rejection still
	// un-wedges the content query after N attempts.
	private readonly nonRetryableRejections: Map<string, number> = new Map<string, number>()

	// Multi-tab state. `role` defaults to "leader" so a lone tab and every unit test are the unchanged
	// single-tab path. `transport` is null until the coordinator wires a channel (single-tab: stays null,
	// every broadcast/forward below is a no-op). `unacked` is FOLLOWER-only: the edits this tab has
	// applied optimistically + forwarded but the leader has not yet confirmed via a state broadcast —
	// they win the follower's merge (so the optimistic edit is never lost) and are re-sent on takeover.
	private role: "leader" | "follower" = "leader"
	private transport: OutboxTransport | null = null
	private unacked: InflightContent = {}

	public constructor() {
		this.initPromise = new Promise(resolve => {
			this.resolveInit = resolve
		})
	}

	// The coordinator reads this to route incoming channel messages by CURRENT role (role flips live on
	// promotion), so a single dispatcher stays correct across a takeover.
	public get outboxRole(): "leader" | "follower" {
		return this.role
	}

	// Wire the multi-tab transport (coordinator only). Idempotent-friendly: a single-tab install never
	// calls this, leaving every forward/broadcast a guarded no-op.
	public attachTransport(transport: OutboxTransport): void {
		this.transport = transport
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

	// Drop a note's consecutive-rejection strike count. For the editor's use when it clears a
	// note's inflight OUTSIDE a push pass (a remote-edit reload / history restore) — those paths never
	// kick a pass, so the start-of-pass cleanup below would otherwise carry a stale count into the
	// next editing session and drop a fresh edit after a single failure.
	public clearRejections(noteUuid: string): void {
		this.nonRetryableRejections.delete(noteUuid)
	}

	// Drop a note's entire outbox entry OUTSIDE a push pass — the realtime remote-edit "reload" action
	// (the editor discards its unsynced local content to take the server's version). Dropping the entry
	// re-enables the note's content query (enabled: !inflight), so its remount key can advance and the
	// editor reseeds with fresh server content. The caller pairs this with clearRejections + flushToDisk
	// so the discard is durable and the next session starts with a clean strike count. Functional update:
	// a no-op when the note has no entry.
	public dropEntry(noteUuid: string): void {
		useNotesInflightStore.getState().setInflightContent(prev => {
			if (!(noteUuid in prev)) {
				return prev
			}

			const updated: InflightContent = {
				...prev
			}

			Reflect.deleteProperty(updated, noteUuid)

			return updated
		})
	}

	// Edit intake. Writes the outbox entry AND persists the WHOLE outbox to disk IMMEDIATELY, before
	// arming the debounce — the immediate-persist is THE survives-window-close guarantee (if the tab
	// dies during the 3s debounce, the edit is already durable and replays on next launch). Returns
	// the persist result so the editor can surface a failed disk write (an edit that survives in
	// memory only). `sessionBaseHash` is the hash of the editor's mount seed for a FRESH session;
	// omitting it takes the legacy no-conflict-check grace (see buildInflightEntries).
	public enqueue(note: Note, content: string, sessionBaseHash?: string | null): Promise<boolean> {
		if (this.role === "follower") {
			return this.followerEnqueue(note, content, sessionBaseHash ?? null)
		}

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

		// Broadcast to followers only AFTER the persist lands (single-tab: no-op) — a follower must
		// never treat an edit as confirmed before it is durable on the leader's disk (bounds the loss
		// window on a leader crash to "forwarded but not yet persisted", which the follower still holds).
		void flushed.then(() => {
			this.broadcastState()
		})

		this.syncDebounced()

		return flushed
	}

	// FOLLOWER enqueue: apply the edit to THIS tab's store optimistically (UI gating must not wait a
	// round trip), track it as unacked, and forward the newest entry to the leader. No disk write and no
	// debounce here — the leader owns both. Returns true: the optimistic apply cannot fail locally, and
	// durability is the leader's immediate-persist (a lost forward is re-sent on the next takeover).
	private followerEnqueue(note: Note, content: string, sessionBaseHash: string | null): Promise<boolean> {
		const entries = buildInflightEntries({
			previous: useNotesInflightStore.getState().inflightContent[note.uuid],
			note,
			content,
			now: Date.now(),
			sessionBaseHash
		})

		useNotesInflightStore.getState().setInflightContent(prev => ({
			...prev,
			[note.uuid]: entries
		}))

		this.unacked = {
			...this.unacked,
			[note.uuid]: entries
		}

		const latest = newestEntry(entries)

		if (latest !== undefined) {
			this.transport?.sendEnqueue(this.toRemoteEnqueue(latest))
		}

		return Promise.resolve(true)
	}

	// exactOptionalPropertyTypes: omit the base-hash key entirely when the entry carries none.
	private toRemoteEnqueue(entry: InflightEntry): RemoteEnqueue {
		return entry.baseContentHash !== undefined
			? { note: entry.note, content: entry.content, timestamp: entry.timestamp, baseContentHash: entry.baseContentHash }
			: { note: entry.note, content: entry.content, timestamp: entry.timestamp }
	}

	// LEADER: ingest an edit a follower forwarded. Merge it by its (follower-local) timestamp —
	// last-enqueue-wins per note, reusing mergeInflight — then persist and arm the debounce exactly like
	// a local enqueue, and broadcast the new authoritative state once it is durable. Two tabs editing the
	// same note collapse to the newest timestamp here; content is never merged (out of scope).
	public ingestRemoteEnqueue(msg: RemoteEnqueue): void {
		if (this.role !== "leader") {
			return
		}

		useNotesInflightStore.getState().setInflightContent(prev => mergeInflight(prev, remoteEnqueueToPatch(msg)))

		void this.flushToDisk(useNotesInflightStore.getState().inflightContent).then(() => {
			this.broadcastState()
		})

		this.syncDebounced()
	}

	// FOLLOWER: reconcile against the leader's authoritative state broadcast. Drops unacked entries the
	// leader has confirmed, keeps the ones it has not (they win the merge), and replaces the store with
	// the reconciled view so a leader-side drain (push landed) clears this tab's spinner too.
	public applyLeaderState(state: InflightContent): void {
		if (this.role !== "follower") {
			return
		}

		const reconciled = reconcileFollower(state, this.unacked)

		this.unacked = reconciled.unacked
		useNotesInflightStore.getState().setInflightContent(() => reconciled.store)
	}

	// FOLLOWER: on a new leader announcing itself, re-forward every still-unacked edit so an edit that
	// was in flight to (or lost by) the dead leader reaches the new one. Idempotent by timestamp.
	public resendUnacked(): void {
		if (this.role !== "follower") {
			return
		}

		for (const entries of Object.values(this.unacked)) {
			const latest = newestEntry(entries)

			if (latest !== undefined) {
				this.transport?.sendEnqueue(this.toRemoteEnqueue(latest))
			}
		}
	}

	// Broadcast the leader's current authoritative outbox to followers (no-op unless leader with a
	// transport). Called after every durable state change and on a follower's state request.
	public broadcastState(): void {
		if (this.role !== "leader") {
			return
		}

		this.transport?.broadcastState(useNotesInflightStore.getState().inflightContent)
	}

	// Follower start: adopt the follower role and ask the leader for its current state so a note another
	// tab already has pending shows its inflight (content-query gate, spinner) here too. Never touches
	// disk and never runs the loop — the leader owns both.
	public startAsFollower(): void {
		this.role = "follower"
		this.transport?.requestState()
	}

	// Promotion (this follower just won the db lock after the leader died). Flip to leader, announce so
	// any OTHER followers re-send their unacked, then run the EXISTING replay-on-launch machinery: our
	// optimistic edits already live in the store, and restoreFromDisk merges them with whatever the dead
	// leader persisted (mergeInflight), reconciles against the cloud, and pushes. restoreFromDisk only
	// kicks a push when DISK had content, so force one when the store holds carried-over optimistic work.
	public promoteToLeader(): void {
		this.role = "leader"
		// Our optimistic edits are authoritative now (they live in the store); clear the follower ledger.
		this.unacked = {}
		this.transport?.broadcastLeaderHello()

		void run(async () => {
			await this.restoreFromDisk()

			if (Object.keys(useNotesInflightStore.getState().inflightContent).length > 0) {
				this.executeNow()
			}

			this.broadcastState()
		})
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

		// Publish the restored/reconciled outbox so any follower already present reflects it (no-op
		// single-tab). A follower that joins later drives its own catch-up via requestState().
		this.broadcastState()

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

			// SINGLE-TAB SEAM: this loop is not yet gated behind the leader election used elsewhere in this
			// class (broadcastState/followerEnqueue) — that gating (only the elected tab flushes) is future
			// work. Today every authed tab runs its own loop.
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

					// Conflict DETECTION, never prevention — local edits always win and the push is
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
				// Followers learn a note drained (spinner clears) only from this post-push broadcast.
				this.broadcastState()
			}
		})

		if (!result.success) {
			if (isAborted(signal)) {
				return
			}

			log.error("notes-sync", "sync pass failed unexpectedly", result.error)
		}
	}

	// The 3s debounce trigger, armed on every edit.
	public syncDebounced(): void {
		this.syncTimeout?.cancel()

		this.syncTimeout = createExecutableTimeout(() => {
			this.syncTimeout = null

			void this.sync()
		}, SYNC_DEBOUNCE_MS)
	}

	// Fire any pending debounce now (visibilitychange → hidden, reconnect). Falls through to a
	// direct sync() when no debounce is queued — the cold-start + offline + reconnect case, where
	// restoreFromDisk's boot sync() bailed offline without arming a debounce, so the reconnect trigger
	// would otherwise have nothing to fire.
	public executeNow(): void {
		// Follower: the leader owns the loop — forward the flush request instead of running a pass here.
		if (this.role === "follower") {
			this.transport?.sendExecuteNow()

			return
		}

		if (this.syncTimeout) {
			this.syncTimeout.execute()

			return
		}

		void this.sync()
	}
}

export const sync = new Sync()
