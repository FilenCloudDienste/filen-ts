import {
	run,
	Semaphore,
	createExecutableTimeout,
	createNotePreviewFromContentText,
	isPermanentRejection,
	pruneAndRebaseNoteOutboxAfterPush,
	reconcileNoteOutboxAgainstCloud
} from "@filen/shared"
import { onlineManager } from "@tanstack/react-query"
import type { Note } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { i18n } from "@/lib/i18n"
import { forgetNotePushes, rememberNotePush } from "@/features/notes/lib/pushEchoes"
import { heldNotes, releaseAllNoteHolds } from "@/features/notes/lib/remoteEditHolds"
import { forgetTabEditors, tabEditorLanded, tabEditorPushed } from "@/features/notes/lib/tabEditors"
import { followContent } from "@/features/notes/lib/remoteContent"
import { log } from "@/lib/log"
import { toast } from "sonner"
import { asErrorDTO } from "@/lib/sdk/errors"
import { kvGetJson, kvSetJson, kvDelete } from "@/lib/storage/adapter"
import { type OutboxChannelTransport, type OutboxRole, type PushDetail } from "@/lib/storage/outboxChannel"
import { noteContentQueryKey, readNoteContent } from "@/features/notes/queries/noteContent"
import { fetchNotes, notesQueryGet } from "@/features/notes/queries/notes"
import useNotesInflightStore, {
	setOutboxHydrated,
	clearEditingSessions,
	type InflightContent,
	type InflightEntry
} from "@/features/notes/store/useNotesInflight"
import {
	hashNoteContent,
	buildInflightEntries,
	mergeInflight,
	inflightContentSchema,
	noteKindForPreview,
	reconcileFollower,
	remoteEnqueueToPatch,
	newestEntry,
	type RemoteEnqueue,
	MAX_NON_RETRYABLE_REJECTIONS
} from "@/features/notes/lib/sync.logic"

const OUTBOX_KV_KEY = "inflightNoteContent"
// Held by every tab while it lives (released with the tab): whether the tab a push came from is still there
// to tell its user.
const TAB_LOCK_PREFIX = "filen-web-notes-tab:"

async function tabIsLive(tabId: string): Promise<boolean> {
	const snapshot = await navigator.locks.query()

	return snapshot.held?.some(lock => lock.name === `${TAB_LOCK_PREFIX}${tabId}`) === true
}

// The name a toast about the note uses.
function noteName(note: Note): string {
	return note.title !== undefined && note.title.length > 0 ? note.title : i18n.t("notes:noteUntitled")
}
const SYNC_DEBOUNCE_MS = 3000

// Multi-tab transport: a follower forwards edits to the leader and asks it to flush; the leader
// broadcasts authoritative state + a hello on takeover, and a terminal shutdown closes the channel. The
// seam is the shared one chats rides too — only the payload shapes differ; the wiring over a real
// BroadcastChannel lives in outboxCoordinator.ts and tests mock it. A single-tab install attaches NO
// transport, so every call below is a guarded no-op and the leader path stays byte-identical to the
// pre-multi-tab outbox.
export type NotesOutboxTransport = OutboxChannelTransport<RemoteEnqueue, InflightContent>

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
	// Per note, the hash of the content this tab last pushed. For an answer to the remote-edit dialog
	// (answeredNotes), the cloud still holding it is no newer work to warn about: a "Load theirs" queues
	// their content over a push of the local edits that landed after their save. For any other edit it is:
	// another tab's push is news to a tab that typed on the version before it.
	private readonly lastPushedHashes: Map<string, string> = new Map<string, string>()
	// Notes whose queued edit answers the remote-edit dialog, until it is pushed. A follower keeps its own
	// (and hears the leader's pushes into lastPushedHashes), so a promoted leader still knows them.
	private readonly answeredNotes: Set<string> = new Set<string>()
	// Per note, the last push that landed: its entry's origin, base and stamp, and the hash it landed as. A
	// follower's keystroke typed before it heard the push carries the pushed entry's base; ingested after
	// the prune, it is rebased here as the prune would have (only the same tab's: another tab's entry on
	// that base never saw the push, and its overwrite must still be told).
	private readonly landed = new Map<string, { origin: string | undefined; from: string; to: string; upTo: number }>()
	// This tab's id, the origin of every entry it queues: which push is this tab's own, exactly, whatever
	// else it or another tab typed meanwhile, in whichever millisecond.
	private readonly tabId: string = crypto.randomUUID()
	private releaseTabLock: (() => void) | null = null

	// Multi-tab state. `role` defaults to "leader" so a lone tab and every unit test are the unchanged
	// single-tab path. `transport` is null until the coordinator wires a channel (single-tab: stays null,
	// every broadcast/forward below is a no-op). `unacked` is FOLLOWER-only: the edits this tab has
	// applied optimistically + forwarded but the leader has not yet confirmed via a state broadcast —
	// they win the follower's merge (so the optimistic edit is never lost) and are re-sent on takeover.
	private role: OutboxRole = "leader"
	private transport: NotesOutboxTransport | null = null
	private unacked: InflightContent = {}

	public constructor() {
		this.initPromise = new Promise(resolve => {
			this.resolveInit = resolve
		})
	}

	// The coordinator reads this to route incoming channel messages by CURRENT role (role flips live on
	// promotion), so a single dispatcher stays correct across a takeover.
	public get outboxRole(): OutboxRole {
		return this.role
	}

	// Wire the multi-tab transport (coordinator only). Idempotent-friendly: a single-tab install never
	// calls this, leaving every forward/broadcast a guarded no-op.
	public attachTransport(transport: NotesOutboxTransport): void {
		this.transport = transport
	}

	// Replay-on-launch. Mounted once in the authed shell (SyncHost), never per route. Resolves the role
	// back to "leader" and re-arms a fresh signal: a terminal cancel() deliberately leaves the signal
	// aborted, so re-entering the shell without a reload must re-arm here or the loop stays gated.
	public start(): void {
		this.role = "leader"
		this.abortController = new AbortController()
		this.holdTabLock()

		void this.restoreFromDisk()
	}

	// TERMINAL shutdown — wired into the logout path BEFORE the local wipe. Flip out of leader so no
	// forwarded edit is ingested, cancel the armed debounce, abort the loop, and close the cross-tab
	// channel so no late peer message reaches a tearing-down tab. Deliberately NO fresh controller: the
	// signal must STAY aborted so a straggler flush can never re-write the queue after kv-clear lands.
	public cancel(): void {
		this.role = "shutdown"
		this.syncTimeout?.cancel()
		this.syncTimeout = null
		this.abortController.abort()
		this.transport?.close()
		this.releaseTabLock?.()
		this.releaseTabLock = null
		// The store no longer reflects any account's outbox — an editor still mounted through the teardown
		// must hold its loading state rather than seed from a wiped store, and no note is being edited
		// any more (a session surviving the wipe would gate the next account's content query).
		setOutboxHydrated(false)
		clearEditingSessions()
		forgetNotePushes()
		forgetTabEditors()
		releaseAllNoteHolds()
		this.lastPushedHashes.clear()
		this.answeredNotes.clear()
		this.landed.clear()
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
		// A follower's store only mirrors the leader's queue: the leader must drop it, or it pushes it.
		if (this.role === "follower") {
			const unacked = { ...this.unacked }

			Reflect.deleteProperty(unacked, noteUuid)
			this.unacked = unacked
			this.transport?.sendDrop?.(noteUuid)
		}

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

	// LEADER: a follower dropped the note's queued edits (a history restore, a reload of theirs there).
	public ingestDrop(noteUuid: string): void {
		if (this.role !== "leader" || isAborted(this.abortController.signal)) {
			return
		}

		this.dropEntry(noteUuid)
		void this.flushToDisk(useNotesInflightStore.getState().inflightContent).then(() => {
			this.broadcastState()
		})
	}

	private holdTabLock(): void {
		if (this.releaseTabLock !== null) {
			return
		}

		const held = new Promise<void>(resolve => {
			this.releaseTabLock = resolve
		})

		void navigator.locks.request(`${TAB_LOCK_PREFIX}${this.tabId}`, () => held)
	}

	// Edit intake. Writes the outbox entry AND persists the WHOLE outbox to disk IMMEDIATELY, before
	// arming the debounce — the immediate-persist is THE survives-window-close guarantee (if the tab
	// dies during the 3s debounce, the edit is already durable and replays on next launch). Returns
	// the persist result so the editor can surface a failed disk write (an edit that survives in
	// memory only). `sessionBaseHash` is the hash of the editor's mount seed for a FRESH session;
	// omitting it takes the legacy no-conflict-check grace (see buildInflightEntries).
	public enqueue(note: Note, content: string, sessionBaseHash?: string | null): Promise<boolean> {
		return this.enqueueEdit(note, content, sessionBaseHash ?? null, false)
	}

	// The remote-edit dialog's answer: `content` over their version (hashed `theirsHash`), the user's choice,
	// so the push warns of no overwrite of this browser's own earlier push either.
	public enqueueAnswer(note: Note, content: string, theirsHash: string | null): Promise<boolean> {
		return this.enqueueEdit(note, content, theirsHash, true)
	}

	private enqueueEdit(note: Note, content: string, sessionBaseHash: string | null, answer: boolean): Promise<boolean> {
		if (this.role === "follower") {
			return this.followerEnqueue(note, content, sessionBaseHash, answer)
		}

		if (answer) {
			this.answeredNotes.add(note.uuid)
		}

		const entries = this.buildOwnEntries(note, content, sessionBaseHash)

		useNotesInflightStore.getState().setInflightContent(prev => ({
			...prev,
			[note.uuid]: entries
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
	private followerEnqueue(note: Note, content: string, sessionBaseHash: string | null, answer: boolean): Promise<boolean> {
		const entries = this.buildOwnEntries(note, content, sessionBaseHash)

		useNotesInflightStore.getState().setInflightContent(prev => ({
			...prev,
			[note.uuid]: entries
		}))

		this.unacked = {
			...this.unacked,
			[note.uuid]: entries
		}

		if (answer) {
			this.answeredNotes.add(note.uuid)
		}

		const latest = newestEntry(entries)

		if (latest !== undefined) {
			this.transport?.sendEnqueue(this.toRemoteEnqueue(latest))
		}

		return Promise.resolve(true)
	}

	// The note's entries after a keystroke of this tab's, the new one tagged with this tab's id.
	private buildOwnEntries(note: Note, content: string, sessionBaseHash: string | null): InflightEntry[] {
		const entries: InflightEntry[] = buildInflightEntries({
			previous: useNotesInflightStore.getState().inflightContent[note.uuid],
			note,
			content,
			now: Date.now(),
			sessionBaseHash
		})
		const own = newestEntry(entries)
		const previous = newestEntry(useNotesInflightStore.getState().inflightContent[note.uuid] ?? [])
		const tag: Pick<InflightEntry, "origin" | "carried"> =
			previous?.origin === this.tabId ? { origin: this.tabId, carried: true } : { origin: this.tabId }

		return entries.map(entry => (entry === own ? { ...entry, ...tag } : entry))
	}

	// exactOptionalPropertyTypes: omit the optional keys entirely when unset.
	private toRemoteEnqueue(entry: InflightEntry): RemoteEnqueue {
		const msg: RemoteEnqueue = { note: entry.note, content: entry.content, timestamp: entry.timestamp }

		if (entry.baseContentHash !== undefined) {
			msg.baseContentHash = entry.baseContentHash
		}

		if (entry.origin !== undefined) {
			msg.origin = entry.origin
		}

		if (entry.carried !== undefined) {
			msg.carried = entry.carried
		}

		if (this.answeredNotes.has(entry.note.uuid)) {
			msg.answer = true
		}

		return msg
	}

	// ANY ROLE: the leader announced a push of `hash` for the note, queued by the tab `origin`. Kept as this
	// note's last push, and told to this tab's editor when the entry was this tab's own.
	public heardPush(noteUuid: string, hash: string, origin: string | undefined): void {
		this.lastPushedHashes.set(noteUuid, hash)

		if (origin === this.tabId) {
			tabEditorPushed(noteUuid, hash)
		}
	}

	// ANY ROLE: the cloud holds `hash` for the note, pushed (or found there) by the leader from the entry
	// `detail.stamp` of the tab `detail.origin`. When that tab is this one: its text is synced, echo or not,
	// its content cache follows it (no editor needed, no read: this tab has the text), its entries typed on
	// top of it build on it (the leader's prune rebased its copies the same way), and an overwrite it made
	// is told here.
	public heardLanded(noteUuid: string, hash: string, detail: PushDetail): void {
		this.lastPushedHashes.set(noteUuid, hash)

		if (detail.origin !== this.tabId) {
			return
		}

		const stamp = detail.stamp ?? Number.POSITIVE_INFINITY
		const find = (entries: InflightEntry[] | undefined): InflightEntry | undefined =>
			entries?.find(entry => entry.origin === this.tabId && entry.timestamp === stamp)
		const pushed = find(this.unacked[noteUuid]) ?? find(useNotesInflightStore.getState().inflightContent[noteUuid])

		if (pushed !== undefined) {
			followContent(noteUuid, pushed.content)
		}

		tabEditorLanded(noteUuid, hash, pushed?.content)

		const rebase = (entries: InflightEntry[] | undefined): InflightEntry[] | undefined =>
			entries?.map(entry =>
				entry.origin === this.tabId && entry.carried === true && entry.timestamp > stamp
					? { ...entry, baseContentHash: hash }
					: entry
			)
		const unacked = rebase(this.unacked[noteUuid])

		if (unacked !== undefined) {
			this.unacked = { ...this.unacked, [noteUuid]: unacked }
		}

		useNotesInflightStore.getState().setInflightContent(prev => {
			const entries = rebase(prev[noteUuid])

			return entries === undefined ? prev : { ...prev, [noteUuid]: entries }
		})

		if (detail.overwrote === true) {
			const note = notesQueryGet()?.find(n => n.uuid === noteUuid) ?? pushed?.note

			toast(
				i18n.t("notes:noteOverwroteNewerRemoteChanges", {
					name: note === undefined ? i18n.t("notes:noteUntitled") : noteName(note)
				})
			)
		}
	}

	// LEADER: ingest an edit a follower forwarded. Merge it by its (follower-local) timestamp —
	// last-enqueue-wins per note, reusing mergeInflight — then persist and arm the debounce exactly like
	// a local enqueue, and broadcast the new authoritative state once it is durable. Two tabs editing the
	// same note collapse to the newest timestamp here; content is never merged (out of scope).
	public ingestRemoteEnqueue(msg: RemoteEnqueue): void {
		if (this.role !== "leader") {
			return
		}

		// A terminal shutdown aborts the loop then wipes kv; ingesting after that would re-queue and
		// re-persist an edit onto a wiping tab. Never ingest once aborted.
		if (isAborted(this.abortController.signal)) {
			return
		}

		if (msg.answer === true) {
			this.answeredNotes.add(msg.note.uuid)
		}

		// Only a keystroke typed on that tab's own previous entry carries the pushed entry's base; a fresh
		// session on the same text (a stale seed, a history restore) is news to the push, and stays so.
		const landed = this.landed.get(msg.note.uuid)
		const rebased =
			landed !== undefined &&
			msg.carried === true &&
			msg.origin !== undefined &&
			msg.origin === landed.origin &&
			msg.baseContentHash === landed.from &&
			msg.timestamp > landed.upTo
				? { ...msg, baseContentHash: landed.to }
				: msg

		useNotesInflightStore.getState().setInflightContent(prev => mergeInflight(prev, remoteEnqueueToPatch(rebased)))

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

		// A drained note's answer went out with it.
		for (const noteUuid of [...this.answeredNotes]) {
			if ((reconciled.store[noteUuid] ?? []).length === 0) {
				this.answeredNotes.delete(noteUuid)
			}
		}

		// A follower owns no disk: the leader's first broadcast IS its hydration, and any content read a
		// note in that state has in flight would land on top of the edit it just learned about.
		this.markHydrated(Object.keys(reconciled.store))
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
	// tab already has pending shows its inflight (editor gate, spinner) here too. Never touches disk and
	// never runs the loop — the leader owns both.
	public startAsFollower(): void {
		this.role = "follower"
		this.holdTabLock()

		if (this.transport === null) {
			// No channel attached: nobody can ever answer, so this tab is as hydrated as it will get —
			// never leave the editor waiting on a broadcast that cannot arrive.
			this.markHydrated([])

			return
		}

		this.transport.requestState()
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

	// Durable outbox via the kv adapter. Reports persistence failure as `false` instead
	// of throwing (it never throws). Sync-internal callers ignore the return (the next pass
	// re-flushes); the enqueue call site surfaces a `false`.
	public async flushToDisk(inflightContent: InflightContent): Promise<boolean> {
		// Defense-in-depth at the disk boundary: the callers' own abort guards are the first line, this
		// refuses to persist at all once a terminal shutdown has landed.
		if (isAborted(this.abortController.signal)) {
			return false
		}

		// Only the leader owns the durable outbox; a follower's store is a mirror, nothing of it to keep.
		if (this.role === "follower") {
			return true
		}

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

	// The hydration edge the editor waits on: the store now reflects this tab's authoritative pending
	// work, so a seed taken from it is truthful. Any content read still in flight for one of these notes
	// was issued while the store looked clean — it would land on top of the restored draft and remount
	// the editor onto server content, so it is cancelled here (notesQueryUpdate's cancel-before-patch
	// discipline). A note with no cached content simply refetches once its outbox entry drains. Only the
	// FIRST hydration can have raced such a read (from then on the store itself keeps the query
	// disabled), so later calls — the leader's own tail, a follower's every subsequent broadcast — only
	// re-assert the flag.
	private markHydrated(pendingNoteUuids: string[]): void {
		if (!useNotesInflightStore.getState().outboxHydrated) {
			for (const noteUuid of pendingNoteUuids) {
				void queryClient.cancelQueries({ queryKey: noteContentQueryKey(noteUuid), exact: true })
			}
		}

		setOutboxHydrated(true)
	}

	// The ONLY disk→store bridge, so it MUST hydrate the store even with no network.
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
			// The store is truthful now — release the editor's gate BEFORE the (network) reconcile below,
			// which must never hold an editor's first paint hostage.
			this.markHydrated(Object.keys(fromDisk))

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

				// Drop a disk-seeded entry already synced with the cloud or orphaned (note gone) — see
				// notesOutboxReconcile.ts for the full rule. The web list query carries no content, so cloud
				// content is fetched per inflight note.
				const cloudContentByUuid = new Map<string, string>()

				for (const noteUuid of Object.keys(fromDisk)) {
					const cloudNote = cloudByUuid.get(noteUuid)

					if (!cloudNote) {
						continue
					}

					const cloudContent = await readNoteContent(cloudNote)

					if (cloudContent.status === "ok") {
						cloudContentByUuid.set(noteUuid, cloudContent.content)
					}
				}

				// Applied as a functional update so any edit made during the fetch is preserved.
				useNotesInflightStore
					.getState()
					.setInflightContent(prev =>
						reconcileNoteOutboxAgainstCloud(prev, Object.keys(fromDisk), new Set(cloudByUuid.keys()), cloudContentByUuid)
					)
			})

			if (!reconcile.success) {
				log.warn("notes-sync", "cloud reconcile after restore failed; stale inflight entries may persist", reconcile.error)
			}

			return true
		})

		if (!result.success) {
			log.error("notes-sync", "restoreFromDisk failed; unsaved edits from previous session may be lost", result.error)
		}

		// Covers the paths the hydrate above never reached: an empty disk, and a failed read — neither
		// leaves pending work to protect, and neither may hold the editor's gate closed.
		this.markHydrated([])
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
			// Notes whose remote-edit dialog is open in some tab keep their entries until it is answered.
			const held = await heldNotes()

			// SINGLE-TAB SEAM: this loop is not yet gated behind the leader election used elsewhere in this
			// class (broadcastState/followerEnqueue) — that gating (only the elected tab flushes) is future
			// work. Today every authed tab runs its own loop.
			const results = await Promise.allSettled(
				Object.entries(inflightContent).map(async ([noteUuid, contents]) => {
					if (isAborted(signal)) {
						return
					}

					if (contents.length === 0 || held.has(noteUuid)) {
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
					const own = mostRecentContent.origin === this.tabId

					// Conflict DETECTION, never prevention — local edits always win and the push is
					// unconditional. When the entry carries its session base hash, peek at the note's
					// current cloud content: if the cloud moved past our base AND past what we are about
					// to write, this push buries newer remote work and the user hears about it once.
					// Entries without a base hash push unchecked (legacy grace); a failed or undecryptable
					// peek also pushes unchecked (availability beats the toast).
					let overwritesNewerRemoteContent = false
					// The peek found the content already in the cloud: nothing to send.
					let alreadyInCloud = false

					if (mostRecentContent.baseContentHash !== undefined) {
						const peek = await run(async () => readNoteContent(liveNote))

						if (peek.success && peek.data.status === "ok") {
							const remote = peek.data.content
							const remoteHash = hashNoteContent(remote)

							alreadyInCloud = remote === mostRecentContent.content
							overwritesNewerRemoteContent =
								!alreadyInCloud &&
								remoteHash !== mostRecentContent.baseContentHash &&
								!(this.answeredNotes.has(noteUuid) && remoteHash === this.lastPushedHashes.get(noteUuid))
						} else {
							log.warn(
								"notes-sync",
								"conflict-detection peek unavailable; pushing without overwrite check",
								noteUuid,
								peek.success ? "undecryptable" : peek.error
							)
						}
					}

					// Recorded before the push goes out, in every tab: its socket echo can beat the response back,
					// and must never read as an edit made elsewhere (pushEchoes.ts).
					const pushedContentHash = hashNoteContent(mostRecentContent.content)

					if (!alreadyInCloud) {
						rememberNotePush(noteUuid, pushedContentHash)
						this.transport?.broadcastPushed(
							noteUuid,
							pushedContentHash,
							mostRecentContent.origin === undefined
								? { stamp: syncedUpTo }
								: { origin: mostRecentContent.origin, stamp: syncedUpTo }
						)

						if (own) {
							tabEditorPushed(noteUuid, pushedContentHash)
						}
					}

					const push = alreadyInCloud
						? ({ success: true } as const)
						: await run(async () => {
								const preview = createNotePreviewFromContentText(
									noteKindForPreview(liveNote.noteType),
									mostRecentContent.content
								)

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
						const dto = asErrorDTO(e)

						if (
							!isPermanentRejection({
								hasSdkError: dto.species === "sdk",
								kind: dto.species === "sdk" ? dto.kind : undefined
							})
						) {
							throw e
						}

						const rejections = (this.nonRetryableRejections.get(noteUuid) ?? 0) + 1

						if (rejections < MAX_NON_RETRYABLE_REJECTIONS) {
							this.nonRetryableRejections.set(noteUuid, rejections)

							log.warn("notes-sync", "non-retryable SDK rejection on setNoteContent; will retry", noteUuid, rejections, e)

							throw e
						}

						this.nonRetryableRejections.delete(noteUuid)
						this.answeredNotes.delete(noteUuid)

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
					this.lastPushedHashes.set(noteUuid, pushedContentHash)
					this.answeredNotes.delete(noteUuid)

					if (mostRecentContent.baseContentHash !== undefined) {
						this.landed.set(noteUuid, {
							origin: mostRecentContent.origin,
							from: mostRecentContent.baseContentHash,
							to: pushedContentHash,
							upTo: syncedUpTo
						})
					}

					// This tab's text is in the cloud now, and not before: a push the outbox gives up on
					// leaves it unsaved on screen. The other tabs hear it too, also when nothing was sent.
					if (own) {
						tabEditorLanded(noteUuid, pushedContentHash, mostRecentContent.content)
					}

					// An overwrite is told by the tab whose typing was pushed, or here when that is this tab,
					// an earlier page load's (a restored draft), or a tab since closed. Once per note per
					// pass, and never for an aborted pass (logout stays silent).
					const overwrote = overwritesNewerRemoteContent && !isAborted(signal) && !toastedConflicts.has(noteUuid)
					const authorTells =
						overwrote && mostRecentContent.origin !== undefined && mostRecentContent.origin !== this.tabId
							? await tabIsLive(mostRecentContent.origin)
							: false

					if (overwrote) {
						toastedConflicts.add(noteUuid)
					}

					const detail: PushDetail = { stamp: syncedUpTo, landed: true }

					if (mostRecentContent.origin !== undefined) {
						detail.origin = mostRecentContent.origin
					}

					if (authorTells) {
						detail.overwrote = true
					}

					this.transport?.broadcastPushed(noteUuid, pushedContentHash, detail)

					// The pushed content IS the cloud content now — write it into the per-note content
					// query cache so an editor reseed after the queue drains paints what the user typed,
					// never the stale pre-edit cache. dataUpdatedAt is PRESERVED so the editor's remount
					// key (this timestamp) does not advance and reset the cursor after every push.
					const contentKey = noteContentQueryKey(noteUuid)

					// Cancel-before-patch, like every drive listing patch: a content read snapshotted BEFORE
					// this push would otherwise land after it, overwrite the pushed content with pre-edit
					// bytes AND advance dataUpdatedAt, remounting the editor onto the stale text.
					void queryClient.cancelQueries({ queryKey: contentKey, exact: true })

					const previousUpdatedAt = queryClient.getQueryState<string | undefined>(contentKey)?.dataUpdatedAt

					queryClient.setQueryData<string>(
						contentKey,
						mostRecentContent.content,
						previousUpdatedAt !== undefined ? { updatedAt: previousUpdatedAt } : undefined
					)

					// The content we just pushed IS the cloud content now, so it becomes the base for
					// every entry typed during the round trip (they survive the prune). Without this the
					// next pass would flag our OWN push as a conflict against their stale session base.
					useNotesInflightStore.getState().setInflightContent(prev => {
						const updated: InflightContent = {
							...prev
						}

						// Only the pushing tab's own continuations were typed on the push; another tab's never saw it.
						const remaining = pruneAndRebaseNoteOutboxAfterPush(
							updated[noteUuid],
							syncedUpTo,
							pushedContentHash,
							entry => entry.origin === mostRecentContent.origin && entry.carried === true
						)

						if (remaining === undefined) {
							Reflect.deleteProperty(updated, noteUuid)
						} else {
							updated[noteUuid] = remaining
						}

						return updated
					})

					// Only AFTER the push landed: a failed push overwrites nothing and is retried.
					if (overwrote && !authorTells) {
						toast(i18n.t("notes:noteOverwroteNewerRemoteChanges", { name: noteName(liveNote) }))
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
